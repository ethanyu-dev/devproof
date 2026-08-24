import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { verificationRequestSchema } from "@devproof/contracts";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { ObservabilityService } from "../observability/observability.service.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";
import { ExecutionRunnerRegistry } from "./execution-runner-registry.service.js";

@Injectable()
export class VerificationCleanupWorker
  implements OnModuleInit, OnModuleDestroy
{
  private abandonedRunCursor: string | undefined;
  private readonly logger = new Logger(VerificationCleanupWorker.name);
  private timer?: NodeJS.Timeout;
  private cleaning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runners: ExecutionRunnerRegistry,
    @Optional() private readonly monitor?: WorkerMonitorService,
    @Optional() private readonly observability?: ObservabilityService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor?.register("verification-cleanup", 5_000);
    this.timer = setInterval(() => this.trigger(), 5_000);
    this.timer.unref();
    this.trigger();
  }

  private trigger() {
    const operation = () => this.sweep();
    const running = this.monitor
      ? this.monitor.run("verification-cleanup", operation)
      : operation();
    void running.catch((error: Error) => {
      this.logger.error(`Verification cleanup sweep failed: ${error.message}`);
    });
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      await this.convergeAbandonedRuns();
      const runs = await this.prisma.verificationRun.findMany({
        include: { runtimeSession: { select: { status: true } } },
        take: 20,
        where: {
          runtimeSessionId: { not: null },
          status: {
            in: ["PASSED", "FAILED", "INCONCLUSIVE", "CANCELLED", "TIMED_OUT"],
          },
          runtimeSession: {
            status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"] },
          },
        },
      });
      for (const run of runs) {
        await this.runners
          .get(run.runnerKind)
          .release(run.teamId, run.id)
          .catch((error: Error) =>
            this.logger.warn(
              `Cleanup for verification ${run.id} failed: ${error.message}`,
            ),
          );
      }
    } finally {
      this.cleaning = false;
    }
  }

  private async convergeAbandonedRuns() {
    const lostRuns = await this.prisma.verificationRun.findMany({
      include: { runtimeSession: { select: { status: true } } },
      take: 50,
      where: {
        status: { in: ["RUNNING", "WAITING_HUMAN"] },
        runtimeSession: { status: { in: ["FAILED", "LOST"] } },
      },
    });
    for (const run of lostRuns) {
      await this.convergeRun(run, false);
    }

    const runs = await this.prisma.verificationRun.findMany({
      include: { runtimeSession: { select: { status: true } } },
      orderBy: { id: "asc" },
      take: 50,
      where: {
        ...(this.abandonedRunCursor
          ? { id: { gt: this.abandonedRunCursor } }
          : {}),
        startedAt: { not: null },
        status: "RUNNING",
      },
    });
    this.abandonedRunCursor = runs.length === 50 ? runs.at(-1)?.id : undefined;
    for (const run of runs) {
      const request = verificationRequestSchema.parse(run.requestSnapshot);
      const timedOut = Boolean(
        run.startedAt &&
        run.startedAt.getTime() + request.execution.runTimeoutSeconds * 1_000 <=
          Date.now(),
      );
      if (!timedOut) continue;
      await this.convergeRun(run, true);
    }
  }

  private async convergeRun(
    run: {
      id: string;
      requestSnapshot: unknown;
      runnerKind: string;
      startedAt: Date | null;
      teamId: string;
      traceId: string;
    },
    timedOut: boolean,
  ) {
    const status = timedOut ? "TIMED_OUT" : "INCONCLUSIVE";
    const reason = timedOut ? "AGENT_RUN_TIMEOUT" : "SESSION_LOST";
    const finishedAt = new Date();
    const request = verificationRequestSchema.parse(run.requestSnapshot);
    const durationMs = run.startedAt
      ? Math.max(0, finishedAt.getTime() - run.startedAt.getTime())
      : null;
    const deadlineAt =
      timedOut && run.startedAt
        ? new Date(
            run.startedAt.getTime() +
              request.execution.runTimeoutSeconds * 1_000,
          )
        : null;
    const result = timedOut
      ? undefined
      : {
          criteria: request.acceptanceCriteria.map((criterion) => ({
            criterionId: criterion.id,
            evidenceRefs: [],
            status: "INCONCLUSIVE" as const,
            summary:
              "The Browser Runtime session was lost before this criterion could be verified.",
          })),
          evidenceRefs: [],
          summary:
            "Verification became inconclusive because the Browser Runtime session was lost.",
          verdict: "INCONCLUSIVE" as const,
        };
    const claimed = await this.prisma.verificationRun.updateMany({
      data: {
        error: {
          code: reason,
          message: timedOut
            ? "The Agent Run exceeded its configured execution timeout."
            : "The Browser Runtime session was lost.",
        },
        finishedAt,
        retentionUntil: new Date(
          finishedAt.getTime() +
            request.evidencePolicy.retentionDays * 86_400_000,
        ),
        ...(result ? { result } : {}),
        status,
      },
      where: {
        id: run.id,
        status: { in: ["RUNNING", "WAITING_HUMAN"] },
      },
    });
    if (claimed.count !== 1) return;
    await this.prisma.$transaction([
      this.prisma.verificationCheckpoint.updateMany({
        data: { status: timedOut ? "EXPIRED" : "CANCELLED" },
        where: { runId: run.id, status: "PENDING" },
      }),
      this.prisma.notificationOutbox.updateMany({
        data: { status: "CANCELLED" },
        where: {
          runId: run.id,
          status: { in: ["PENDING", "FAILED"] },
        },
      }),
      this.prisma.verificationEvent.create({
        data: {
          actor: "WORKER",
          ...(durationMs === null ? {} : { durationMs }),
          errorCode: reason,
          errorMessage: timedOut
            ? "The Agent Run exceeded its configured execution timeout."
            : "The Browser Runtime session was lost.",
          kind: timedOut ? "verification.timed_out" : "execution.lost",
          payload: { reason },
          status: timedOut ? "TIMED_OUT" : "FAILED",
          traceId: run.traceId,
          runId: run.id,
          teamId: run.teamId,
        },
      }),
    ]);
    this.observability?.log(
      "warn",
      timedOut ? "verification.run.timed_out" : "verification.execution.lost",
      {
        deadlineAt: deadlineAt?.toISOString() ?? null,
        durationMs,
        finishedAt: finishedAt.toISOString(),
        reason,
        runId: run.id,
        runTimeoutSeconds: request.execution.runTimeoutSeconds,
        startedAt: run.startedAt?.toISOString() ?? null,
        traceId: run.traceId,
      },
    );
    await this.runners
      .get(run.runnerKind)
      .release(run.teamId, run.id)
      .catch((error: Error) =>
        this.logger.warn(
          `Compensating release for verification ${run.id} failed: ${error.message}`,
        ),
      );
  }
}
