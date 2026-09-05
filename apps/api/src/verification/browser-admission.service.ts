import { Injectable, Logger, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { verificationRequestSchema } from "@devproof/contracts";

import { env } from "../config/env.js";
import { SessionRecoveryService } from "../runtime/session-recovery.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  quarantineSession,
  releaseVerifiedSessionResources,
} from "../runtime/session-resource-cleanup.js";
import { BrowserExecutionRunner } from "./browser-execution-runner.service.js";
import { matchingRuntimeRoutingRule } from "./runtime-routing.js";
import { ExecutionRunnerUnavailableError } from "./runtime-adapters.js";

const RETRY_DELAY_MS = 2_000;
const ALLOCATION_STALE_MS = 120_000;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

@Injectable()
export class BrowserAdmissionService {
  private readonly logger = new Logger(BrowserAdmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly browser: BrowserExecutionRunner,
    @Optional() private readonly recovery?: SessionRecoveryService,
  ) {}

  async reconcile(limit = 100) {
    const now = new Date();
    await this.recoverLegacyExecutions(now, limit * 4);
    const candidates = await this.prisma.browserExecution.findMany({
      include: {
        run: {
          select: {
            deadlineAt: true,
            goal: true,
            lifecycle: true,
            taskExecutionId: true,
            teamId: true,
          },
        },
      },
      // Rotate readiness evaluation through the complete backlog. Repeated
      // upstream waits must not consume every candidate in a bounded sweep.
      // Original createdAt/waitingSince still determine data-writer priority.
      orderBy: [
        { nextAdmissionAt: { sort: "asc", nulls: "first" } },
        { createdAt: "asc" },
      ],
      where: {
        run: {
          cancelRequestedAt: null,
          deadlineAt: { gt: now },
          lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
        },
        OR: [
          { status: "REQUESTED" },
          {
            nextAdmissionAt: { lte: now },
            status: "WAITING_CAPACITY",
          },
          {
            status: "ALLOCATING",
            updatedAt: {
              lt: new Date(now.getTime() - ALLOCATION_STALE_MS),
            },
          },
        ],
      },
    });
    const rules = await this.prisma.runtimeRoutingRule.findMany({
      where: {
        enabled: true,
        teamId: { in: [...new Set(candidates.map((item) => item.run.teamId))] },
      },
    });
    const rulesByTeam = new Map<string, typeof rules>();
    for (const rule of rules) {
      const teamRules = rulesByTeam.get(rule.teamId) ?? [];
      teamRules.push(rule);
      rulesByTeam.set(rule.teamId, teamRules);
    }
    const ordered = fairAdmissionOrder(
      candidates.map((execution) => {
        const input = record(execution.input);
        const hostname = targetHostname(input.targetUrl);
        const rule = hostname
          ? matchingRuntimeRoutingRule(
              hostname,
              rulesByTeam.get(execution.run.teamId) ?? [],
            )
          : undefined;
        return { execution, rule };
      }),
    ).slice(0, limit);

    const claimed: typeof candidates = [];
    for (const item of ordered) {
      const allocationStartedAt = new Date();
      const allocationToken = randomUUID();
      const result = await this.prisma.browserExecution.updateMany({
        data: {
          admissionAttempts: { increment: 1 },
          allocationToken,
          nextAdmissionAt: allocationStartedAt,
          routingKey: item.rule
            ? `runtime:${item.rule.runtimeId}`
            : "pool:flexible",
          routingRuleId: item.rule?.id ?? null,
          status: "ALLOCATING",
          targetRuntimeId: item.rule?.runtimeId ?? null,
          waitingSince: item.execution.waitingSince ?? allocationStartedAt,
        },
        where: {
          id: item.execution.id,
          status: item.execution.status,
          updatedAt: item.execution.updatedAt,
        },
      });
      if (result.count === 1)
        claimed.push({ ...item.execution, allocationToken });
    }
    const allocations = await Promise.allSettled(
      claimed.map((execution) => this.allocate(execution)),
    );
    await Promise.all(
      allocations.map((allocation, index) =>
        allocation.status === "rejected" && claimed[index]
          ? this.defer(
              claimed[index].id,
              "ADMISSION_ERROR",
              errorMessage(allocation.reason),
              claimed[index].allocationToken,
            )
          : Promise.resolve(),
      ),
    );
    // Dispatch unrelated work before waiting for a quarantined browser to close.
    await this.recoverStartupExecutions(new Date(), Math.min(limit, 8));
    return claimed.length;
  }

