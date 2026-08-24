import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { env } from "../config/env.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";
import { TaskExecutionService } from "./task-execution.service.js";

@Injectable()
export class TaskExecutionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskExecutionWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly tasks: TaskExecutionService,
    @Optional() private readonly monitor?: WorkerMonitorService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor?.register("task-execution", env().BACKGROUND_WORKER_POLL_MS);
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
    return this.tasks.reconcile();
  }

  private trigger() {
    const operation = () => this.poll();
    const running = this.monitor
      ? this.monitor.run("task-execution", operation)
      : operation();
    void running.catch((error: Error) => {
      this.logger.error(
        `Task execution reconciliation failed: ${error.message}`,
      );
    });
  }
}
