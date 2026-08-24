import { randomUUID } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  missingRequiredEvidenceKinds,
  runtimeEvidenceKindSchema,
  runtimeFailureClassSchema,
  runtimeTraceEventSchema,
  runtimeTaskSnapshotSchema,
  type RuntimeEvidenceRef,
  type RuntimeTaskClaimInput,
  type RuntimeTaskOutcomeInput,
} from "@devproof/agent-runtime-protocol";
import {
  effectiveRetryPolicy,
  projectRuntimeOutcome,
} from "@devproof/test-domain";
import {
  runDeadlinePolicySchema,
  runHitlPolicySchema,
} from "@devproof/contracts";
import { z } from "zod";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";

const retryPolicySchema = z.object({
  browser: z
    .object({
      availabilityPolicy: z.enum(["WAIT", "FAIL_FAST"]),
    })
    .optional(),
  retryPolicy: z.object({
    maxAttempts: z.number().int().min(1).max(10),
    retryOn: z.array(runtimeFailureClassSchema).max(7),
  }),
  deadline: runDeadlinePolicySchema.default({ mode: "FIXED" }),
  hitl: runHitlPolicySchema.default({
    enabled: true,
    notificationChannels: ["FEISHU"],
    onTimeout: "INCONCLUSIVE",
    timeoutSeconds: 3600,
  }),
});

type RunDeadlinePolicy = z.infer<typeof runDeadlinePolicySchema>;

interface AdaptiveDeadlineState {
  activeOperation: string | null;
  activeOperationKey: string | null;
  activeOperationStartedAtMs: number | null;
  deadlineAtMs: number;
  hardDeadlineAtMs: number;
  lastDeadlineExtensionOperationKey: string | null;
  lastModelCompletedAtMs: number | null;
  lastModelLatencyMs: number | null;
  lastModelOperationKey: string | null;
  modelLatencyEwmaMs: number | null;
  nowMs: number;
  policy: RunDeadlinePolicy;
}

export interface AdaptiveDeadlineExtension {
  activeModelElapsedMs: number;
  deadlineAtMs: number;
  extendedByMs: number;
  observedModelLatencyMs: number;
  operationKey: string;
  reserveMs: number;
  trigger: "ACTIVE_SLOW_MODEL" | "RECENT_MODEL_PROGRESS";
}