  /** Recover browsers whose bounded startup permit expired before their first claim. */
  async recoverStartupExecutions(now = new Date(), limit = 8) {
    const tasks = await this.prisma.agentRuntimeTask.findMany({
      include: { run: true, attempt: { include: { browserExecution: true } } },
      orderBy: { createdAt: "asc" },
      take: limit,
      where: {
        status: "PENDING",
        startedAt: null,
        fencingToken: 0n,
        OR: [
          { recoveryNextAttemptAt: null },
          { recoveryNextAttemptAt: { lte: now } },
        ],
        run: {
          cancelRequestedAt: null,
          deadlineAt: { gt: now },
          lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
        },
        attempt: {
          browserExecution: {
            is: {
              runtimeSessionId: { not: null },
              OR: [
                { status: { not: "WAITING_CAPACITY" } },
                { runtimeSession: { is: { closureVerifiedAt: null } } },
              ],
              runtimeSession: {
                is: {
                  ownerTaskId: null,
                  OR: [
                    {
                      status: { notIn: ["ACTIVE", "OPENING", "HUMAN_CONTROL"] },
                    },
                    { quarantinedAt: { not: null } },
                    { closureVerifiedAt: { not: null } },
                    { leaseExpiresAt: { lte: now } },
                    {
                      status: { in: ["ACTIVE", "OPENING"] },
                      OR: [
                        { executionPermitExpiresAt: null },
                        { executionPermitExpiresAt: { lte: now } },
                      ],
                    },
                    {
                      status: "HUMAN_CONTROL",
                      OR: [
                        { humanControlExpiresAt: null },
                        { humanControlExpiresAt: { lte: now } },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    const results = await Promise.allSettled(
      tasks.map(async (task) => {
        const execution = task.attempt.browserExecution!;
        const sessionId = execution.runtimeSessionId!;
        // This reservation outlives session.close's timeout. A crashed reconciler
        // can retry closure, but cannot create another browser until closure proof.
        const retryAt = new Date(now.getTime() + 90_000);
        const reserved = await this.prisma.$transaction(async (tx) => {
          await acquireAdvisoryTransactionLock(
            tx,
            "browser-execution-resources",
          );
          // Serialize against claim before invalidating the browser or its permit.
          const lock = await tx.agentRuntimeTask.updateMany({
            where: {
              id: task.id,
              status: "PENDING",
              startedAt: null,
              fencingToken: 0n,
              OR: [
                { recoveryNextAttemptAt: null },
                { recoveryNextAttemptAt: { lte: now } },
              ],
            },
            data: {
              recoveryStatus: "STARTUP_CLOSING",
              recoveryNextAttemptAt: retryAt,
            },
          });
          if (lock.count !== 1) return false;
          const currentExecution = await tx.browserExecution.findUnique({
            where: { id: execution.id },
          });
          const session = await tx.browserRuntimeSession.findUnique({
            where: { id: sessionId },
          });
          const permitExpiresAt =
            session?.status === "HUMAN_CONTROL"
              ? session.humanControlExpiresAt
              : session?.executionPermitExpiresAt;
          if (
            currentExecution?.runtimeSessionId !== sessionId ||
            !session ||
            session.ownerTaskId ||
            (["ACTIVE", "OPENING", "HUMAN_CONTROL"].includes(session.status) &&
              !session.quarantinedAt &&
              !session.closureVerifiedAt &&
              session.leaseExpiresAt > now &&
              permitExpiresAt &&
              permitExpiresAt > now)
          ) {
            await tx.agentRuntimeTask.update({
              where: { id: task.id },
              data: { recoveryStatus: null, recoveryNextAttemptAt: null },
            });
            return false;
          }
          // Console takeover can race the scan without touching the Agent row.
          // Lock the exact observed permit before quarantine; a renewed human
          // window or changed binding is re-evaluated by the next sweep.
          const sessionLock = await tx.browserRuntimeSession.updateMany({
            where: {
              id: sessionId,
              ownerTaskId: null,
              status: session.status,
              controlGeneration: session.controlGeneration,
              executionPermitExpiresAt: session.executionPermitExpiresAt,
              humanControlExpiresAt: session.humanControlExpiresAt,
              closureVerifiedAt: session.closureVerifiedAt,
            },
            data: { status: session.status },
          });
          if (sessionLock.count !== 1) {
            await tx.agentRuntimeTask.update({
              where: { id: task.id },
              data: { recoveryStatus: null, recoveryNextAttemptAt: null },
            });
            return false;
          }
          await quarantineSession(tx, sessionId, "STARTUP_PERMIT_EXPIRED");
          await tx.browserExecution.updateMany({
            where: { id: execution.id, runtimeSessionId: sessionId },
            data: {
              status: "LOST",
              nextAdmissionAt: null,
              error: {
                code: "LEASE_RECOVERY",
                message:
                  "The unclaimed browser must close before startup recovery.",
              },
            },
          });
          await tx.taskCaseExecution.updateMany({
            where: { runId: task.runId },
            data: {
              scheduling: {
                state: "RECOVERING",
                reason: "LEASE_RECOVERY",
                waitingSince: (
                  execution.waitingSince ?? execution.createdAt
                ).toISOString(),
                evaluatedAt: now.toISOString(),
                blockedBy: { resourceType: "SESSION", sessionId },
                queue: null,
                nextRetryAt: retryAt.toISOString(),
              },
            },
          });
          if (task.run.taskExecutionId)
            await tx.taskExecution.updateMany({
              where: { id: task.run.taskExecutionId },
              data: { projectionNeededAt: now },
            });
          return true;
        });
        if (!reserved) return;
        await this.browser
          .releaseForExecutionRun(task.run.teamId, execution.id)
          .catch(() => undefined);
        await this.prisma.$transaction(async (tx) => {
          await acquireAdvisoryTransactionLock(
            tx,
            "browser-execution-resources",
          );
          const session = await tx.browserRuntimeSession.findUnique({
            where: { id: sessionId },
          });
          if (
            !session?.closureVerifiedAt ||
            !session.closureEvidenceId ||
            session.ownerTaskId
          )
            return;
          const recovered = await tx.agentRuntimeTask.updateMany({
            where: {
              id: task.id,
              status: "PENDING",
              startedAt: null,
              fencingToken: 0n,
              recoveryStatus: "STARTUP_CLOSING",
              recoveryNextAttemptAt: retryAt,
            },
            data: { recoveryStatus: null, recoveryNextAttemptAt: null },
          });
          if (recovered.count !== 1) return;
          await releaseVerifiedSessionResources(tx, sessionId);
          const changed = await tx.browserExecution.updateMany({
            where: {
              id: execution.id,
              runtimeSessionId: sessionId,
              run: {
                cancelRequestedAt: null,
                deadlineAt: { gt: new Date() },
                lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
              },
            },
            data: {
              status: "WAITING_CAPACITY",
              allocationToken: randomUUID(),
              nextAdmissionAt: new Date(),
              finishedAt: null,
              error: {
                code: "LEASE_RECOVERY",
                message:
                  "The expired startup browser is closed; bounded re-admission is ready.",
              },
            },
          });
          if (changed.count !== 1) return;
          await tx.runEvent.create({
            data: {
              actor: "CONTROL_PLANE",
              attemptId: task.attemptId,
              runId: task.runId,
              teamId: task.run.teamId,
              taskId: task.id,
              kind: "browser.startup_recovery.ready",
              payload: {
                sessionId,
                startupRecoveryCount: execution.startupRecoveryCount,
              },
            },
          });
          if (task.run.taskExecutionId)
            await tx.taskExecution.updateMany({
              where: { id: task.run.taskExecutionId },
              data: { projectionNeededAt: new Date() },
            });
        });
      }),
    );
    for (const result of results)
      if (result.status === "rejected") {
        this.logger.warn(
          `Browser startup recovery will retry: ${errorMessage(result.reason)}`,
        );
      }
  }

  private async recoverLegacyExecutions(now: Date, limit: number) {
    const tasks = await this.prisma.agentRuntimeTask.findMany({
      include: {
        run: { select: { environmentSnapshot: true, executionPolicy: true } },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      where: {
        attempt: {
          browserExecution: { is: null },
          status: { in: ["PENDING", "RUNNING"] },
        },
        capability: "BROWSER_VERIFICATION",
        run: {
          cancelRequestedAt: null,
          deadlineAt: { gt: now },
          lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
        },
        OR: [
          { status: "PENDING" },
          { leaseExpiresAt: { lt: now }, status: "RUNNING" },
        ],
      },
    });
    if (!tasks.length) return;
    await this.prisma.browserExecution.createMany({
      data: tasks.map((task) => {
        const policy = record(task.run.executionPolicy);
        const browser = record(policy.browser);
        const environment = record(task.run.environmentSnapshot);
        return {
          attemptId: task.attemptId,
          input: json({
            availabilityPolicy:
              browser.availabilityPolicy === "FAIL_FAST" ? "FAIL_FAST" : "WAIT",
            profile: browser.profile ?? { mode: "EPHEMERAL" },
            requiredCapabilities: Array.isArray(browser.requiredCapabilities)
              ? browser.requiredCapabilities
              : ["browser"],
            ...(typeof environment.targetUrl === "string"
              ? { targetUrl: environment.targetUrl }
              : {}),
          }),
          runId: task.runId,
          status: "REQUESTED" as const,
        };
      }),
      skipDuplicates: true,
    });
  }

  private async allocate(execution: {
    allocationToken: string | null;
    attemptId: string;
    id: string;
    input: Prisma.JsonValue;
    run: {
      deadlineAt: Date;
      goal: string;
      lifecycle: string;
      taskExecutionId: string | null;
      teamId: string;
    };
    runId: string;
  }) {
    let availabilityPolicy: "FAIL_FAST" | "WAIT" = "WAIT";
    try {
      const input = record(execution.input);
      availabilityPolicy =
        input.availabilityPolicy === "FAIL_FAST" ? "FAIL_FAST" : "WAIT";
      const request = verificationRequestSchema.parse({
        acceptanceCriteria: [
          {
            description: "Execute the admitted browser verification Run.",
            id: "run-v2-browser-execution",
            required: true,
          },
        ],
        agentRuntime: { metadata: {}, provider: "GENERIC" },
        evidencePolicy: { requiredKinds: [], retentionDays: 90 },
        execution: {
          acquireTimeoutSeconds: 300,
          availabilityPolicy,
          profile: input.profile ?? { mode: "EPHEMERAL" },
          requiredCapabilities: input.requiredCapabilities ?? ["browser"],
          runTimeoutSeconds: Math.min(
            86_400,
            Math.max(
              120,
              Math.floor(
                (execution.run.deadlineAt.getTime() - Date.now()) / 1_000,
              ),
            ),
          ),
          ...(typeof input.targetUrl === "string"
            ? { targetUrl: input.targetUrl }
            : {}),
        },
        goal: execution.run.goal.slice(0, 8_000),
        idempotencyKey: `admission-${execution.id}`,
        inputs: {},
        mode: "TEST",
        schemaVersion: 1,
        secretRefs: {},
      });
      await this.browser.acquireForExecutionRun(
        execution.run.teamId,
        execution.id,
        request,
        execution.allocationToken ?? undefined,
      );
    } catch (error) {
      if (!(error instanceof ExecutionRunnerUnavailableError)) {
        await this.defer(
          execution.id,
          "ADMISSION_ERROR",
          errorMessage(error),
          execution.allocationToken,
        );
        return;
      }
      availabilityPolicy =
        error.availabilityPolicyOverride ?? availabilityPolicy;
      if (availabilityPolicy === "FAIL_FAST") {
        await this.fail(execution, error.reason, error.message);
        return;
      }
      let reason = error.reason;
      let message = error.message;
      let blockedBy = error.blockedBy;
      if (
        blockedBy?.sessionId &&
        this.recovery &&
        env().RUNTIME_SESSION_RECOVERY_ENABLED &&
        ["DATA_LOCK", "LEASE_RECOVERY"].includes(reason)
      ) {
        try {
          const recovery = await this.recovery.request(
            blockedBy.sessionId,
            "ADMISSION_BLOCKED",
          );
          if (recovery.closureState !== "OBSERVED" && !recovery.resolvedAt) {
            reason = "LEASE_RECOVERY";
            message =
              recovery.closureState === "VERIFIED"
                ? "The previous browser is closed; its business write outcome still needs review."
                : "The previous browser requires verified session recovery before this execution can start.";
            blockedBy = {
              ...blockedBy,
              recoveryId: recovery.id,
              recoveryPhase: recovery.closureState,
              rootReason: error.reason,
            };
          }
        } catch (cause) {
          this.logger.warn(
            `Could not record browser recovery for admission ${execution.id}: ${errorMessage(cause)}`,
          );
        }
      }
      await this.defer(
        execution.id,
        reason,
        message,
        execution.allocationToken,
        blockedBy,
      );
    }
  }

  private async defer(
    id: string,
    code: string,
    message: string,
    allocationToken: string | null,
    blockedBy?: ExecutionRunnerUnavailableError["blockedBy"],
  ) {
    await this.prisma.$transaction(async (tx) => {
      if (blockedBy?.recoveryId)
        await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      const now = new Date();
      const attempts =
        code === "LEASE_RECOVERY"
          ? await tx.browserExecution.findUnique({
              where: { id },
              select: { admissionAttempts: true },
            })
          : null;
      const recovery = blockedBy?.recoveryId
        ? await tx.runtimeSessionRecovery.findUnique({
            where: { id: blockedBy.recoveryId },
            select: { resolvedAt: true },
          })
        : null;
      const retryDelayMs = recovery?.resolvedAt
        ? 0
        : code === "LEASE_RECOVERY"
          ? [5_000, 15_000, 30_000, 60_000][
              Math.min(3, Math.max(0, (attempts?.admissionAttempts ?? 1) - 1))
            ]!
          : RETRY_DELAY_MS;
      const changed = await tx.browserExecution.updateMany({
        data: {
          error: json({ code, message, ...(blockedBy ? { blockedBy } : {}) }),
          blockingRecoveryId: blockedBy?.recoveryId ?? null,
          nextAdmissionAt: new Date(now.getTime() + retryDelayMs),
          status: "WAITING_CAPACITY",
        },
        where: {
          id,
          allocationToken,
          status: { in: ["ALLOCATING", "WAITING_CAPACITY"] },
          run: {
            cancelRequestedAt: null,
            deadlineAt: { gt: now },
            lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
          },
        },
      });
      if (changed.count !== 1) return;
      const execution = await tx.browserExecution.findUnique({
        where: { id },
        include: {
          run: {
            select: {
              taskExecutionId: true,
              taskCaseExecution: { select: { id: true, scheduling: true } },
            },
          },
        },
      });
      if (execution?.run.taskExecutionId && execution.run.taskCaseExecution) {
        const current = record(execution.run.taskCaseExecution.scheduling);
        const reason =
          code === "NO_AVAILABLE_SLOT"
            ? "RUNTIME_CAPACITY"
            : code === "IDENTITY_CAPACITY"
              ? "IDENTITY_LIMIT"
              : code === "NO_MATCHING_RUNNER"
                ? "RUNTIME_OFFLINE"
                : code;
        await tx.taskCaseExecution.update({
          where: { id: execution.run.taskCaseExecution.id },
          data: {
            scheduling: json({
              state: reason === "LEASE_RECOVERY" ? "RECOVERING" : "WAITING",
              reason,
              waitingSince:
                typeof current.waitingSince === "string"
                  ? current.waitingSince
                  : (
                      execution.waitingSince ?? execution.createdAt
                    ).toISOString(),
              evaluatedAt: now.toISOString(),
              blockedBy: blockedBy ?? null,
              queue: null,
              nextRetryAt: new Date(now.getTime() + retryDelayMs).toISOString(),
            }),
          },
        });
        await tx.taskExecution.updateMany({
          where: { id: execution.run.taskExecutionId },
          data: { projectionNeededAt: now },
        });
      }
    });
  }

  private async fail(
    execution: {
      allocationToken: string | null;
      attemptId: string;
      id: string;
      run: { taskExecutionId: string | null; teamId: string };
      runId: string;
    },
    code: string,
    message: string,
  ) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.browserExecution.updateMany({
        data: {
          error: json({ code, message }),
          finishedAt: now,
          nextAdmissionAt: null,
          status: "FAILED",
        },
        where: {
          id: execution.id,
          allocationToken: execution.allocationToken,
          status: { in: ["ALLOCATING", "WAITING_CAPACITY"] },
          run: {
            cancelRequestedAt: null,
            lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
          },
        },
      });
      if (changed.count !== 1) return;
      await tx.agentRuntimeTask.updateMany({
        data: {
          error: json({ code, message }),
          finishedAt: now,
          status: "FAILED",
        },
        where: { attemptId: execution.attemptId, status: "PENDING" },
      });
      await tx.runAttempt.updateMany({
        data: {
          error: json({ code, message }),
          failureClass: "BROWSER_RUNTIME",
          finishedAt: now,
          status: "FAILED",
        },
        where: { id: execution.attemptId, status: "PENDING" },
      });
      await tx.executionRun.updateMany({
        data: {
          executionDisposition: "BROWSER_UNAVAILABLE",
          finishedAt: now,
          lifecycle: "COMPLETED",
          verdict: null,
        },
        where: {
          id: execution.runId,
          lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
        },
      });
      if (execution.run.taskExecutionId) {
        await tx.taskExecution.update({
          data: { projectionNeededAt: now },
          where: { id: execution.run.taskExecutionId },
        });
      }
      await tx.runEvent.create({
        data: {
          actor: "CONTROL_PLANE",
          attemptId: execution.attemptId,
          kind: "browser.admission.failed",
          payload: json({ code, message }),
          runId: execution.runId,
          teamId: execution.run.teamId,
        },
      });
    });
  }
}

export function fairAdmissionOrder<
  T extends {
    execution: {
      createdAt: Date;
      id: string;
      run: { taskExecutionId: string | null };
    };
    rule: { id: string; runtimeId: string } | undefined;
  },
>(items: readonly T[]) {
  const queues = new Map<string, T[]>();
  for (const item of items) {
    const queueKey = item.rule
      ? `runtime:${item.rule.runtimeId}`
      : "pool:flexible";
    const queue = queues.get(queueKey) ?? [];
    queue.push(item);
    queues.set(queueKey, queue);
  }
  const fairQueues = new Map(
    [...queues].map(([queueKey, queue]) => {
      const groups = new Map<string, T[]>();
      for (const item of queue) {
        const key = item.execution.run.taskExecutionId ?? item.execution.id;
        const group = groups.get(key) ?? [];
        group.push(item);
        groups.set(key, group);
      }
      const ordered: T[] = [];
      while (groups.size) {
        for (const [key, group] of groups) {
          const item = group.shift();
          if (item) ordered.push(item);
          if (!group.length) groups.delete(key);
        }
      }
      return [queueKey, ordered] as const;
    }),
  );
  const ordered: T[] = [];
  while (fairQueues.size) {
    for (const [queueKey, queue] of fairQueues) {
      const item = queue.shift();
      if (item) ordered.push(item);
      if (!queue.length) fairQueues.delete(queueKey);
    }
  }
  return ordered;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function targetHostname(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return null;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
