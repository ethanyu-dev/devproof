import { Injectable } from "@nestjs/common";

import { MetricsService } from "./metrics.service.js";
import { ObservabilityService } from "./observability.service.js";

interface WorkerState {
  inFlight: Promise<unknown> | undefined;
  intervalMs: number;
  lastDurationMs: number | null;
  lastError: string | null;
  lastFailureAt: Date | null;
  lastStartedAt: Date | null;
  lastSuccessAt: Date | null;
  registeredAt: Date;
  running: boolean;
}

@Injectable()
export class WorkerMonitorService {
  private readonly workers = new Map<string, WorkerState>();

  constructor(
    private readonly metrics: MetricsService,
    private readonly observability: ObservabilityService,
  ) {}

  register(name: string, intervalMs: number) {
    this.workers.set(name, {
      inFlight: undefined,
      intervalMs,
      lastDurationMs: null,
      lastError: null,
      lastFailureAt: null,
      lastStartedAt: null,
      lastSuccessAt: null,
      registeredAt: new Date(),
      running: false,
    });
  }

  async run<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const state = this.workers.get(name);
    if (state?.inFlight) return state.inFlight as Promise<T>;
    const started = Date.now();
    if (state) {
      state.lastStartedAt = new Date();
      state.running = true;
    }
    const execution = (async () => {
      try {
        const result = await operation();
        const durationMs = Date.now() - started;
        if (state) {
          state.lastDurationMs = durationMs;
          state.lastError = null;
          state.lastSuccessAt = new Date();
        }
        this.metrics.increment(
          "devproof_worker_runs_total",
          "Background worker executions by status.",
          { status: "succeeded", worker: name },
        );
        this.metrics.observe(
          "devproof_worker_run_duration_seconds",
          "Background worker execution duration in seconds.",
          durationMs / 1_000,
          { worker: name },
        );
        return result;
      } catch (error) {
        const durationMs = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        if (state) {
          state.lastDurationMs = durationMs;
          state.lastError = message.slice(0, 4_000);
          state.lastFailureAt = new Date();
        }
        this.metrics.increment(
          "devproof_worker_runs_total",
          "Background worker executions by status.",
          { status: "failed", worker: name },
        );
        this.observability.log(
          "error",
          "worker.run.failed",
          { durationMs, worker: name },
          error,
        );
        throw error;
      } finally {
        if (state) {
          state.inFlight = undefined;
          state.running = false;
        }
      }
    })();
    if (state) state.inFlight = execution;
    return execution;
  }

  snapshot() {
    const now = Date.now();
    return [...this.workers.entries()].map(([name, state]) => {
      const graceMs = Math.max(30_000, state.intervalMs * 3);
      const reference = state.lastSuccessAt ?? state.registeredAt;
      const stale = now - reference.getTime() > graceMs;
      const failing = Boolean(
        state.lastFailureAt &&
        (!state.lastSuccessAt || state.lastFailureAt > state.lastSuccessAt),
      );
      const healthy = !stale && !failing;
      this.metrics.setGauge(
        "devproof_worker_last_success_timestamp_seconds",
        "Unix timestamp of the last successful background worker run.",
        state.lastSuccessAt ? state.lastSuccessAt.getTime() / 1_000 : 0,
        { worker: name },
      );
      this.metrics.setGauge(
        "devproof_worker_healthy",
        "Whether a background worker heartbeat is within its expected interval.",
        healthy ? 1 : 0,
        { worker: name },
      );
      return {
        healthy,
        intervalMs: state.intervalMs,
        lastDurationMs: state.lastDurationMs,
        lastError: state.lastError,
        lastFailureAt: state.lastFailureAt?.toISOString() ?? null,
        lastStartedAt: state.lastStartedAt?.toISOString() ?? null,
        lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
        name,
        running: state.running,
      };
    });
  }
}
