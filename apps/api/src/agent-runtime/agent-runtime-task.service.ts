import { TaskMetricsService } from "../task-executions/task-metrics.service.js";
import { coordinateResumedAccounts } from "../verification/account-coordination.js";
import { decodeStepContext } from "../execution-runs/step-context-archive.js";
import { runtimeCriterionResultSchema } from "@devproof/agent-runtime-protocol";
import { ObservationBindingService } from "./observation-binding.service.js";
import {
  BOUND_EVIDENCE_CAPABILITIES,
  BUSINESS_CHECK_CAPABILITY,
  EVIDENCE_CATALOG_CAPABILITY,
  TYPED_CHECKS_CAPABILITY,
  requiresAgentProtocol26,
} from "@devproof/agent-runtime-protocol";
import { randomUUID, createHash } from "node:crypto";

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
  browserExecutionCriterion,
  browserExecutionSnapshot,
  missingRequiredEvidenceKinds,
  runtimeEvidenceKindSchema,
  runtimeFailureClassSchema,
  runtimeOutcomeSchema,
  runtimeTraceEventSchema,
  runtimeTaskSnapshotSchema,
  runtimeVerificationTerminationReasonSchema,
  businessAccountRequestSchema,
  testAccountBindingsSchema,
  resolveBusinessAccountRequest,
  accountInputResponseSchema,
  accountRequestKindError,
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
import { MetricsService } from "../observability/metrics.service.js";
import { PrismaService } from "../database/prisma.service.js";
import { BrowserExecutionRunner } from "../verification/browser-execution-runner.service.js";
import { RuntimeCommandDispatcher } from "../runtime/runtime-command-dispatcher.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import {
  releaseCompletedSessionData,
  releaseVerifiedSessionResources,
} from "../runtime/session-resource-cleanup.js";
import { potentialWriteCommandWhere } from "../runtime/session-write-audit.js";
import { writeSettled } from "../runtime/session-recovery.state.js";
import { SessionRecoveryService } from "../runtime/session-recovery.service.js";
import { recoveryEnabled } from "../runtime/session-recovery.enabled.js";

import {
  saveExecutionCheckpoint,
  persistCriterionResults,
} from "./execution-checkpoint.js";
import { initializeExecutionBudget } from "../execution-runs/execution-budget.js";

