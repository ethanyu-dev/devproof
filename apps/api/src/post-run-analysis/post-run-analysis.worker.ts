import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { env } from "../config/env.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";
import { PostRunAnalysisService } from "./post-run-analysis.service.js";

@Injectable()
export class PostRunAnalysisWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostRunAnalysisWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly analyses: PostRunAnalysisService,
    @Optional() private readonly monitor?: WorkerMonitorService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor?.register(
      "post-run-analysis",
      env().BACKGROUND_WORKER_POLL_MS,
    );
    this.timer = setInterval(
      () => this.trigger(),
      env().BACKGROUND_WORKER_POLL_MS,
    );
    this.timer.unref();
    this.trigger();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  poll() {
    return this.analyses.reconcile();
  }

  private trigger() {
    const operation = () => this.poll();
    const running = this.monitor
      ? this.monitor.run("post-run-analysis", operation)
      : operation();
    void running.catch((error: Error) => {
      this.logger.error(
        `Post-run analysis reconciliation failed: ${error.message}`,
      );
    });
  }
}
