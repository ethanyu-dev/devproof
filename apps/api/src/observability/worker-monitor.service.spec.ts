import { describe, expect, it, vi } from "vitest";

import { MetricsService } from "./metrics.service.js";
import { ObservabilityService } from "./observability.service.js";
import { WorkerMonitorService } from "./worker-monitor.service.js";

describe("WorkerMonitorService", () => {
  it("shares an in-flight execution without recording a false success", async () => {
    const metrics = new MetricsService();
    const monitor = new WorkerMonitorService(
      metrics,
      new ObservabilityService(),
    );
    monitor.register("worker", 1_000);
    let resolve!: (value: string) => void;
    const operation = vi.fn(
      () => new Promise<string>((done) => (resolve = done)),
    );

    const first = monitor.run("worker", operation);
    const second = monitor.run("worker", operation);

    expect(operation).toHaveBeenCalledOnce();
    expect(monitor.snapshot()[0]).toMatchObject({
      lastSuccessAt: null,
      running: true,
    });
    resolve("done");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "done",
      "done",
    ]);
    expect(metrics.render()).toContain(
      'devproof_worker_runs_total{status="succeeded",worker="worker"} 1',
    );
  });
});
