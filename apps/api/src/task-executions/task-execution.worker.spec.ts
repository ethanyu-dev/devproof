import { describe, expect, it, vi } from "vitest";

import { TaskExecutionWorker } from "./task-execution.worker.js";

describe("TaskExecutionWorker", () => {
  it("reconciles analysis, Case dispatch and parent projections", async () => {
    const reconcile = vi.fn().mockResolvedValue({
      analyzed: 1,
      cancelledRuns: 1,
      directDispatched: 1,
      dispatched: 3,
      exhaustedDispatches: 1,
      projected: 2,
    });
    const worker = new TaskExecutionWorker({ reconcile } as never);

    await expect(worker.poll()).resolves.toEqual({
      analyzed: 1,
      cancelledRuns: 1,
      directDispatched: 1,
      dispatched: 3,
      exhaustedDispatches: 1,
      projected: 2,
    });
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
