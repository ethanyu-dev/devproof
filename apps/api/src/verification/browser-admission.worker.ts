import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { env } from "../config/env.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";
import { BrowserAdmissionService } from "./browser-admission.service.js";

@Injectable()
export class BrowserAdmissionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrowserAdmissionWorker.name);
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly admission: BrowserAdmissionService,
    @Optional() private readonly monitor?: WorkerMonitorService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor?.register(
      "browser-admission",
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
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.admission.reconcile();
    } finally {
      this.running = false;
    }
  }

  private trigger() {
    const operation = () => this.poll();
    const running = this.monitor
      ? this.monitor.run("browser-admission", operation)
      : operation();
    void running.catch((error: Error) => {
      this.logger.error(`Browser admission failed: ${error.message}`);
    });
  }
}
