import { describe, expect, it, vi } from "vitest";

import { SpecificationExecutionWorker } from "./specification-execution.worker.js";

describe("SpecificationExecutionWorker", () => {
  it("reconciles pending Case to Run v2 dispatches", async () => {
    const reconcilePending = vi.fn().mockResolvedValue({ inspected: 2 });
    const worker = new SpecificationExecutionWorker({
      reconcilePending,
    } as never);

    await expect(worker.poll()).resolves.toEqual({ inspected: 2 });
    expect(reconcilePending).toHaveBeenCalledOnce();
  });
});