export { initializeExecutionBudget } from "../execution-runs/execution-budget.js";

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
  requireMeaningfulProgress?: boolean;
  lastMeaningfulProgressKey?: string | null;
  lastDeadlineExtensionProgressKey?: string | null;
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
  progressKey?: string;
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
  // Permit one bootstrap extension, then require new observed work. New model
  // call IDs, fallback attempts and repeated cache reads cannot replenish time.
  const progressKey = state.lastMeaningfulProgressKey ?? "INITIAL_OBSERVATION";
  if (
    state.requireMeaningfulProgress &&
    progressKey === state.lastDeadlineExtensionProgressKey
  )
    return null;
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
    ...(state.requireMeaningfulProgress ? { progressKey } : {}),
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
    @Optional() private readonly sessionRecovery?: SessionRecoveryService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional()
    private readonly observationBindings?: ObservationBindingService,
    @Optional() private readonly taskMetrics?: TaskMetricsService,
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
        where: {
          OR: [
            { status: "RUNNING", leaseExpiresAt: { lte: now } },
            unclaimableHumanResume(now),
          ],
        },
        orderBy: { leaseExpiresAt: "asc" },
        take: 25,
      });
      for (const task of expired) {
        const humanResume = task.status === "PENDING";
        await this.prisma.$transaction(async (tx) => {
          await acquireAdvisoryTransactionLock(
            tx,
            "browser-execution-resources",
          );
          const claimed = await tx.agentRuntimeTask.updateMany({
            data: {
              status: "FAILED",
              fencingToken: { increment: 1 },
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              leaseLostAt: now,
              recoveryStatus: humanResume ? "HITL_CLOSING" : "PENDING",
              recoveryNextAttemptAt: now,
            },
            where: {
              id: task.id,
              fencingToken: task.fencingToken,
              ...(humanResume
                ? unclaimableHumanResume(now)
                : { status: "RUNNING", leaseExpiresAt: { lte: now } }),
            },
          });
          if (claimed.count !== 1) return;
          const error = {
            code: humanResume
              ? "HUMAN_RESUME_SESSION_LOST"
              : "RUNTIME_LEASE_LOST",
            failureClass: "RUNTIME_LOST",
            message: humanResume
              ? "The preserved browser is no longer usable after human input; verified recovery is required."
              : "Agent ownership expired; the old browser must stop before retrying.",
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
              where: {
                id: task.attempt.browserExecution.runtimeSessionId,
                ownerTaskId: task.id,
                ownerFencingToken: task.fencingToken,
                closureVerifiedAt: null,
                status: { not: "CLOSED" },
              },
            });
          }
          if (humanResume && task.attempt.browserExecution) {
            await tx.browserExecution.updateMany({
              where: { id: task.attempt.browserExecution.id },
              data: { status: "LOST", nextAdmissionAt: null, error },
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
                ...(humanResume ? { reason: "HUMAN_RESUME_SESSION_LOST" } : {}),
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
          recoveryStatus: { in: ["PENDING", "CLOSING", "HITL_CLOSING"] },
          recoveryNextAttemptAt: { lte: now },
        },
        orderBy: { leaseLostAt: "asc" },
        take: 25,
      });
      for (const task of recoveries) {
        const humanResume = task.recoveryStatus === "HITL_CLOSING";
        const execution = task.attempt.browserExecution;
        const session = execution?.runtimeSessionId
          ? await this.prisma.browserRuntimeSession.findUnique({
              where: { id: execution.runtimeSessionId },
            })
          : null;
        const closed = Boolean(
          session?.closureVerifiedAt && session.closureEvidenceId,
        );
        if (!closed && execution?.runtimeSessionId && recoveryEnabled())
          await this.sessionRecovery?.request(
            execution.runtimeSessionId,
            humanResume ? "HUMAN_RESUME_SESSION_LOST" : "AGENT_LEASE_LOST",
            { explicitClose: true },
          );
        if (!closed && this.commands && execution?.runtimeSessionId) {
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
        if (!closed && execution)
          void this.browser
            .releaseForExecutionRun(task.run.teamId, execution.id)
            .catch((error: Error) =>
              this.logger.warn(
                `Recovery browser close remains unresolved: ${error.message}`,
              ),
            );
        const recovery = session
          ? await this.prisma.runtimeSessionRecovery.findUnique({
              where: {
                sessionId_expectedSessionFence: {
                  sessionId: session.id,
                  expectedSessionFence: session.fencingToken,
                },
              },
            })
          : null;
        // Command history can be incomplete, particularly for legacy sessions.
        // Only the independent, durable write assessment authorizes a replay.
        const unknownWrite = !writeSettled(
          recovery?.writeOutcomeState ?? "UNKNOWN",
        );
        const expiredRun =
          task.run.deadlineAt <= new Date() ||
          task.run.cancelRequestedAt ||
          ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(task.run.lifecycle);
        if (!closed && (humanResume || !unknownWrite) && !expiredRun) {
          await this.prisma.$transaction(async (tx) => {
            await acquireAdvisoryTransactionLock(
              tx,
              "browser-execution-resources",
            );
            const deferred = await tx.agentRuntimeTask.updateMany({
              data: {
                recoveryStatus: humanResume ? "HITL_CLOSING" : "CLOSING",
                recoveryNextAttemptAt: new Date(Date.now() + 5_000),
              },
              where: {
                id: task.id,
                fencingToken: task.fencingToken,
                run: {
                  cancelRequestedAt: null,
                  lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
                },
                recoveryStatus: { in: ["PENDING", "CLOSING", "HITL_CLOSING"] },
              },
            });
            if (humanResume && deferred.count === 1) {
              await tx.taskCaseExecution.updateMany({
                where: { runId: task.runId },
                data: {
                  scheduling: {
                    state: "RECOVERING",
                    reason: "LEASE_RECOVERY",
                    waitingSince: (task.leaseLostAt ?? now).toISOString(),
                    evaluatedAt: new Date().toISOString(),
                    blockedBy: {
                      resourceType: "SESSION",
                      sessionId: execution?.runtimeSessionId,
                      ...(recovery
                        ? {
                            recoveryId: recovery.id,
                            recoveryPhase: recovery.closureState,
                          }
                        : {}),
                    },
                    queue: null,
                    nextRetryAt:
                      recovery?.closureState === "NEEDS_OPERATOR"
                        ? null
                        : new Date(Date.now() + 5_000).toISOString(),
                  },
                },
              });
              if (task.run.taskExecutionId)
                await tx.taskExecution.updateMany({
                  where: { id: task.run.taskExecutionId },
                  data: { projectionNeededAt: new Date() },
                });
            }
          });
          continue;
        }
        const recoveryTransition = this.prisma.$transaction(
          async (tx) => {
            await acquireAdvisoryTransactionLock(
              tx,
              "browser-execution-resources",
            );
            const current = await this.findTask(tx, task.run.teamId, task.id);
            const currentSession = execution?.runtimeSessionId
              ? await tx.browserRuntimeSession.findUnique({
                  where: { id: execution.runtimeSessionId },
                })
              : null;
            const verifiedClosed = Boolean(
              currentSession?.closureVerifiedAt &&
              currentSession.closureEvidenceId,
            );
            const currentRecovery = currentSession
              ? await tx.runtimeSessionRecovery.findUnique({
                  where: {
                    sessionId_expectedSessionFence: {
                      sessionId: currentSession.id,
                      expectedSessionFence: currentSession.fencingToken,
                    },
                  },
                })
              : null;
            const recoveryUnknownWrite = !writeSettled(
              currentRecovery?.writeOutcomeState ?? "UNKNOWN",
            );
            const checkpointEvent = await tx.runEvent.findFirst({
              where: {
                taskId: task.id,
                attemptId: task.attemptId,
                actor: "AGENT_RUNTIME",
                kind: {
                  in: [
                    "executor.deadline.finalized",
                    "executor.budget.finalized",
                    "executor.stagnation.finalized",
                    "executor.session.finalized",
                  ],
                },
                payload: {
                  path: ["fencingToken"],
                  equals: (current.fencingToken - 1n).toString(),
                },
              },
              orderBy: { sequence: "desc" },
              select: { payload: true },
            });
            const pending = readFinalizationCheckpoint(
              checkpointEvent?.payload,
              current.fencingToken - 1n,
            );
            const decision = leaseRecoveryDecision({
              closed: verifiedClosed,
              unknownWrite: recoveryUnknownWrite,
              expired:
                Boolean(pending) ||
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
            const recoveredOutcome = pending
              ? runtimeOutcomeSchema.parse({
                  kind: "FATAL_FAILURE",
                  executionDisposition: "BLOCKED",
                  error: {
                    code:
                      decision === "WRITE_OUTCOME_UNKNOWN"
                        ? decision
                        : "OUTCOME_SUBMISSION_UNCONFIRMED",
                    failureClass: "RUNTIME_LOST",
                    message:
                      "执行器已停止，但结果提交未获确认；保留原始原因，需核对写入与验收证据。",
                    phase: "browser_verification",
                    details: {
                      originalReason: pending.reason,
                      pendingOutcome: pending.outcome,
                    },
                  },
                  summary: `${pending.outcome.summary.slice(0, 7000)}\n结果提交未获确认；待核对内容不作为已接受的产品结论。`,
                })
              : null;
            const changed = await tx.agentRuntimeTask.updateMany({
              data: {
                recoveryStatus: decision,
                recoveryNextAttemptAt: null,
                finishedAt: new Date(),
                ...(recoveredOutcome ? { result: json(recoveredOutcome) } : {}),
                error:
                  recoveredOutcome?.kind === "FATAL_FAILURE"
                    ? json(recoveredOutcome.error)
                    : {
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
                fencingToken: current.fencingToken,
                recoveryStatus: {
                  in: ["PENDING", "CLOSING", "HITL_CLOSING"],
                },
              },
            });
            if (changed.count !== 1) return;
            if (recoveredOutcome?.kind === "FATAL_FAILURE") {
              await tx.runAttempt.update({
                where: { id: task.attemptId },
                data: {
                  result: json(recoveredOutcome),
                  error: json(recoveredOutcome.error),
                  failureClass: "RUNTIME_LOST",
                  status: "FAILED",
                  finishedAt: new Date(),
                },
              });
            }
            if (execution?.runtimeSessionId) {
              if (recoveryUnknownWrite) {
                await tx.executionResourceLease.updateMany({
                  where: {
                    sessionId: execution.runtimeSessionId,
                    mode: "WRITE",
                  },
                  data: { quarantined: true },
                });
              } else if (
                verifiedClosed &&
                writeSettled(currentRecovery!.writeOutcomeState)
              ) {
                const released = await releaseVerifiedSessionResources(
                  tx,
                  execution.runtimeSessionId,
                );
                if (!released)
                  throw new ConflictException(
                    "The session has no matching durable closure proof; its recovery cannot be replayed.",
                  );
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
                    pending || decision === "WRITE_OUTCOME_UNKNOWN"
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
                  ...(pending
                    ? {
                        originalReason: pending.reason,
                        outcomeSubmissionConfirmed: false,
                      }
                    : {}),
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
        await recoveryTransition.catch((error: unknown) => {
          // A competing recovery or closure may commit after our snapshot. The
          // transaction rolled back atomically; the next sweep re-reads it.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2034"
          )
            return;
          throw error;
        });
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
            await acquireAdvisoryTransactionLock(
              tx,
              "browser-execution-resources",
            );
            const now = await databaseNow(tx);
            const candidate = await tx.agentRuntimeTask.findFirst({
              orderBy: { createdAt: "asc" },
              where: {
                id: { notIn: [...skipped] },
                capability: { in: input.capabilities },
                NOT: [2, 3]
                  .filter(
                    (version) =>
                      BOUND_EVIDENCE_CAPABILITIES.some(
                        (capability) => !input.features?.includes(capability),
                      ) ||
                      (version === 3 &&
                        (input.protocol.minor < 23 ||
                          !input.features?.includes(
                            BUSINESS_CHECK_CAPABILITY,
                          ))),
                  )
                  .map((version) => ({
                    snapshot: {
                      path: ["criteria"],
                      array_contains: [{ observationContract: { version } }],
                    },
                  })),
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
            if (
              (runtimeTaskSnapshotSchema
                .parse(candidate.snapshot)
                .criteria.some((c) => c.observationContract?.version === 3) &&
                (input.protocol.minor < 23 ||
                  !input.features?.includes(BUSINESS_CHECK_CAPABILITY))) ||
              (input.protocol.minor < 20 &&
                runtimeTaskSnapshotSchema.parse(candidate.snapshot)
                  .executionPolicy.accountRequirements) ||
              (runtimeTaskSnapshotSchema
                .parse(candidate.snapshot)
                .criteria.some((c) => c.observationContract) &&
                BOUND_EVIDENCE_CAPABILITIES.some(
                  (c) => !input.features?.includes(c),
                ))
            ) {
              skipped.add(candidate.id);
              return undefined;
            }

            const resumeSnapshot = runtimeTaskSnapshotSchema.parse(
              candidate.snapshot,
            );
            if (
              input.protocol.minor < 26 &&
              requiresAgentProtocol26(resumeSnapshot)
            ) {
              skipped.add(candidate.id);
              return undefined;
            }
            if (
              !input.features?.includes(TYPED_CHECKS_CAPABILITY) &&
              resumeSnapshot.criteria.some(
                (c) =>
                  c.observationTargets?.some((t) => t.network) ||
                  (c.observationContract?.version === 3 &&
                    c.observationContract.targets.some((t) =>
                      t.assertions.some((a) => a.property),
                    )),
              )
            ) {
              skipped.add(candidate.id);
              return undefined;
            }

            if (
              resumeSnapshot.executionPolicy.accountCoordinationPending === true
            ) {
              const execution = await tx.browserExecution.findUnique({
                where: { attemptId: candidate.attemptId },
                include: { run: true },
              });
              if (!execution?.runtimeSessionId) return null;
              const targetUrl =
                typeof resumeSnapshot.environment.targetUrl === "string"
                  ? resumeSnapshot.environment.targetUrl
                  : undefined;
              const blocked = await coordinateResumedAccounts(tx, {
                sessionId: execution.runtimeSessionId,
                targetUrl,
                executionPolicy: resumeSnapshot.executionPolicy,
                concurrencyPolicy: execution.run.concurrencyPolicy,
              });
              if (blocked) {
                // Waiting for a data lock is controlled idleness, not a lost agent.
                await tx.browserRuntimeSession.updateMany({
                  where: {
                    id: execution.runtimeSessionId,
                    status: "ACTIVE",
                    quarantinedAt: null,
                  },
                  data: {
                    executionPermitExpiresAt: new Date(
                      Math.min(
                        Date.parse(resumeSnapshot.deadlineAt),
                        now.getTime() + 120000,
                      ),
                    ),
                  },
                });
                await tx.taskCaseExecution.updateMany({
                  where: { runId: candidate.runId },
                  data: {
                    scheduling: {
                      state: "WAITING",
                      reason: "DATA_LOCK",
                      waitingSince: now.toISOString(),
                      evaluatedAt: now.toISOString(),
                      blockedBy: {
                        resourceType: "ACCOUNT",
                        sessionId: blocked.sessionId,
                      },
                      queue: null,
                      nextRetryAt: new Date(now.getTime() + 2000).toISOString(),
                    },
                  },
                });
                skipped.add(candidate.id);
                return undefined;
              }
            }
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
      if (input.features?.includes(EVIDENCE_CATALOG_CAPABILITY)) {
        snapshot.executionPolicy.evidenceCatalog = true;
        const checkpoint = snapshot.executionPolicy.verificationCheckpoint;
        if (
          checkpoint &&
          typeof checkpoint === "object" &&
          !Array.isArray(checkpoint)
        ) {
          const persisted = await this.prisma.runEvidence.findMany({
            where: { runId: claimed.runId, attemptId: claimed.attemptId },
          });
          (checkpoint as Record<string, unknown>).evidence = persisted.map(
            (e) => ({
              externalId: e.externalId,
              kind: e.kind,
              label: e.label,
              metadata: e.metadata,
            }),
          );
        }
      }

      return {
        task: {
          fencingToken: claimed.fencingToken.toString(),
          leaseExpiresAt: claimed.leaseExpiresAt?.toISOString(),
          leaseToken: claimed.leaseToken,
          serverTime: new Date().toISOString(),
          snapshot: browserExecutionSnapshot(
            runtimeTaskSnapshotSchema.parse({
              ...snapshot,
              modelCandidates,
            }),
          ),
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
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
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
          closureVerifiedAt: null,
        },
      });
      const policy = retryPolicySchema.parse(task.run.executionPolicy).deadline;
      const extension = decideAdaptiveDeadlineExtension({
        requireMeaningfulProgress: task.capability === "BROWSER_VERIFICATION",
        lastMeaningfulProgressKey: task.lastMeaningfulProgressKey,
        lastDeadlineExtensionProgressKey: task.lastDeadlineExtensionProgressKey,
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
              ...(extension.progressKey
                ? { lastDeadlineExtensionProgressKey: extension.progressKey }
                : {}),
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
                progressKey: extension.progressKey,
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
      const contextArchive =
        input.event.kind === "agent.model.started" &&
        input.event.payload.contextSnapshot
          ? decodeStepContext(input.event.payload.contextSnapshot)
          : null;
      if (
        contextArchive &&
        (!z.string().uuid().safeParse(input.event.payload.modelCallId)
          .success ||
          !runtimeTraceEventSchema.safeParse({
            kind: input.event.kind,
            payload: input.event.payload,
          }).success)
      )
        throw new BadRequestException(
          "Step context requires a valid model call identity.",
        );
      const { contextSnapshot: _archive, ...eventPayload } =
        input.event.payload;
      try {
        const event = await tx.runEvent.create({
          data: {
            actor: "AGENT_RUNTIME",
            attemptId: task.attemptId,
            id: input.event.eventId,
            kind: input.event.kind,
            occurredAt: new Date(input.event.occurredAt),
            payload: json({
              ...eventPayload,
              ...(contextArchive
                ? {
                    contextArchive: {
                      version: 1,
                      sha256: contextArchive.archive.sha256,
                      byteLength: contextArchive.archive.byteLength,
                    },
                  }
                : {}),
            }),
            runId: task.runId,
            taskId,
            teamId,
          },
        });
        if (this.taskMetrics && task.run.taskExecutionId)
          await this.taskMetrics.ingest(
            tx,
            {
              teamId,
              taskExecutionId: task.run.taskExecutionId,
              ownerId: task.id,
              stage: "SPEC_EXECUTION",
              runId: task.runId,
              attemptNumber: task.attempt.number,
            },
            event,
          );
        if (contextArchive) {
          await tx.runStepContext.create({
            data: {
              id: String(input.event.payload.modelCallId),
              teamId,
              runId: task.runId,
              attemptId: task.attemptId,
              taskId,
              segmentId: String(input.event.payload.segmentId),
              step: Number(input.event.payload.step),
              model: String(input.event.payload.model),
              sequence: event.sequence,
              requestGzip: contextArchive.compressed,
              requestSha256: contextArchive.archive.sha256,
              requestBytes: contextArchive.archive.byteLength,
            },
          });
        }
        // Legacy execution.account.claim events remain audit-only.
        if (input.event.kind === "executor.accounts.request_rejected")
          this.metrics?.increment(
            "devproof_account_requirement_rejections_total",
            "Account requirement validation rejections.",
            { boundary: "executor", code: "ACCOUNT_REQUEST_INVALID" },
          );
        if (input.event.kind === "agent.model.failed") {
          const payload = input.event.payload;
          const preview =
            payload.inputPreview && typeof payload.inputPreview === "object"
              ? (payload.inputPreview as Record<string, unknown>)
              : {};
          const parsed = z
            .object({
              key: z.string().regex(/^[a-f0-9]{64}$/),
              until: z.number().int(),
              reason: z.enum([
                "MODEL_UNAVAILABLE",
                "CREDENTIAL_UNAVAILABLE",
                "MODEL_TIMEOUT",
              ]),
              consecutiveFailures: z.number().int().positive(),
            })
            .safeParse(preview.candidateHealth);
          if (
            parsed.success &&
            parsed.data.until > now.getTime() &&
            parsed.data.until <= now.getTime() + 30 * 60_000
          ) {
            const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
            const previous = snapshot.executionPolicy.modelCooldowns;
            const cooldowns =
              previous &&
              typeof previous === "object" &&
              !Array.isArray(previous)
                ? (previous as Record<string, unknown>)
                : {};
            const modelCooldowns = {
              ...Object.fromEntries(Object.entries(cooldowns).slice(-31)),
              [parsed.data.key]: {
                until: parsed.data.until,
                reason: parsed.data.reason,
                failures: parsed.data.consecutiveFailures,
              },
            };
            await tx.agentRuntimeTask.update({
              where: { id: task.id },
              data: {
                snapshot: json({
                  ...snapshot,
                  executionPolicy: {
                    ...snapshot.executionPolicy,
                    modelCooldowns,
                  },
                }),
              },
            });
          }
        }
        if (input.event.kind === "execution.checkpoint") {
          const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
          if (snapshot.criteria.some((c) => c.observationContract)) {
            if (!this.observationBindings)
              throw new ConflictException("CONTRACT_UNSUPPORTED");
            const progress = input.event.payload.verificationCheckpoint as
              | {
                  criteria?: unknown[];
                  bindingIds?: string[];
                  comparisonReviewIds?: string[];
                }
              | undefined;
            if (progress)
              await this.observationBindings.validateReferences(
                task,
                progress.bindingIds ?? [],
                progress.comparisonReviewIds ?? [],
                tx,
              );
            if (progress?.criteria)
              await this.observationBindings.validate(
                task,
                progress.criteria.map((c) =>
                  runtimeCriterionResultSchema.parse(c),
                ),
                tx,
              );
          }
        }
        const checkpointResult =
          input.event.kind === "execution.checkpoint"
            ? await saveExecutionCheckpoint(tx, task, input.event.payload)
            : {};
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
        return {
          accepted: true,
          sequence: event.sequence.toString(),
          ...checkpointResult,
        };
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
        await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
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
        const completedVerification =
          outcome.kind === "VERIFICATION_COMPLETED" ? outcome : null;
        let writeOutcomeUnknown = false;
        if (
          outcome.kind === "RETRYABLE_FAILURE" ||
          outcome.kind === "FATAL_FAILURE" ||
          (outcome.kind === "VERIFICATION_COMPLETED" &&
            outcome.termination !== undefined)
        ) {
          const session = await tx.browserRuntimeSession.findFirst({
            where: {
              browserExecutions: { some: { attemptId: task.attemptId } },
            },
          });
          const recovery = session
            ? await tx.runtimeSessionRecovery.findUnique({
                where: {
                  sessionId_expectedSessionFence: {
                    sessionId: session.id,
                    expectedSessionFence: session.fencingToken,
                  },
                },
              })
            : null;
          let uncertain = recovery
            ? !writeSettled(recovery.writeOutcomeState)
            : true;
          if (!recovery && session) {
            const identity = session.launchIdentity;
            const launchId =
              identity &&
              typeof identity === "object" &&
              !Array.isArray(identity) &&
              identity.version === 1 &&
              typeof identity.id === "string"
                ? identity.id
                : null;
            const auditedOwner =
              launchId &&
              session.launchIdentityVersion === 1 &&
              session.launchHostInstanceId &&
              session.launchConnectionGeneration !== null &&
              session.ownerTaskId === task.id &&
              session.ownerFencingToken === task.fencingToken;
            const launch = auditedOwner
              ? await tx.browserRuntimeCommand.findFirst({
                  where: {
                    sessionId: session.id,
                    commandType: "session.open",
                    source: "SYSTEM",
                    status: "SUCCEEDED",
                    leaseToken: session.leaseToken,
                    fencingToken: session.fencingToken,
                    payload: { path: ["launchIdentityId"], equals: launchId },
                  },
                  select: { id: true },
                })
              : null;
            if (launch) {
              // Empty command history is meaningful only for this audited new
              // launch and its still-authenticated owner, never for legacy recovery.
              const writes = await tx.browserRuntimeCommand.count({
                where: { sessionId: session.id, ...potentialWriteCommandWhere },
              });
              uncertain = writes > 0;
            }
          }
          if (uncertain) {
            writeOutcomeUnknown = true;
            const originalError =
              outcome.kind === "VERIFICATION_COMPLETED"
                ? {
                    code: outcome.termination!.reason,
                    failureClass: "TOOL_EXECUTION" as const,
                    message: outcome.summary,
                    phase: "browser_verification",
                  }
                : outcome.error;
            outcome = {
              kind: "FATAL_FAILURE",
              executionDisposition: "BLOCKED",
              error: {
                code: "WRITE_OUTCOME_UNKNOWN",
                failureClass: originalError.failureClass,
                message:
                  "Browser execution stopped after a possible write; reconcile the affected state before retrying.",
                phase: "browser_verification",
                details: {
                  originalError,
                  ...(completedVerification
                    ? {
                        verification: {
                          criteria: completedVerification.criteria,
                          verdict: completedVerification.verdict,
                          evidenceCatalog:
                            completedVerification.evidenceCatalog,
                        },
                      }
                    : {}),
                },
              },
              summary: `${originalError.message.slice(0, 7000)}\n写操作结果尚未确认，当前执行等待状态核对。`,
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
        // Preserve partial verification, but never present a lost session as a
        // completed product test or schedule an automatic replay of its writes.
        if (
          outcome.kind === "VERIFICATION_COMPLETED" &&
          outcome.termination?.reason === "RUNTIME_SESSION_UNAVAILABLE"
        ) {
          outcome = {
            kind: "FATAL_FAILURE",
            executionDisposition: "RUNTIME_LOST",
            error: {
              code: "RUNTIME_SESSION_UNAVAILABLE",
              failureClass: "RUNTIME_LOST",
              message: outcome.summary,
              phase: "browser_verification",
              details: {
                verification: {
                  criteria: outcome.criteria,
                  verdict: outcome.verdict,
                  evidenceCatalog: outcome.evidenceCatalog,
                },
              },
            },
            summary: outcome.summary,
          };
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

        if (completedVerification) {
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
          if (snapshot.criteria.some((c) => c.observationContract)) {
            if (!this.observationBindings)
              throw new ConflictException("CONTRACT_UNSUPPORTED");
            await this.observationBindings.validate(
              task,
              completedVerification.criteria,
              tx,
            );
          }
          const validationError = completedOutcomeEvidenceError(
            snapshot,
            completedVerification,
            persisted,
          );
          if (validationError) throw new ConflictException(validationError);
          if (completedVerification.evidenceCatalog) {
            const refs = persisted.map((e) => e.externalId).sort();
            completedVerification.evidenceCatalog.sealedAt = now.toISOString();
            completedVerification.evidenceCatalog.count = refs.length;
            completedVerification.evidenceCatalog.digest = createHash("sha256")
              .update(JSON.stringify(refs))
              .digest("hex");
          }
        }

        if (
          outcome.kind === "WAITING_HUMAN" &&
          runtimeTaskSnapshotSchema.parse(task.snapshot).executionPolicy
            .accountRequirements
        ) {
          const kindError = accountRequestKindError(
            outcome.intervention.kind,
            outcome.intervention.context,
            outcome.intervention.responseSchema,
          );
          if (kindError) {
            this.metrics?.increment(
              "devproof_account_requirement_rejections_total",
              "Account requirement validation rejections.",
              { boundary: "outcome_api", code: "ACCOUNT_KIND_INVALID" },
            );
            throw new BadRequestException({
              code: "ACCOUNT_REQUEST_INVALID",
              message: kindError,
            });
          }
        }
        if (
          outcome.kind === "WAITING_HUMAN" &&
          outcome.intervention.kind === "TEST_ACCOUNT"
        ) {
          const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
          if (snapshot.executionPolicy.accountRequirements) {
            try {
              const request = businessAccountRequestSchema.parse(
                outcome.intervention.context.accountRequest,
              );
              const stored =
                request.mode === "DISCOVERED"
                  ? await tx.runEvidence.findMany({
                      where: {
                        attemptId: task.attemptId,
                        runId: task.runId,
                        externalId: { in: request.observation.evidenceRefs },
                      },
                      include: {
                        runtimeArtifact: { include: { command: true } },
                      },
                    })
                  : [];
              const evidence = new Map(
                stored.map((item) => [
                  item.externalId,
                  {
                    kind: item.kind,
                    content:
                      request.mode === "DISCOVERED" &&
                      item.runtimeArtifact?.command?.ownerTaskId === task.id &&
                      containsAccountQuote(
                        item.runtimeArtifact.command.result,
                        request.observation.quote,
                      )
                        ? request.observation.quote
                        : "",
                  },
                ]),
              );
              const resolved = resolveBusinessAccountRequest(
                snapshot.executionPolicy,
                request,
                snapshot.criteria.map((c) => c.id),
                evidence,
              );
              outcome.intervention.context = {
                ...outcome.intervention.context,
                accountRequest: resolved.request,
                accountSlots: resolved.slots,
                purpose: "BUSINESS_TEST_SUBJECT",
                usage: resolved.slots.every(
                  (slot) => slot.usage === "READ_EXISTING",
                )
                  ? "READ_EXISTING"
                  : "CREATE_OR_MODIFY",
              };
              outcome.intervention.responseSchema = accountInputResponseSchema(
                resolved.slots,
              );
            } catch (error) {
              this.metrics?.increment(
                "devproof_account_requirement_rejections_total",
                "Account requirement validation rejections.",
                { boundary: "outcome_api", code: "ACCOUNT_REQUEST_INVALID" },
              );
              throw new BadRequestException({
                code: "ACCOUNT_REQUEST_INVALID",
                message:
                  error instanceof Error
                    ? error.message
                    : "业务账号用途校验失败。",
              });
            }
          }
        }
        if (
          outcome.kind === "WAITING_HUMAN" &&
          outcome.intervention.kind === "DATA_PRECONDITION"
        ) {
          const currentPolicy = runtimeTaskSnapshotSchema.parse(
            task.snapshot,
          ).executionPolicy;
          outcome.intervention.context.accountSlots = testAccountBindingsSchema
            .parse(currentPolicy.testAccounts ?? [])
            .map(({ slotId, label, usage, requiredTypes }) => ({
              slotId,
              label,
              usage,
              requiredTypes,
            }));
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

        if (completedVerification) {
          await persistCriterionResults(
            tx,
            runtimeTaskSnapshotSchema.parse(task.snapshot),
            completedVerification.criteria,
          );
          if (completedVerification.evidence.length > 0) {
            await tx.runEvidence.createMany({
              data: completedVerification.evidence.map((evidence) => ({
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
            // Write auditing may have converted verification to BLOCKED. Only
            // the projected outcome can carry a Run verdict; partial criteria
            // remain persisted separately for reconciliation.
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
              ...(completedVerification?.termination
                ? { termination: completedVerification.termination }
                : {}),
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
          ...(event.payload.progress?.meaningful
            ? {
                lastMeaningfulProgressKey: `${event.payload.segmentId}:${event.payload.progress.sequence}`,
              }
            : {}),
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
          // A failed response is latency telemetry, not progress that can buy
          // another deadline extension (nor evidence of an earlier success).
          lastModelCompletedAt:
            event.kind === "agent.model.completed" ? recordedAt : null,
          lastModelLatencyMs: durationMs,
          lastModelOperationKey:
            event.kind === "agent.model.completed"
              ? traceOperationKey(event.payload)
              : null,
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
          ...(event.kind === "agent.tool.completed" &&
          event.payload.status === "SUCCEEDED" &&
          event.payload.progress?.meaningful
            ? {
                lastMeaningfulProgressKey: `${event.payload.segmentId}:${event.payload.progress.sequence}`,
              }
            : {}),
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

/** A resumed task has no Agent lease yet, so normal lease expiry cannot find it. */
function unclaimableHumanResume(now: Date): Prisma.AgentRuntimeTaskWhereInput {
  return {
    status: "PENDING",
    startedAt: { not: null },
    recoveryStatus: null,
    run: {
      cancelRequestedAt: null,
      deadlineAt: { gt: now },
      lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
    },
    attempt: {
      browserExecution: {
        is: {
          runtimeSessionId: { not: null },
          runtimeSession: {
            is: {
              OR: [
                { status: { not: "ACTIVE" } },
                { quarantinedAt: { not: null } },
                { closureVerifiedAt: { not: null } },
                { leaseExpiresAt: { lte: now } },
                { executionPermitExpiresAt: null },
                { executionPermitExpiresAt: { lte: now } },
              ],
            },
          },
        },
      },
    },
  };
}

function staleLease() {
  return new ConflictException({
    code: "RUNTIME_LEASE_LOST",
    message: "The Runtime task lease is stale.",
  });
}

/** Checkpoints are diagnostic only: no criterion or write outcome is accepted here. */
export function readFinalizationCheckpoint(value: unknown, lostFence: bigint) {
  const parsed = z
    .object({
      fencingToken: z.literal(lostFence.toString()),
      reason: runtimeVerificationTerminationReasonSchema,
      pendingOutcome: runtimeOutcomeSchema,
    })
    .safeParse(value);
  if (!parsed.success) return null;
  const { pendingOutcome: outcome, reason } = parsed.data;
  if (
    outcome.kind === "VERIFICATION_COMPLETED" &&
    outcome.termination?.reason === reason
  )
    return { outcome, reason };
  if (
    outcome.kind === "FATAL_FAILURE" &&
    outcome.error.details.reason === reason
  )
    return { outcome, reason };
  return null;
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
  // The pg adapter replaces timestamptz offsets with UTC without shifting the
  // clock value. Normalize in PostgreSQL before decoding lease/deadline times.
  const [row] = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  return row!.now;
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
  if (
    outcome.evidenceCatalog &&
    (outcome.evidenceCatalog.runId !== snapshot.runId ||
      outcome.evidenceCatalog.attemptId !== snapshot.attemptId)
  )
    return "Evidence catalog must belong to this attempt.";
  const criteria = new Map(
    snapshot.criteria.map((item) => [item.id, browserExecutionCriterion(item)]),
  );
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

/** Verify against the browser command persisted by the control plane, not Agent metadata. */
function containsAccountQuote(
  value: unknown,
  quote: string,
  depth = 0,
): boolean {
  if (depth > 20 || value == null) return false;
  if (typeof value === "string") return value.includes(quote);
  if (typeof value !== "object") return false;
  return (
    JSON.stringify(value, null, 2).includes(quote) ||
    Object.values(value).some((child) =>
      containsAccountQuote(child, quote, depth + 1),
    )
  );
}
