import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { env } from "../config/env.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";
import { TestSpecificationService } from "./test-specification.service.js";

@Injectable()
export class SpecificationExecutionWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SpecificationExecutionWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly specifications: TestSpecificationService,
    @Optional() private readonly monitor?: WorkerMonitorService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor?.register(
      "specification-execution",
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

  async poll() {
    return this.specifications.reconcilePending();
  }

  private trigger() {
    const operation = () => this.poll();
    const running = this.monitor
      ? this.monitor.run("specification-execution", operation)
      : operation();
    void running.catch((error: Error) => {
      this.logger.error(`Specification dispatch failed: ${error.message}`);
    });
  }
}
