import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { ObservabilityService } from "../observability/observability.service.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";
import { VerificationLifecycleService } from "./verification-lifecycle.service.js";

@Injectable()
export class VerificationExecutionWaitSweeper
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(VerificationExecutionWaitSweeper.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: VerificationLifecycleService,
    @Optional() private readonly monitor?: WorkerMonitorService,
    @Optional() private readonly observability?: ObservabilityService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor?.register("execution-wait-sweeper", 5_000);
    this.timer = setInterval(() => this.trigger(), 5_000);
    this.timer.unref();
    this.trigger();
  }

  private trigger() {
    const operation = () => this.sweep();
    const running = this.monitor
      ? this.monitor.run("execution-wait-sweeper", operation)
      : operation();
    void running.catch((error: Error) => {
      this.logger.error(`Execution wait sweep failed: ${error.message}`);
    });
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const expired = await this.prisma.verificationRun.findMany({
        select: {
          executionAcquireDeadlineAt: true,
          id: true,
          teamId: true,
          traceId: true,
        },
        take: 100,
        where: {
          executionAcquireDeadlineAt: { lte: new Date() },
          status: "WAITING_EXECUTION",
        },
      });
      for (const run of expired) {
        try {
          await this.lifecycle.transition({
            actor: "SYSTEM",
            eventKind: "verification.timed_out",
            eventPayload: { reason: "EXECUTION_ACQUIRE_TIMEOUT" },
            expected: ["WAITING_EXECUTION"],
            runId: run.id,
            teamId: run.teamId,
            to: "TIMED_OUT",
          });
          this.observability?.log(
            "warn",
            "verification.execution.acquire_timed_out",
            {
              deadlineAt: run.executionAcquireDeadlineAt?.toISOString() ?? null,
              reason: "EXECUTION_ACQUIRE_TIMEOUT",
              runId: run.id,
              traceId: run.traceId,
            },
          );
        } catch (error) {
          this.logger.warn(
            `Execution wait timeout for ${run.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
