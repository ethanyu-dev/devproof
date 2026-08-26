import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { verificationRequestSchema } from "@devproof/contracts";

import { PrismaService } from "../database/prisma.service.js";
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly browser: BrowserExecutionRunner,
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
      orderBy: { createdAt: "asc" },
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
      const result = await this.prisma.browserExecution.updateMany({
        data: {
          admissionAttempts: { increment: 1 },
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
      if (result.count === 1) claimed.push(item.execution);
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
            )
          : Promise.resolve(),
      ),
    );
    return claimed.length;
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
      );
    } catch (error) {
      if (!(error instanceof ExecutionRunnerUnavailableError)) {
        await this.defer(execution.id, "ADMISSION_ERROR", errorMessage(error));
        return;
      }
      availabilityPolicy =
        error.availabilityPolicyOverride ?? availabilityPolicy;
      if (availabilityPolicy === "FAIL_FAST") {
        await this.fail(execution, error.reason, error.message);
        return;
      }
      await this.defer(execution.id, error.reason, error.message);
    }
  }

  private async defer(id: string, code: string, message: string) {
    await this.prisma.browserExecution.updateMany({
      data: {
        error: json({ code, message }),
        nextAdmissionAt: new Date(Date.now() + RETRY_DELAY_MS),
        status: "WAITING_CAPACITY",
      },
      where: { id, status: { in: ["ALLOCATING", "WAITING_CAPACITY"] } },
    });
  }

  private async fail(
    execution: {
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
      await tx.browserExecution.update({
        data: {
          error: json({ code, message }),
          finishedAt: now,
          nextAdmissionAt: null,
          status: "FAILED",
        },
        where: { id: execution.id },
      });
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