export function decideAdaptiveDeadlineExtension(
  state: AdaptiveDeadlineState,
): AdaptiveDeadlineExtension | null {
  if (state.policy.mode !== "ADAPTIVE") return null;
  if (
    state.deadlineAtMs <= state.nowMs ||
    state.deadlineAtMs >= state.hardDeadlineAtMs
  ) {
    return null;
  }

  const slowThresholdMs = state.policy.slowModelThresholdSeconds * 1_000;
  const activeModelElapsedMs =
    state.activeOperation === "MODEL" &&
    state.activeOperationStartedAtMs !== null
      ? Math.max(0, state.nowMs - state.activeOperationStartedAtMs)
      : 0;
  const activeModelIsSlow =
    activeModelElapsedMs >= slowThresholdMs &&
    Boolean(state.activeOperationKey);
  const completedModelIsRecent =
    state.lastModelCompletedAtMs !== null &&
    state.nowMs - state.lastModelCompletedAtMs <=
      Math.max(300_000, slowThresholdMs * 4);
  const completedModelHasProgress =
    completedModelIsRecent &&
    state.lastModelLatencyMs !== null &&
    Boolean(state.lastModelOperationKey);
  const operationKey = activeModelIsSlow
    ? state.activeOperationKey
    : completedModelHasProgress
      ? state.lastModelOperationKey
      : null;
  const trigger = activeModelIsSlow
    ? "ACTIVE_SLOW_MODEL"
    : "RECENT_MODEL_PROGRESS";
  if (
    !operationKey ||
    operationKey === state.lastDeadlineExtensionOperationKey
  ) {
    return null;
  }

  const observedModelLatencyMs = Math.max(
    slowThresholdMs,
    activeModelElapsedMs,
    state.lastModelLatencyMs ?? 0,
    state.modelLatencyEwmaMs ?? 0,
  );
  const reserveMs = clamp(
    Math.round(observedModelLatencyMs * 1.5) +
      state.policy.finalizationReserveSeconds * 1_000,
    120_000,
    300_000,
  );
  if (state.deadlineAtMs - state.nowMs > reserveMs) return null;

  const requestedDeadlineAtMs = Math.max(
    state.deadlineAtMs + state.policy.extensionStepSeconds * 1_000,
    state.nowMs + reserveMs,
  );
  const deadlineAtMs = Math.min(requestedDeadlineAtMs, state.hardDeadlineAtMs);
  if (deadlineAtMs <= state.deadlineAtMs) return null;
  return {
    activeModelElapsedMs,
    deadlineAtMs,
    extendedByMs: deadlineAtMs - state.deadlineAtMs,
    observedModelLatencyMs,
    operationKey,
    reserveMs,
    trigger,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function leaseExpiry(now: Date) {
  return new Date(
    now.getTime() + env().AGENT_RUNTIME_TASK_LEASE_SECONDS * 1_000,
  );
}

@Injectable()
export class AgentRuntimeTaskService {
  constructor(private readonly prisma: PrismaService) {}

  async claim(teamId: string, input: RuntimeTaskClaimInput) {
    for (let collision = 0; collision < 5; collision += 1) {
      const claimed = await this.prisma.$transaction(
        async (tx) => {
          const now = new Date();
          const candidate = await tx.agentRuntimeTask.findFirst({
            orderBy: { createdAt: "asc" },
            where: {
              capability: { in: input.capabilities },
              deadlineAt: { gt: now },
              run: {
                cancelRequestedAt: null,
                lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
                teamId,
              },
              OR: [
                { status: "PENDING" },
                {
                  leaseExpiresAt: { lt: now },
                  status: "RUNNING",
                },
              ],
            },
          });
          if (!candidate) return null;

          const leaseToken = randomUUID();
          const leaseExpiresAt = leaseExpiry(now);
          const acquired = await tx.agentRuntimeTask.updateMany({
            data: {
              fencingToken: { increment: 1 },
              lastHeartbeatAt: now,
              leaseExpiresAt,
              leaseOwner: input.workerId,
              leaseToken,
              startedAt: candidate.startedAt ?? now,
              status: "RUNNING",
            },
            where: {
              id: candidate.id,
              OR: [
                { status: "PENDING" },
                {
                  leaseExpiresAt: { lt: now },
                  status: "RUNNING",
                },
              ],
            },
          });
          if (acquired.count !== 1) return undefined;

          const task = await tx.agentRuntimeTask.findUniqueOrThrow({
            include: { run: true },
            where: { id: candidate.id },
          });
          await tx.runAttempt.update({
            data: { startedAt: now, status: "RUNNING" },
            where: { id: task.attemptId },
          });
          await tx.executionRun.update({
            data: {
              lifecycle: "RUNNING",
              startedAt: task.run.startedAt ?? now,
            },
            where: { id: task.runId },
          });
          await tx.runEvent.create({
            data: {
              actor: "AGENT_RUNTIME",
              attemptId: task.attemptId,
              kind: "runtime.task.claimed",
              payload: json({
                fencingToken: task.fencingToken.toString(),
                workerId: input.workerId,
              }),
              runId: task.runId,
              taskId: task.id,
              teamId,
            },
          });
          return task;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );

      if (claimed === undefined) continue;
      if (claimed === null) return { task: null };

      return {
        task: {
          fencingToken: claimed.fencingToken.toString(),
          leaseExpiresAt: claimed.leaseExpiresAt?.toISOString(),
          leaseToken: claimed.leaseToken,
          snapshot: runtimeTaskSnapshotSchema.parse(claimed.snapshot),
          taskId: claimed.id,
        },
      };
    }
    return { task: null };
  }

  async heartbeat(
    teamId: string,
    taskId: string,
    input: { fencingToken: string; leaseToken: string; workerId: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const task = await this.findTask(tx, teamId, taskId);
      this.requireLease(task, input);
      const now = new Date();
      const cancelled =
        task.cancelRequestedAt !== null ||
        task.run.cancelRequestedAt !== null ||
        task.run.deadlineAt <= now ||
        ["CANCELLED", "TIMED_OUT"].includes(task.run.lifecycle) ||
        task.status === "CANCELLED" ||
        task.status === "TIMED_OUT";
      if (cancelled) {
        return {
          deadlineAt: task.run.deadlineAt.toISOString(),
          directive: "CANCEL" as const,
          hardDeadlineAt: task.run.hardDeadlineAt.toISOString(),
          leaseExpiresAt: (task.leaseExpiresAt ?? now).toISOString(),
        };
      }
      if (!(["RUNNING", "WAITING_HUMAN"] as string[]).includes(task.status)) {
        throw new ConflictException("The Runtime task is already terminal.");
      }

      const leaseExpiresAt = leaseExpiry(now);
      const policy = retryPolicySchema.parse(task.run.executionPolicy).deadline;
      const extension = decideAdaptiveDeadlineExtension({
        activeOperation: task.activeOperation,
        activeOperationKey: task.activeOperationKey,
        activeOperationStartedAtMs:
          task.activeOperationStartedAt?.getTime() ?? null,
        deadlineAtMs: task.run.deadlineAt.getTime(),
        hardDeadlineAtMs: task.run.hardDeadlineAt.getTime(),
        lastDeadlineExtensionOperationKey:
          task.lastDeadlineExtensionOperationKey,
        lastModelCompletedAtMs: task.lastModelCompletedAt?.getTime() ?? null,
        lastModelLatencyMs: task.lastModelLatencyMs,
        lastModelOperationKey: task.lastModelOperationKey,
        modelLatencyEwmaMs: task.modelLatencyEwmaMs,
        nowMs: now.getTime(),
        policy,
      });
      let deadlineAt = task.run.deadlineAt;
      let hardDeadlineAt = task.run.hardDeadlineAt;
      let acceptedExtension: AdaptiveDeadlineExtension | null = null;
      if (extension) {
        const nextDeadlineAt = new Date(extension.deadlineAtMs);
        const changed = await tx.executionRun.updateMany({
          data: {
            deadlineAt: nextDeadlineAt,
            deadlineExtendedMs: { increment: extension.extendedByMs },
            deadlineExtensionCount: { increment: 1 },
          },
          where: {
            deadlineAt: task.run.deadlineAt,
            hardDeadlineAt: { gte: nextDeadlineAt },
            id: task.runId,
            lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
          },
        });
        if (changed.count === 1) {
          const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
          const extendedSnapshot = runtimeTaskSnapshotSchema.parse({
            ...snapshot,
            deadlineAt: nextDeadlineAt.toISOString(),
            hardDeadlineAt: task.run.hardDeadlineAt.toISOString(),
          });
          await tx.agentRuntimeTask.update({
            data: {
              deadlineAt: nextDeadlineAt,
              lastDeadlineExtensionOperationKey: extension.operationKey,
              lastHeartbeatAt: now,
              leaseExpiresAt,
              snapshot: json(extendedSnapshot),
            },
            where: { id: task.id },
          });
          await this.extendBrowserLeases(tx, task.attemptId, nextDeadlineAt);
          await tx.runEvent.create({
            data: {
              actor: "CONTROL_PLANE",
              attemptId: task.attemptId,
              kind: "run.deadline.extended",
              payload: json({
                activeModelElapsedMs: extension.activeModelElapsedMs,
                extendedByMs: extension.extendedByMs,
                newDeadlineAt: nextDeadlineAt.toISOString(),
                observedModelLatencyMs: extension.observedModelLatencyMs,
                oldDeadlineAt: task.run.deadlineAt.toISOString(),
                operationKey: extension.operationKey,
                reason: "SLOW_MODEL",
                reserveMs: extension.reserveMs,
                trigger: extension.trigger,
              }),
              runId: task.runId,
              taskId: task.id,
              teamId,
            },
          });
          deadlineAt = nextDeadlineAt;
          acceptedExtension = extension;
        } else {
          const currentRun = await tx.executionRun.findUniqueOrThrow({
            select: {
              cancelRequestedAt: true,
              deadlineAt: true,
              hardDeadlineAt: true,
              lifecycle: true,
            },
            where: { id: task.runId },
          });
          deadlineAt = currentRun.deadlineAt;
          hardDeadlineAt = currentRun.hardDeadlineAt;
          if (
            currentRun.cancelRequestedAt ||
            currentRun.deadlineAt <= now ||
            ["CANCELLED", "TIMED_OUT"].includes(currentRun.lifecycle)
          ) {
            return {
              deadlineAt: deadlineAt.toISOString(),
              directive: "CANCEL" as const,
              hardDeadlineAt: hardDeadlineAt.toISOString(),
              leaseExpiresAt: (task.leaseExpiresAt ?? now).toISOString(),
            };
          }
        }
      }
      if (!acceptedExtension) {
        await tx.agentRuntimeTask.update({
          data: { lastHeartbeatAt: now, leaseExpiresAt },
          where: { id: task.id },
        });
      }
      return {
        deadlineAt: deadlineAt.toISOString(),
        directive: "CONTINUE" as const,
        hardDeadlineAt: hardDeadlineAt.toISOString(),
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        ...(acceptedExtension
          ? {
              extension: {
                extendedByMs: acceptedExtension.extendedByMs,
                reason: "SLOW_MODEL" as const,
              },
            }
          : {}),
      };
    });
  }

  async appendEvent(
    teamId: string,
    taskId: string,
    input: {
      event: {
        eventId: string;
        kind: string;
        occurredAt: string;
        payload: Record<string, unknown>;
      };
      fencingToken: string;
      leaseToken: string;
      workerId: string;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const task = await this.findTask(tx, teamId, taskId);
      this.requireLease(task, input);
      try {
        const event = await tx.runEvent.create({
          data: {
            actor: "AGENT_RUNTIME",
            attemptId: task.attemptId,
            id: input.event.eventId,
            kind: input.event.kind,
            occurredAt: new Date(input.event.occurredAt),
            payload: json(input.event.payload),
            runId: task.runId,
            taskId,
            teamId,
          },
        });
        const traceEvent = runtimeTraceEventSchema.safeParse({
          kind: input.event.kind,
          payload: input.event.payload,
        });
        if (traceEvent.success) {
          await this.recordRuntimeProgress(
            tx,
            task,
            traceEvent.data,
            event.createdAt,
          );
        }
        return { accepted: true, sequence: event.sequence.toString() };
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
        const event = await tx.runEvent.findUnique({
          where: { id: input.event.eventId },
        });
        if (!event || event.taskId !== taskId) throw error;
        return { accepted: true, sequence: event.sequence.toString() };
      }
    });
  }

  async submitOutcome(
    teamId: string,
    taskId: string,
    input: RuntimeTaskOutcomeInput,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const task = await this.findTask(tx, teamId, taskId);
        if (task.completionId) {
          if (task.completionId !== input.completionId) {
            throw new ConflictException(
              "The Runtime task already accepted a different completion.",
            );
          }
          return {
            accepted: true,
            attemptNumber: task.attempt.number,
            lifecycle: task.run.lifecycle,
            nextAttemptScheduled:
              task.run.currentAttemptNumber > task.attempt.number,
            taskStatus: normalizeAcknowledgedTaskStatus(task.status),
          };
        }
        this.requireLease(task, input);
        if (!(["RUNNING", "WAITING_HUMAN"] as string[]).includes(task.status)) {
          throw new ConflictException("The Runtime task is already terminal.");
        }
        if (
          task.run.cancelRequestedAt ||
          ["CANCELLED", "TIMED_OUT"].includes(task.run.lifecycle)
        ) {
          throw new ConflictException("The run no longer accepts outcomes.");
        }

        if (input.outcome.kind === "VERIFICATION_COMPLETED") {
          const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
          const persisted = await tx.runEvidence.findMany({
            select: {
              externalId: true,
              kind: true,
              label: true,
              metadata: true,
            },
            where: { attemptId: task.attemptId },
          });
          const validationError = completedOutcomeEvidenceError(
            snapshot,
            input.outcome,
            persisted,
          );
          if (validationError) throw new ConflictException(validationError);
        }

        const policy = retryPolicySchema.parse(task.run.executionPolicy);
        const projection = projectRuntimeOutcome({
          attemptNumber: task.attempt.number,
          outcome: input.outcome,
          retryPolicy: effectiveRetryPolicy({
            ...(policy.browser
              ? {
                  browserAvailabilityPolicy: policy.browser.availabilityPolicy,
                }
              : {}),
            outcome: input.outcome,
            retryPolicy: policy.retryPolicy,
          }),
        });
        const completedAt = new Date(input.completedAt);
        const isWaiting = input.outcome.kind === "WAITING_HUMAN";
        let pausedDeadlineAt: Date | null = null;
        const isFailure =
          input.outcome.kind === "RETRYABLE_FAILURE" ||
          input.outcome.kind === "FATAL_FAILURE";
        const runtimeError =
          input.outcome.kind === "RETRYABLE_FAILURE" ||
          input.outcome.kind === "FATAL_FAILURE"
            ? input.outcome.error
            : null;

        await tx.agentRuntimeTask.update({
          data: {
            completionId: input.completionId,
            error: runtimeError ? json(runtimeError) : Prisma.JsonNull,
            finishedAt: isWaiting ? null : completedAt,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            result: json(input.outcome),
            status: projection.taskStatus,
          },
          where: { id: task.id },
        });
        await tx.runAttempt.update({
          data: {
            error: runtimeError ? json(runtimeError) : Prisma.JsonNull,
            failureClass: runtimeError ? runtimeError.failureClass : null,
            finishedAt: isWaiting ? null : completedAt,
            result: json(input.outcome),
            status: projection.attemptStatus,
          },
          where: { id: task.attemptId },
        });

        if (input.outcome.kind === "VERIFICATION_COMPLETED") {
          await tx.runCriterionResult.createMany({
            data: input.outcome.criteria.map((criterion) => ({
              attemptId: task.attemptId,
              criterionId: criterion.criterionId,
              evidenceRefs: criterion.evidenceRefs,
              runId: task.runId,
              status: criterion.status,
              summary: criterion.summary,
              teamId,
            })),
          });
          if (input.outcome.evidence.length > 0) {
            await tx.runEvidence.createMany({
              data: input.outcome.evidence.map((evidence) => ({
                attemptId: task.attemptId,
                externalId: evidence.externalId,
                kind: evidence.kind,
                label: evidence.label,
                metadata: json(evidence.metadata),
                runId: task.runId,
                teamId,
              })),
              skipDuplicates: true,
            });
          }
        }

        if (input.outcome.kind === "WAITING_HUMAN") {
          if (!policy.hitl.enabled) {
            throw new ConflictException("HITL is disabled for this Run.");
          }
          const requestedAt = new Date();
          const refundHumanWait =
            policy.deadline.mode === "ADAPTIVE" &&
            policy.deadline.refundHumanWait;
          const deadlineCap = refundHumanWait
            ? task.run.hardDeadlineAt
            : task.run.deadlineAt;
          const expiresAt = new Date(
            Math.min(
              input.outcome.intervention.expiresAt
                ? Date.parse(input.outcome.intervention.expiresAt)
                : requestedAt.getTime() + policy.hitl.timeoutSeconds * 1_000,
              deadlineCap.getTime(),
            ),
          );
          const pausedExecutionRemainingMs = refundHumanWait
            ? Math.max(0, task.run.deadlineAt.getTime() - requestedAt.getTime())
            : null;
          const intervention = await tx.humanIntervention.create({
            data: {
              attemptId: task.attemptId,
              context: json(input.outcome.intervention.context),
              expiresAt,
              kind: input.outcome.intervention.kind,
              pausedExecutionRemainingMs,
              prompt: input.outcome.intervention.prompt,
              responseSchema: json(input.outcome.intervention.responseSchema),
              runId: task.runId,
              taskId: task.id,
              teamId,
            },
          });
          if (refundHumanWait) {
            const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
            const waitingSnapshot = runtimeTaskSnapshotSchema.parse({
              ...snapshot,
              deadlineAt: expiresAt.toISOString(),
              hardDeadlineAt: task.run.hardDeadlineAt.toISOString(),
            });
            await tx.agentRuntimeTask.update({
              data: {
                deadlineAt: expiresAt,
                snapshot: json(waitingSnapshot),
              },
              where: { id: task.id },
            });
            pausedDeadlineAt = expiresAt;
          }
          const browserExecution = await tx.browserExecution.findUnique({
            where: { attemptId: task.attemptId },
          });
          if (browserExecution?.runtimeSessionId) {
            await tx.browserRuntimeSession.updateMany({
              data: { leaseExpiresAt: expiresAt },
              where: {
                id: browserExecution.runtimeSessionId,
                status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL"] },
              },
            });
            await tx.browserRuntimeSlot.updateMany({
              data: { expiresAt },
              where: { sessionId: browserExecution.runtimeSessionId },
            });
            await tx.browserRuntimeProfileLease.updateMany({
              data: { expiresAt },
              where: { sessionId: browserExecution.runtimeSessionId },
            });
          }
          await tx.runEvent.create({
            data: {
              actor: "AGENT_RUNTIME",
              attemptId: task.attemptId,
              kind: "human.intervention.requested",
              payload: json({
                expiresAt: expiresAt.toISOString(),
                interventionId: intervention.id,
                prompt: intervention.prompt,
                pausedExecutionRemainingMs,
                runtimeSessionPreserved: Boolean(
                  browserExecution?.runtimeSessionId,
                ),
              }),
              runId: task.runId,
              taskId: task.id,
              teamId,
            },
          });
          if (policy.hitl.notificationChannels.includes("FEISHU")) {
            await tx.notificationOutbox.create({
              data: {
                channel: "FEISHU",
                dedupeKey: `run:${task.runId}:intervention:${intervention.id}:requested:feishu`,
                eventType: "hitl.requested",
                executionRunId: task.runId,
                interventionId: intervention.id,
                payload: json({
                  expiresAt: expiresAt.toISOString(),
                  goal: task.run.goal,
                  interventionId: intervention.id,
                  prompt: intervention.prompt,
                  runId: task.runId,
                  runKind: "EXECUTION_RUN",
                }),
                teamId,
              },
            });
          }
        }

        await tx.executionRun.update({
          data: {
            executionDisposition: projection.executionDisposition,
            finishedAt:
              projection.nextAttemptScheduled || isWaiting ? null : completedAt,
            lifecycle: projection.lifecycle,
            verdict: projection.verdict,
            ...(pausedDeadlineAt ? { deadlineAt: pausedDeadlineAt } : {}),
          },
          where: { id: task.runId },
        });
        await tx.runEvent.create({
          data: {
            actor: "AGENT_RUNTIME",
            attemptId: task.attemptId,
            kind: `runtime.outcome.${input.outcome.kind.toLowerCase()}`,
            payload: json({
              completionId: input.completionId,
              executionDisposition: input.outcome.executionDisposition,
              nextAttemptScheduled: projection.nextAttemptScheduled,
              summary: input.outcome.summary,
            }),
            runId: task.runId,
            taskId: task.id,
            teamId,
          },
        });

        if (projection.nextAttemptScheduled) {
          await this.scheduleNextAttempt(tx, task, teamId);
        }

        return {
          accepted: true,
          attemptNumber: task.attempt.number,
          lifecycle: projection.lifecycle,
          nextAttemptScheduled: projection.nextAttemptScheduled,
          taskStatus: projection.taskStatus,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async scheduleNextAttempt(
    tx: Prisma.TransactionClient,
    task: Awaited<ReturnType<AgentRuntimeTaskService["findTask"]>>,
    teamId: string,
  ) {
    const nextAttemptNumber = task.attempt.number + 1;
    const nextAttemptId = randomUUID();
    const nextTaskId = randomUUID();
    const previousSnapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
    const nextSnapshot = runtimeTaskSnapshotSchema.parse({
      ...previousSnapshot,
      attemptId: nextAttemptId,
      attemptNumber: nextAttemptNumber,
      deadlineAt: task.run.deadlineAt.toISOString(),
      hardDeadlineAt: task.run.hardDeadlineAt.toISOString(),
    });
    await tx.runAttempt.create({
      data: {
        id: nextAttemptId,
        inputSnapshot: json(nextSnapshot),
        number: nextAttemptNumber,
        runId: task.runId,
      },
    });
    await tx.agentRuntimeTask.create({
      data: {
        attemptId: nextAttemptId,
        capability: task.capability,
        deadlineAt: task.run.deadlineAt,
        id: nextTaskId,
        provider: task.provider,
        runId: task.runId,
        snapshot: json(nextSnapshot),
      },
    });
    await tx.executionRun.update({
      data: { currentAttemptNumber: nextAttemptNumber },
      where: { id: task.runId },
    });
    await tx.runEvent.create({
      data: {
        actor: "CONTROL_PLANE",
        attemptId: nextAttemptId,
        kind: "run.retry.queued",
        payload: json({
          attemptNumber: nextAttemptNumber,
          previousAttemptId: task.attemptId,
          taskId: nextTaskId,
        }),
        runId: task.runId,
        taskId: nextTaskId,
        teamId,
      },
    });
  }

  private async extendBrowserLeases(
    tx: Prisma.TransactionClient,
    attemptId: string,
    deadlineAt: Date,
  ) {
    const execution = await tx.browserExecution.findUnique({
      select: { runtimeSessionId: true },
      where: { attemptId },
    });
    if (!execution?.runtimeSessionId) return;
    const sessionId = execution.runtimeSessionId;
    await tx.browserRuntimeSession.updateMany({
      data: { leaseExpiresAt: deadlineAt },
      where: {
        id: sessionId,
        status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL"] },
      },
    });
    await tx.browserRuntimeSlot.updateMany({
      data: { expiresAt: deadlineAt },
      where: { expiresAt: { lt: deadlineAt }, sessionId },
    });
    await tx.browserRuntimeProfileLease.updateMany({
      data: { expiresAt: deadlineAt },
      where: { expiresAt: { lt: deadlineAt }, sessionId },
    });
  }

  private async recordRuntimeProgress(
    tx: Prisma.TransactionClient,
    task: Awaited<ReturnType<AgentRuntimeTaskService["findTask"]>>,
    event: z.infer<typeof runtimeTraceEventSchema>,
    recordedAt: Date,
  ) {
    if (event.kind === "agent.model.started") {
      await tx.agentRuntimeTask.update({
        data: {
          activeOperation: "MODEL",
          activeOperationKey: traceOperationKey(event.payload),
          activeOperationStartedAt: recordedAt,
          lastProgressAt: recordedAt,
        },
        where: { id: task.id },
      });
      return;
    }
    if (
      event.kind === "agent.model.completed" ||
      event.kind === "agent.model.failed"
    ) {
      const durationMs = Math.min(2_147_483_647, event.payload.durationMs);
      const modelLatencyEwmaMs =
        task.modelLatencyEwmaMs === null
          ? durationMs
          : Math.round(task.modelLatencyEwmaMs * 0.7 + durationMs * 0.3);
      await tx.agentRuntimeTask.update({
        data: {
          activeOperation: null,
          activeOperationKey: null,
          activeOperationStartedAt: null,
          lastModelCompletedAt: recordedAt,
          lastModelLatencyMs: durationMs,
          lastModelOperationKey: traceOperationKey(event.payload),
          lastProgressAt: recordedAt,
          modelLatencyEwmaMs,
          modelLatencyMaxMs: Math.max(task.modelLatencyMaxMs, durationMs),
        },
        where: { id: task.id },
      });
      return;
    }
    if (event.kind === "agent.tool.started") {
      await tx.agentRuntimeTask.update({
        data: {
          activeOperation: "TOOL",
          activeOperationKey: traceOperationKey(event.payload),
          activeOperationStartedAt: recordedAt,
          lastProgressAt: recordedAt,
        },
        where: { id: task.id },
      });
      return;
    }
    if (
      event.kind === "agent.tool.completed" ||
      event.kind === "agent.tool.failed" ||
      event.kind === "agent.segment.completed"
    ) {
      await tx.agentRuntimeTask.update({
        data: {
          activeOperation: null,
          activeOperationKey: null,
          activeOperationStartedAt: null,
          lastProgressAt: recordedAt,
        },
        where: { id: task.id },
      });
      return;
    }
    if (event.kind === "agent.segment.started") {
      await tx.agentRuntimeTask.update({
        data: { lastProgressAt: recordedAt },
        where: { id: task.id },
      });
    }
  }

  private async findTask(
    tx: Prisma.TransactionClient,
    teamId: string,
    taskId: string,
  ) {
    const task = await tx.agentRuntimeTask.findFirst({
      include: { attempt: true, run: true },
      where: { id: taskId, run: { teamId } },
    });
    if (!task) throw new NotFoundException("Runtime task not found.");
    return task;
  }

  private requireLease(
    task: Awaited<ReturnType<AgentRuntimeTaskService["findTask"]>>,
    input: { fencingToken: string; leaseToken: string; workerId: string },
  ) {
    if (
      task.leaseOwner !== input.workerId ||
      task.leaseToken !== input.leaseToken ||
      task.fencingToken.toString() !== input.fencingToken
    ) {
      throw new ConflictException("The Runtime task lease is stale.");
    }
  }
}

function traceOperationKey(payload: { segmentId: string; step: number }) {
  return `${payload.segmentId}:${payload.step}`;
}

function normalizeAcknowledgedTaskStatus(status: string) {
  if (status === "WAITING_HUMAN") return "WAITING_HUMAN" as const;
  if (status === "SUCCEEDED") return "SUCCEEDED" as const;
  if (status === "TIMED_OUT") return "TIMED_OUT" as const;
  return "FAILED" as const;
}

function isUniqueConstraint(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export function completedOutcomeEvidenceError(
  snapshot: ReturnType<typeof runtimeTaskSnapshotSchema.parse>,
  outcome: Extract<
    RuntimeTaskOutcomeInput["outcome"],
    { kind: "VERIFICATION_COMPLETED" }
  >,
  persistedEvidence: Array<{
    externalId: string;
    kind: string;
    label: string;
    metadata: unknown;
  }>,
) {
  const criteria = new Map(snapshot.criteria.map((item) => [item.id, item]));
  const results = new Map(
    outcome.criteria.map((item) => [item.criterionId, item]),
  );
  const evidence = new Map<string, RuntimeEvidenceRef>(
    snapshot.businessReferences.map((item) => [item.externalId, item]),
  );
  for (const item of persistedEvidence) {
    const kind = runtimeEvidenceKindSchema.safeParse(item.kind);
    if (!kind.success) continue;
    evidence.set(item.externalId, {
      externalId: item.externalId,
      kind: kind.data,
      label: item.label,
      metadata:
        item.metadata && typeof item.metadata === "object"
          ? (item.metadata as Record<string, unknown>)
          : {},
    });
  }
  for (const item of outcome.evidence) {
    const trusted = evidence.get(item.externalId);
    if (!trusted || trusted.kind !== item.kind) {
      return `Completed verification includes untrusted evidence ${item.externalId}.`;
    }
  }
  for (const criterion of snapshot.criteria) {
    if (criterion.required && !results.has(criterion.id)) {
      return `Completed verification is missing required criterion ${criterion.id}.`;
    }
  }
  for (const result of outcome.criteria) {
    const criterion = criteria.get(result.criterionId);
    if (!criterion) {
      return `Completed verification references unknown criterion ${result.criterionId}.`;
    }
    const unavailable = result.evidenceRefs.filter(
      (externalId) => !evidence.has(externalId),
    );
    if (unavailable.length > 0) {
      return `Criterion ${criterion.id} references unavailable evidence: ${unavailable.join(", ")}.`;
    }
    if (result.status !== "PASSED") continue;
    const missing = missingRequiredEvidenceKinds(
      criterion,
      result.evidenceRefs,
      evidence.values(),
    );
    if (missing.length > 0) {
      return `Passing criterion ${criterion.id} is missing required evidence kinds: ${missing.join(", ")}.`;
    }
  }
  return null;
}
