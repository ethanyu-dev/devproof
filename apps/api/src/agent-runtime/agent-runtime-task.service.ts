import { randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
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
import { AgentModelConfigurationService } from "../console/agent-model-configuration.service.js";
import { PrismaService } from "../database/prisma.service.js";
import { BrowserExecutionRunner } from "../verification/browser-execution-runner.service.js";
import { RuntimeCommandDispatcher } from "../runtime/runtime-command-dispatcher.service.js";
import { releaseCompletedSessionData } from "../runtime/session-resource-cleanup.js";
import { potentialWriteCommandWhere } from "../runtime/session-write-audit.js";

const MODEL_CONFIGURATION_PROTOCOL_MINOR = 2;

const retryPolicySchema = z.object({
  browser: z
    .object({
      availabilityPolicy: z.enum(["WAIT", "FAIL_FAST"]),
      profile: z.object({
        key: z.string().optional(),
        mode: z.enum(["PERSISTENT", "EPHEMERAL"]),
      }),
      requiredCapabilities: z.array(z.string()),
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

export function deadlinePolicyPausesHumanWait(policy: RunDeadlinePolicy) {
  return policy.mode === "FIXED" || policy.refundHumanWait;
}

export function hitlWaitDeadline(input: {
  currentDeadlineAtMs: number;
  pauseHumanWait: boolean;
  policyTimeoutSeconds: number;
  requestedAtMs: number;
  requestedExpiresAtMs?: number;
}) {
  const policyExpiresAtMs =
    input.requestedAtMs + input.policyTimeoutSeconds * 1_000;
  return new Date(
    Math.min(
      input.requestedExpiresAtMs ?? policyExpiresAtMs,
      policyExpiresAtMs,
      input.pauseHumanWait
        ? Number.POSITIVE_INFINITY
        : input.currentDeadlineAtMs,
    ),
  );
}

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

class BrowserClaimChanged extends Error {
  constructor(readonly taskId: string) {
    super("Browser admission changed before Agent claim.");
  }
}

@Injectable()
export class AgentRuntimeTaskService {
  private readonly logger = new Logger(AgentRuntimeTaskService.name);
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recovering = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentModels: AgentModelConfigurationService,
    @Optional() private readonly browser?: BrowserExecutionRunner,
    @Optional() private readonly commands?: RuntimeCommandDispatcher,
  ) {}

  onModuleInit() {
    if (!this.browser) return;
    this.recoveryTimer = setInterval(
      () =>
        void this.recoverExpiredLeases().catch((error: Error) =>
          this.logger.error(error.message),
        ),
      2_000,
    );
    this.recoveryTimer.unref();
  }

  onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  async recoverExpiredLeases() {
    if (this.recovering || !this.browser) return;
    this.recovering = true;
    try {
      const now = new Date();
      const expired = await this.prisma.agentRuntimeTask.findMany({
        include: {
          run: true,
          attempt: { include: { browserExecution: true } },
        },
        where: { status: "RUNNING", leaseExpiresAt: { lte: now } },
        orderBy: { leaseExpiresAt: "asc" },
        take: 25,
      });
      for (const task of expired) {
        await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.agentRuntimeTask.updateMany({
            data: {
              status: "FAILED",
              fencingToken: { increment: 1 },
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              leaseLostAt: now,
              recoveryStatus: "PENDING",
              recoveryNextAttemptAt: now,
            },
            where: {
              id: task.id,
              status: "RUNNING",
              fencingToken: task.fencingToken,
              leaseExpiresAt: { lte: now },
            },
          });
          if (claimed.count !== 1) return;
          const error = {
            code: "RUNTIME_LEASE_LOST",
            failureClass: "RUNTIME_LOST",
            message:
              "Agent ownership expired; the old browser must stop before retrying.",
            phase: "browser_verification",
          };
          await tx.runAttempt.update({
            data: {
              status: "FAILED",
              finishedAt: now,
              failureClass: "RUNTIME_LOST",
              error,
            },
            where: { id: task.attemptId },
          });
          if (task.attempt.browserExecution?.runtimeSessionId) {
            await tx.browserRuntimeSession.updateMany({
              data: { executionPermitExpiresAt: now, quarantinedAt: now },
              where: { id: task.attempt.browserExecution.runtimeSessionId },
            });
          }
          await tx.runEvent.create({
            data: {
              actor: "CONTROL_PLANE",
              attemptId: task.attemptId,
              kind: "runtime.lease_lost",
              payload: {
                lostFencingToken: task.fencingToken.toString(),
                workerId: task.leaseOwner,
              },
              runId: task.runId,
              taskId: task.id,
              teamId: task.run.teamId,
            },
          });
          await tx.taskCaseExecution.updateMany({
            data: {
              scheduling: {
                state: "RECOVERING",
                reason: "LEASE_RECOVERY",
                waitingSince: now.toISOString(),
                evaluatedAt: now.toISOString(),
                blockedBy: null,
                queue: null,
                nextRetryAt: now.toISOString(),
              },
            },
            where: { runId: task.runId },
          });
          if (task.run.taskExecutionId)
            await tx.taskExecution.update({
              data: { projectionNeededAt: now },
              where: { id: task.run.taskExecutionId },
            });
        });
      }
      const recoveries = await this.prisma.agentRuntimeTask.findMany({
        include: {
          run: true,
          attempt: { include: { browserExecution: true } },
        },
        where: {
          recoveryStatus: { in: ["PENDING", "CLOSING"] },
          recoveryNextAttemptAt: { lte: now },
        },
        orderBy: { leaseLostAt: "asc" },
        take: 25,
      });
      for (const task of recoveries) {
        const execution = task.attempt.browserExecution;
        const policy = task.run.concurrencyPolicy as {
          accessMode?: string;
        } | null;
        const commandCount = execution?.runtimeSessionId
          ? await this.prisma.browserRuntimeCommand.count({
              where: {
                sessionId: execution.runtimeSessionId,
                ...potentialWriteCommandWhere,
              },
            })
          : 0;
        const unknownWrite =
          policy?.accessMode !== "READ_ONLY" && commandCount > 0;
        if (unknownWrite && execution?.runtimeSessionId) {
          await this.prisma.executionResourceLease.updateMany({
            data: { quarantined: true },
            where: { sessionId: execution.runtimeSessionId },
          });
        }
        if (this.commands && execution?.runtimeSessionId) {
          const pending = await this.prisma.browserRuntimeCommand.findMany({
            select: { id: true },
            where: {
              sessionId: execution.runtimeSessionId,
              status: { in: ["PENDING", "DISPATCHED"] },
              commandType: { not: "session.close" },
            },
          });
          await Promise.allSettled(
            pending.map((command) =>
              this.commands!.cancel(command.id, "Agent lease was lost."),
            ),
          );
        }
        if (execution)
          void this.browser
            .releaseForExecutionRun(task.run.teamId, execution.id)
            .catch((error: Error) =>
              this.logger.warn(
                `Recovery browser close remains unresolved: ${error.message}`,
              ),
            );
        const session = execution?.runtimeSessionId
          ? await this.prisma.browserRuntimeSession.findUnique({
              where: { id: execution.runtimeSessionId },
            })
          : null;
        const closed =
          !session ||
          Boolean(session.closureVerifiedAt) ||
          session.status === "CLOSED";
        const expiredRun =
          task.run.deadlineAt <= new Date() ||
          task.run.cancelRequestedAt ||
          ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(task.run.lifecycle);
        if (!closed && !unknownWrite && !expiredRun) {
          await this.prisma.agentRuntimeTask.updateMany({
            data: {
              recoveryStatus: "CLOSING",
              recoveryNextAttemptAt: new Date(Date.now() + 5_000),
            },
            where: {
              id: task.id,
              recoveryStatus: { in: ["PENDING", "CLOSING"] },
            },
          });
          continue;
        }
        await this.prisma.$transaction(
          async (tx) => {
            const current = await this.findTask(tx, task.run.teamId, task.id);
            const currentSession = execution?.runtimeSessionId
              ? await tx.browserRuntimeSession.findUnique({
                  where: { id: execution.runtimeSessionId },
                })
              : null;
            const verifiedClosed =
              !execution?.runtimeSessionId ||
              Boolean(
                currentSession &&
                (currentSession.closureVerifiedAt ||
                  currentSession.status === "CLOSED"),
              );
            const potentialWrites = execution?.runtimeSessionId
              ? await tx.browserRuntimeCommand.count({
                  where: {
                    sessionId: execution.runtimeSessionId,
                    ...potentialWriteCommandWhere,
                  },
                })
              : 0;
            const recoveryUnknownWrite =
              (current.run.concurrencyPolicy as { accessMode?: string } | null)
                ?.accessMode !== "READ_ONLY" && potentialWrites > 0;
            const decision = leaseRecoveryDecision({
              closed: verifiedClosed,
              unknownWrite: recoveryUnknownWrite,
              expired:
                Boolean(expiredRun) ||
                current.run.deadlineAt <= new Date() ||
                Boolean(current.run.cancelRequestedAt) ||
                ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(
                  current.run.lifecycle,
                ),
              infrastructureRecoveries: current.run.infrastructureRecoveryCount,
              attemptNumber: current.attempt.number,
              maxAttempts: current.run.maxAttempts,
            });
            const changed = await tx.agentRuntimeTask.updateMany({
              data: {
                recoveryStatus: decision,
                recoveryNextAttemptAt: null,
                finishedAt: new Date(),
                error: {
                  code:
                    decision === "WRITE_OUTCOME_UNKNOWN"
                      ? decision
                      : "RUNTIME_LEASE_LOST",
                  failureClass: "RUNTIME_LOST",
                  message:
                    decision === "WRITE_OUTCOME_UNKNOWN"
                      ? "A browser operation may have changed business data; reconcile state before replaying."
                      : "The Runtime lease was lost.",
                  phase: "browser_verification",
                },
              },
              where: {
                id: task.id,
                recoveryStatus: { in: ["PENDING", "CLOSING"] },
              },
            });
            if (changed.count !== 1) return;
            if (execution?.runtimeSessionId) {
              if (recoveryUnknownWrite) {
                await tx.executionResourceLease.updateMany({
                  where: { sessionId: execution.runtimeSessionId },
                  data: { quarantined: true },
                });
              } else if (verifiedClosed && potentialWrites === 0) {
                // Closure plus complete command audit proves this reserved writer never ran.
                await tx.executionResourceLease.deleteMany({
                  where: { sessionId: execution.runtimeSessionId },
                });
                await tx.browserRuntimeSession.updateMany({
                  where: { id: execution.runtimeSessionId },
                  data: { quarantinedAt: null },
                });
              }
            }
            if (decision === "RETRY_SCHEDULED") {
              await tx.executionRun.update({
                data: {
                  infrastructureRecoveryCount: { increment: 1 },
                  lifecycle: "QUEUED",
                  executionDisposition: "RUNTIME_LOST",
                },
                where: { id: current.runId },
              });
              await this.scheduleNextAttempt(tx, current, task.run.teamId);
            } else if (
              !["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(
                current.run.lifecycle,
              )
            ) {
              await tx.executionRun.update({
                data: {
                  lifecycle:
                    current.run.deadlineAt <= new Date()
                      ? "TIMED_OUT"
                      : "COMPLETED",
                  verdict: null,
                  executionDisposition:
                    decision === "WRITE_OUTCOME_UNKNOWN"
                      ? "BLOCKED"
                      : "RUNTIME_LOST",
                  finishedAt: new Date(),
                },
                where: { id: current.runId },
              });
            }
            await tx.runEvent.create({
              data: {
                actor: "CONTROL_PLANE",
                attemptId: task.attemptId,
                kind: "runtime.lease_recovery.completed",
                payload: {
                  decision,
                  oldSessionClosed: verifiedClosed,
                  unknownWrite: recoveryUnknownWrite,
                },
                runId: task.runId,
                taskId: task.id,
                teamId: task.run.teamId,
              },
            });
            await tx.taskCaseExecution.updateMany({
              data: {
                scheduling: {
                  state: decision === "RETRY_SCHEDULED" ? "READY" : "TERMINAL",
                  reason:
                    decision === "RETRY_SCHEDULED" ? null : "LEASE_RECOVERY",
                  waitingSince: null,
                  evaluatedAt: new Date().toISOString(),
                  blockedBy: null,
                  queue: null,
                  nextRetryAt: null,
                },
              },
              where: { runId: task.runId },
            });
            if (task.run.taskExecutionId)
              await tx.taskExecution.update({
                data: { projectionNeededAt: new Date() },
                where: { id: task.run.taskExecutionId },
              });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      }
    } finally {
      this.recovering = false;
    }
  }

  async claim(teamId: string, input: RuntimeTaskClaimInput) {
    if (input.protocol.minor < MODEL_CONFIGURATION_PROTOCOL_MINOR) {
      throw new BadRequestException(
        `Agent Runtime protocol minor ${MODEL_CONFIGURATION_PROTOCOL_MINOR} or newer is required for Console-managed models.`,
      );
    }
    const modelCandidates = await this.agentModels.candidatesForPool(
      teamId,
      "BROWSER_EXECUTION",
    );
    if (modelCandidates.length === 0) return { task: null };
    const skipped = new Set<string>();
    for (let collision = 0; collision < 5; collision += 1) {
      const claimed = await this.prisma
        .$transaction(
          async (tx) => {
            const now = await databaseNow(tx);
            const candidate = await tx.agentRuntimeTask.findFirst({
              orderBy: { createdAt: "asc" },
              where: {
                id: { notIn: [...skipped] },
                capability: { in: input.capabilities },
                deadlineAt: { gt: now },
                OR: [
                  { recoveryStatus: null },
                  { recoveryStatus: { not: "STARTUP_CLOSING" } },
                ],
                run: {
                  cancelRequestedAt: null,
                  lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
                  teamId,
                },
                attempt: {
                  browserExecution: {
                    is: {
                      runtimeSessionId: { not: null },
                      status: "ACTIVE",
                      runtimeSession: {
                        is: {
                          status: "ACTIVE",
                          quarantinedAt: null,
                          closureVerifiedAt: null,
                          leaseExpiresAt: { gt: now },
                          executionPermitExpiresAt: { gt: now },
                        },
                      },
                    },
                  },
                },
                status: "PENDING",
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
                status: "PENDING",
                OR: [
                  { recoveryStatus: null },
                  { recoveryStatus: { not: "STARTUP_CLOSING" } },
                ],
              },
            });
            if (acquired.count !== 1) return undefined;

            const task = await tx.agentRuntimeTask.findUniqueOrThrow({
              include: { run: true },
              where: { id: candidate.id },
            });
            if (
              task.run.executionBudgetSeconds &&
              !task.run.executionBudgetStartedAt
            ) {
              const parent = task.run.taskExecutionId
                ? await tx.taskExecution.findUnique({
                    select: { deadlineAt: true },
                    where: { id: task.run.taskExecutionId },
                  })
                : null;
              const budget = initializeExecutionBudget({
                now,
                seconds: task.run.executionBudgetSeconds,
                extensionSeconds: task.run.executionMaxExtensionSeconds ?? 0,
                parentDeadlineAt: parent?.deadlineAt ?? null,
              });
              const initialized = await tx.executionRun.updateMany({
                data: {
                  ...budget,
                  initialDeadlineAt: budget.deadlineAt,
                  executionBudgetStartedAt: now,
                },
                where: { id: task.runId, executionBudgetStartedAt: null },
              });
              if (initialized.count !== 1)
                throw new ConflictException(
                  "Execution budget initialization conflicted.",
                );
              const nextSnapshot = runtimeTaskSnapshotSchema.parse({
                ...runtimeTaskSnapshotSchema.parse(task.snapshot),
                deadlineAt: budget.deadlineAt.toISOString(),
                hardDeadlineAt: budget.hardDeadlineAt.toISOString(),
              });
              task.snapshot = nextSnapshot as Prisma.JsonValue;
              task.deadlineAt = budget.deadlineAt;
              task.run.deadlineAt = budget.deadlineAt;
              task.run.hardDeadlineAt = budget.hardDeadlineAt;
              await tx.agentRuntimeTask.update({
                data: {
                  snapshot: json(nextSnapshot),
                  deadlineAt: budget.deadlineAt,
                },
                where: { id: task.id },
              });
            }
            const execution = await tx.browserExecution.findUnique({
              where: { attemptId: task.attemptId },
            });
            if (!execution?.runtimeSessionId || execution.status !== "ACTIVE")
              throw new BrowserClaimChanged(candidate.id);
            {
              const owned = await tx.browserRuntimeSession.updateMany({
                data: {
                  ownerTaskId: task.id,
                  ownerFencingToken: task.fencingToken,
                  executionPermitExpiresAt: new Date(
                    Math.min(
                      leaseExpiresAt.getTime(),
                      task.run.deadlineAt.getTime(),
                    ),
                  ),
                },
                where: {
                  id: execution.runtimeSessionId,
                  status: "ACTIVE",
                  quarantinedAt: null,
                  closureVerifiedAt: null,
                  leaseExpiresAt: { gt: now },
                  executionPermitExpiresAt: { gt: now },
                  OR: [
                    { ownerTaskId: null },
                    {
                      ownerTaskId: task.id,
                      ownerFencingToken: candidate.fencingToken,
                    },
                  ],
                },
              });
              if (owned.count !== 1)
                throw new BrowserClaimChanged(candidate.id);
            }
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
            if (task.run.taskExecutionId) {
              await tx.taskCaseExecution.updateMany({
                data: {
                  scheduling: {
                    state: "RUNNING",
                    reason: null,
                    waitingSince: null,
                    evaluatedAt: now.toISOString(),
                    blockedBy: null,
                    queue: null,
                    nextRetryAt: null,
                  },
                },
                where: { runId: task.runId },
              });
              await tx.taskExecution.update({
                data: { projectionNeededAt: now },
                where: { id: task.run.taskExecutionId },
              });
            }
            return task;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        )
        .catch((error: unknown) => {
          if (!(error instanceof BrowserClaimChanged)) throw error;
          skipped.add(error.taskId);
          return undefined;
        });

      if (claimed === undefined) continue;
      if (claimed === null) return { task: null };

      const snapshot = runtimeTaskSnapshotSchema.parse(claimed.snapshot);
      return {
        task: {
          fencingToken: claimed.fencingToken.toString(),
          leaseExpiresAt: claimed.leaseExpiresAt?.toISOString(),
          leaseToken: claimed.leaseToken,
          serverTime: new Date().toISOString(),
          snapshot: runtimeTaskSnapshotSchema.parse({
            ...snapshot,
            modelCandidates,
          }),
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
      const now = await databaseNow(tx);
      this.requireLease(task, input, now);
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
          serverTime: now.toISOString(),
        };
      }
      if (!(["RUNNING", "WAITING_HUMAN"] as string[]).includes(task.status)) {
        throw new ConflictException("The Runtime task is already terminal.");
      }

      const leaseExpiresAt = leaseExpiry(now);
      const renewed = await tx.agentRuntimeTask.updateMany({
        data: { lastHeartbeatAt: now, leaseExpiresAt },
        where: leaseWhere(taskId, input, now),
      });
      if (renewed.count !== 1) throw staleLease();
      await tx.browserRuntimeSession.updateMany({
        data: {
          executionPermitExpiresAt: new Date(
            Math.min(leaseExpiresAt.getTime(), task.run.deadlineAt.getTime()),
          ),
        },
        where: {
          ownerTaskId: task.id,
          ownerFencingToken: task.fencingToken,
          status: "ACTIVE",
          quarantinedAt: null,
        },
      });
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
              serverTime: now.toISOString(),
            };
          }
        }
      }
      return {
        deadlineAt: deadlineAt.toISOString(),
        directive: "CONTINUE" as const,
        hardDeadlineAt: hardDeadlineAt.toISOString(),
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        serverTime: now.toISOString(),
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
      const now = await databaseNow(tx);
      this.requireLease(task, input, now);
      await this.lockCurrentLease(tx, taskId, input, now);
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
        const now = await databaseNow(tx);
        this.requireLease(task, input, now);
        await this.lockCurrentLease(tx, taskId, input, now);
        let outcome = input.outcome;
        let writeOutcomeUnknown = false;
        if (
          (outcome.kind === "RETRYABLE_FAILURE" ||
            outcome.kind === "FATAL_FAILURE") &&
          (task.run.concurrencyPolicy as { accessMode?: string } | null)
            ?.accessMode !== "READ_ONLY"
        ) {
          const writes = await tx.browserRuntimeCommand.count({
            where: {
              session: {
                browserExecutions: { some: { attemptId: task.attemptId } },
              },
              ...potentialWriteCommandWhere,
            },
          });
          if (writes > 0) {
            writeOutcomeUnknown = true;
            outcome = {
              kind: "FATAL_FAILURE",
              executionDisposition: "BLOCKED",
              error: {
                code: "WRITE_OUTCOME_UNKNOWN",
                failureClass: "RUNTIME_LOST",
                message:
                  "Browser execution stopped after a possible write; reconcile the affected state before retrying.",
                phase: "browser_verification",
                details: {},
              },
              summary: "写操作结果尚未确认，相关资源已隔离，等待状态核对。",
            };
            await tx.executionResourceLease.updateMany({
              data: { quarantined: true },
              where: {
                session: {
                  browserExecutions: { some: { attemptId: task.attemptId } },
                },
              },
            });
          }
        }
        if (!(["RUNNING", "WAITING_HUMAN"] as string[]).includes(task.status)) {
          throw new ConflictException("The Runtime task is already terminal.");
        }
        if (
          task.run.cancelRequestedAt ||
          ["CANCELLED", "TIMED_OUT"].includes(task.run.lifecycle)
        ) {
          throw new ConflictException("The run no longer accepts outcomes.");
        }

        if (outcome.kind === "VERIFICATION_COMPLETED") {
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
            outcome,
            persisted,
          );
          if (validationError) throw new ConflictException(validationError);
        }

        const policy = retryPolicySchema.parse(task.run.executionPolicy);
        const projection = projectRuntimeOutcome({
          attemptNumber: task.attempt.number,
          outcome: outcome,
          retryPolicy: effectiveRetryPolicy({
            ...(policy.browser
              ? {
                  browserAvailabilityPolicy: policy.browser.availabilityPolicy,
                }
              : {}),
            outcome: outcome,
            retryPolicy: policy.retryPolicy,
          }),
        });
        const completedAt = new Date(input.completedAt);
        const isWaiting = outcome.kind === "WAITING_HUMAN";
        let pausedDeadlineAt: Date | null = null;
        const isFailure =
          outcome.kind === "RETRYABLE_FAILURE" ||
          outcome.kind === "FATAL_FAILURE";
        const runtimeError =
          outcome.kind === "RETRYABLE_FAILURE" ||
          outcome.kind === "FATAL_FAILURE"
            ? outcome.error
            : null;

        await tx.agentRuntimeTask.update({
          data: {
            completionId: input.completionId,
            ...(writeOutcomeUnknown
              ? { recoveryStatus: "WRITE_OUTCOME_UNKNOWN" }
              : {}),
            error: runtimeError ? json(runtimeError) : Prisma.JsonNull,
            finishedAt: isWaiting ? null : completedAt,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            result: json(outcome),
            status: projection.taskStatus,
          },
          where: { id: task.id },
        });
        await tx.runAttempt.update({
          data: {
            error: runtimeError ? json(runtimeError) : Prisma.JsonNull,
            failureClass: runtimeError ? runtimeError.failureClass : null,
            finishedAt: isWaiting ? null : completedAt,
            result: json(outcome),
            status: projection.attemptStatus,
          },
          where: { id: task.attemptId },
        });

        if (outcome.kind === "VERIFICATION_COMPLETED") {
          await tx.runCriterionResult.createMany({
            data: outcome.criteria.map((criterion) => ({
              attemptId: task.attemptId,
              criterionId: criterion.criterionId,
              evidenceRefs: criterion.evidenceRefs,
              runId: task.runId,
              status: criterion.status,
              summary: criterion.summary,
              teamId,
            })),
          });
          if (outcome.evidence.length > 0) {
            await tx.runEvidence.createMany({
              data: outcome.evidence.map((evidence) => ({
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

        if (outcome.kind === "WAITING_HUMAN") {
          if (!policy.hitl.enabled) {
            throw new ConflictException("HITL is disabled for this Run.");
          }
          const requestedAt = new Date();
          const pauseHumanWait = deadlinePolicyPausesHumanWait(policy.deadline);
          const expiresAt = hitlWaitDeadline({
            currentDeadlineAtMs: task.run.deadlineAt.getTime(),
            pauseHumanWait,
            policyTimeoutSeconds: policy.hitl.timeoutSeconds,
            requestedAtMs: requestedAt.getTime(),
            ...(outcome.intervention.expiresAt
              ? {
                  requestedExpiresAtMs: Date.parse(
                    outcome.intervention.expiresAt,
                  ),
                }
              : {}),
          });
          const pausedExecutionRemainingMs = pauseHumanWait
            ? Math.max(0, task.run.deadlineAt.getTime() - requestedAt.getTime())
            : null;
          const intervention = await tx.humanIntervention.create({
            data: {
              attemptId: task.attemptId,
              context: json(outcome.intervention.context),
              expiresAt,
              kind: outcome.intervention.kind,
              pausedExecutionRemainingMs,
              prompt: outcome.intervention.prompt,
              responseSchema: json(outcome.intervention.responseSchema),
              runId: task.runId,
              taskId: task.id,
              teamId,
            },
          });
          if (pauseHumanWait) {
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
                  notificationKind: "HITL_REQUESTED",
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
            kind: `runtime.outcome.${outcome.kind.toLowerCase()}`,
            payload: json({
              completionId: input.completionId,
              executionDisposition: outcome.executionDisposition,
              nextAttemptScheduled: projection.nextAttemptScheduled,
              summary: outcome.summary,
            }),
            runId: task.runId,
            taskId: task.id,
            teamId,
          },
        });

        if (projection.nextAttemptScheduled) {
          await this.scheduleNextAttempt(tx, task, teamId);
        }
        if (!isWaiting) await releaseCompletedSessionData(tx, task.id);
        if (task.run.taskExecutionId) {
          if (!isWaiting)
            await tx.taskCaseExecution.updateMany({
              data: {
                scheduling: {
                  state: projection.nextAttemptScheduled ? "READY" : "TERMINAL",
                  reason: writeOutcomeUnknown ? "LEASE_RECOVERY" : null,
                  waitingSince: null,
                  evaluatedAt: new Date().toISOString(),
                  blockedBy: null,
                  queue: null,
                  nextRetryAt: null,
                },
              },
              where: { runId: task.runId },
            });
          await tx.taskExecution.update({
            data: { projectionNeededAt: new Date() },
            where: { id: task.run.taskExecutionId },
          });
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
    const browserPolicy = retryPolicySchema.parse(
      previousSnapshot.executionPolicy,
    ).browser;
    if (!browserPolicy) {
      throw new ConflictException("The retry has no Browser execution policy.");
    }
    const targetUrl =
      typeof previousSnapshot.environment.targetUrl === "string"
        ? previousSnapshot.environment.targetUrl
        : undefined;
    await tx.browserExecution.create({
      data: {
        attemptId: nextAttemptId,
        input: json({
          availabilityPolicy: browserPolicy.availabilityPolicy,
          profile: browserPolicy.profile,
          requiredCapabilities: browserPolicy.requiredCapabilities,
          ...(targetUrl ? { targetUrl } : {}),
        }),
        runId: task.runId,
        status: "REQUESTED",
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
    now = new Date(),
  ) {
    if (
      task.leaseOwner !== input.workerId ||
      task.leaseToken !== input.leaseToken ||
      task.fencingToken.toString() !== input.fencingToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= now
    ) {
      throw staleLease();
    }
  }

  private async lockCurrentLease(
    tx: Prisma.TransactionClient,
    taskId: string,
    input: { fencingToken: string; leaseToken: string; workerId: string },
    now: Date,
  ) {
    const locked = await tx.agentRuntimeTask.updateMany({
      data: { updatedAt: now },
      where: leaseWhere(taskId, input, now),
    });
    if (locked.count !== 1) throw staleLease();
  }
}

function staleLease() {
  return new ConflictException({
    code: "RUNTIME_LEASE_LOST",
    message: "The Runtime task lease is stale.",
  });
}

export function leaseRecoveryDecision(input: {
  closed: boolean;
  unknownWrite: boolean;
  expired: boolean;
  infrastructureRecoveries: number;
  attemptNumber: number;
  maxAttempts: number;
}) {
  if (input.unknownWrite) return "WRITE_OUTCOME_UNKNOWN";
  if (
    !input.closed ||
    input.expired ||
    input.infrastructureRecoveries >= 1 ||
    input.attemptNumber >= input.maxAttempts
  )
    return "EXHAUSTED";
  return "RETRY_SCHEDULED";
}

function leaseWhere(
  taskId: string,
  input: { fencingToken: string; leaseToken: string; workerId: string },
  now: Date,
): Prisma.AgentRuntimeTaskWhereInput {
  return {
    id: taskId,
    fencingToken: BigInt(input.fencingToken),
    leaseOwner: input.workerId,
    leaseToken: input.leaseToken,
    leaseExpiresAt: { gt: now },
    status: { in: ["RUNNING", "WAITING_HUMAN"] },
  };
}

async function databaseNow(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS now`;
  return row!.now;
}

export function initializeExecutionBudget(input: {
  now: Date;
  seconds: number;
  extensionSeconds: number;
  parentDeadlineAt: Date | null;
}) {
  const cap = input.parentDeadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const deadlineAt = new Date(
    Math.min(cap, input.now.getTime() + input.seconds * 1_000),
  );
  const hardDeadlineAt = new Date(
    Math.min(cap, deadlineAt.getTime() + input.extensionSeconds * 1_000),
  );
  if (deadlineAt <= input.now)
    throw new ConflictException("The parent task deadline has elapsed.");
  return { deadlineAt, hardDeadlineAt };
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
