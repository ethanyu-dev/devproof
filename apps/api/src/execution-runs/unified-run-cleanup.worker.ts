import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { runHitlPolicySchema } from "@devproof/contracts";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";
import { BrowserExecutionRunner } from "../verification/browser-execution-runner.service.js";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

@Injectable()
export class UnifiedRunCleanupWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UnifiedRunCleanupWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly browser: BrowserExecutionRunner,
    @Optional() private readonly monitor?: WorkerMonitorService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor?.register("unified-run-cleanup", 5_000);
    this.timer = setInterval(() => this.trigger(), 5_000);
    this.timer.unref();
    this.trigger();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.expireInterventions();
      await this.expireRuns();
      const executions = await this.prisma.browserExecution.findMany({
        include: { run: { select: { lifecycle: true, teamId: true } } },
        take: 20,
        where: {
          status: {
            in: [
              "REQUESTED",
              "WAITING_CAPACITY",
              "ACTIVE",
              "HUMAN_CONTROL",
              "RELEASING",
              "FAILED",
            ],
          },
          run: { lifecycle: { in: ["COMPLETED", "CANCELLED", "TIMED_OUT"] } },
        },
      });
      for (const execution of executions) {
        await this.browser
          .releaseForExecutionRun(execution.run.teamId, execution.id)
          .catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }

  private trigger() {
    const operation = () => this.tick();
    const running = this.monitor
      ? this.monitor.run("unified-run-cleanup", operation)
      : operation();
    void running.catch((error: Error) => {
      this.logger.error(`Unified Run cleanup failed: ${error.message}`);
    });
  }

  private async expireInterventions() {
    const interventions = await this.prisma.humanIntervention.findMany({
      include: { run: true },
      take: 50,
      where: {
        expiresAt: { lte: new Date() },
        status: "PENDING",
      },
    });
    for (const intervention of interventions) {
      const rawPolicy = isRecord(intervention.run.executionPolicy)
        ? intervention.run.executionPolicy.hitl
        : undefined;
      const policy = runHitlPolicySchema.parse(rawPolicy ?? {});
      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        const cancelled = policy.onTimeout === "CANCEL";
        const runClaim = await tx.executionRun.updateMany({
          data: {
            ...(cancelled ? { cancelRequestedAt: now } : {}),
            executionDisposition: intervention.run.startedAt
              ? "BLOCKED"
              : "NOT_RUN",
            finishedAt: now,
            lifecycle: cancelled ? "CANCELLED" : "COMPLETED",
            verdict: null,
          },
          where: { id: intervention.runId, lifecycle: "WAITING_HUMAN" },
        });
        if (runClaim.count !== 1) {
          await tx.humanIntervention.updateMany({
            data: { resolvedAt: now, status: "EXPIRED" },
            where: {
              expiresAt: { lte: now },
              id: intervention.id,
              status: "PENDING",
            },
          });
          return;
        }
        const interventionClaim = await tx.humanIntervention.updateMany({
          data: { resolvedAt: now, status: "EXPIRED" },
          where: {
            expiresAt: { lte: now },
            id: intervention.id,
            status: "PENDING",
          },
        });
        if (interventionClaim.count !== 1) {
          throw new Error("Human intervention expiry claim was lost.");
        }
        await tx.agentRuntimeTask.updateMany({
          data: {
            cancelRequestedAt: cancelled ? now : null,
            error: json({
              code: "HITL_TIMEOUT",
              message: "Human intervention timed out.",
              onTimeout: policy.onTimeout,
            }),
            finishedAt: now,
            status: cancelled ? "CANCELLED" : "FAILED",
          },
          where: {
            id: intervention.taskId,
            status: "WAITING_HUMAN",
          },
        });
        await tx.runAttempt.updateMany({
          data: {
            error: json({
              code: "HITL_TIMEOUT",
              message: "Human intervention timed out.",
              onTimeout: policy.onTimeout,
            }),
            failureClass: "TIMEOUT",
            finishedAt: now,
            status: cancelled ? "CANCELLED" : "TIMED_OUT",
          },
          where: {
            id: intervention.attemptId,
            status: "WAITING_HUMAN",
          },
        });
        await tx.runEvent.create({
          data: {
            actor: "SYSTEM",
            attemptId: intervention.attemptId,
            kind: "human.intervention.expired",
            payload: json({
              interventionId: intervention.id,
              onTimeout: policy.onTimeout,
            }),
            runId: intervention.runId,
            taskId: intervention.taskId,
            teamId: intervention.teamId,
          },
        });
        if (policy.notificationChannels.includes("FEISHU")) {
          await tx.notificationOutbox.create({
            data: {
              channel: "FEISHU",
              dedupeKey: `run:${intervention.runId}:intervention:${intervention.id}:expired:feishu`,
              eventType: "hitl.expired",
              executionRunId: intervention.runId,
              interventionId: intervention.id,
              payload: json({
                expiredAt: now.toISOString(),
                interventionId: intervention.id,
                notificationKind: "HITL_EXPIRED",
                onTimeout: policy.onTimeout,
                runId: intervention.runId,
                runKind: "EXECUTION_RUN",
              }),
              teamId: intervention.teamId,
            },
          });
        }
      });
    }
  }

  private async expireRuns() {
    const now = new Date();
    const expired = await this.prisma.executionRun.findMany({
      select: { id: true, startedAt: true, teamId: true },
      take: 50,
      where: {
        deadlineAt: { lte: now },
        lifecycle: {
          in: ["QUEUED", "PREPARING", "RUNNING", "WAITING_HUMAN"],
        },
      },
    });
    for (const run of expired) {
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.executionRun.updateMany({
          data: {
            executionDisposition: run.startedAt ? "BLOCKED" : "NOT_RUN",
            finishedAt: now,
            lifecycle: "TIMED_OUT",
            verdict: null,
          },
          where: {
            deadlineAt: { lte: now },
            id: run.id,
            lifecycle: {
              in: ["QUEUED", "PREPARING", "RUNNING", "WAITING_HUMAN"],
            },
          },
        });
        if (changed.count !== 1) return;
        await tx.agentRuntimeTask.updateMany({
          data: {
            cancelRequestedAt: now,
            error: json({ code: "RUN_DEADLINE_EXCEEDED" }),
            finishedAt: now,
            status: "TIMED_OUT",
          },
          where: {
            runId: run.id,
            status: { in: ["PENDING", "RUNNING", "WAITING_HUMAN"] },
          },
        });
        await tx.runAttempt.updateMany({
          data: {
            error: json({ code: "RUN_DEADLINE_EXCEEDED" }),
            failureClass: "TIMEOUT",
            finishedAt: now,
            status: "TIMED_OUT",
          },
          where: {
            runId: run.id,
            status: { in: ["PENDING", "RUNNING", "WAITING_HUMAN"] },
          },
        });
        await tx.humanIntervention.updateMany({
          data: { resolvedAt: now, status: "EXPIRED" },
          where: { runId: run.id, status: "PENDING" },
        });
        await tx.runEvent.create({
          data: {
            actor: "CONTROL_PLANE",
            kind: "run.timed_out",
            payload: json({ reason: "RUN_DEADLINE_EXCEEDED" }),
            runId: run.id,
            teamId: run.teamId,
          },
        });
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
