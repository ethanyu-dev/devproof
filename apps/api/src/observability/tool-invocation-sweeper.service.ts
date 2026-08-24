import { Injectable } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { ObservabilityService } from "./observability.service.js";
import { WorkerMonitorService } from "./worker-monitor.service.js";

const INTERVAL_MS = 60_000;

@Injectable()
export class ToolInvocationSweeper implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly monitor: WorkerMonitorService,
    private readonly observability: ObservabilityService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor.register("tool-invocation-sweeper", INTERVAL_MS);
    this.timer = setInterval(() => this.trigger(), INTERVAL_MS);
    this.timer.unref();
    this.trigger();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      const cutoff = new Date(
        Date.now() - env().TOOL_INVOCATION_STALE_SECONDS * 1_000,
      );
      const result = await this.prisma.toolInvocation.updateMany({
        data: {
          completedAt: new Date(),
          errorCode: "PROCESS_INTERRUPTED",
          errorMessage:
            "The API process did not record a terminal result before the stale deadline.",
          status: "FAILED",
        },
        where: { startedAt: { lt: cutoff }, status: "STARTED" },
      });
      if (result.count > 0) {
        this.observability.log("warn", "tool.invocation.stale_recovered", {
          count: result.count,
          staleSeconds: env().TOOL_INVOCATION_STALE_SECONDS,
        });
      }
    } finally {
      this.running = false;
    }
  }

  private trigger() {
    void this.monitor
      .run("tool-invocation-sweeper", () => this.sweep())
      .catch(() => undefined);
  }
}
