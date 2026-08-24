import { describe, expect, it, vi } from "vitest";

import { UnifiedRunCleanupWorker } from "./unified-run-cleanup.worker.js";

describe("UnifiedRunCleanupWorker deadline races", () => {
  it("rechecks the deadline when claiming a run selected for expiry", async () => {
    const executionRunUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = {
      agentRuntimeTask: { updateMany: vi.fn() },
      executionRun: { updateMany: executionRunUpdateMany },
      humanIntervention: { updateMany: vi.fn() },
      runAttempt: { updateMany: vi.fn() },
      runEvent: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      browserExecution: { findMany: vi.fn().mockResolvedValue([]) },
      executionRun: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "285146a8-5230-4b02-832a-5eef19e8dc8a",
            startedAt: new Date(),
            teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
          },
        ]),
      },
      humanIntervention: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const worker = new UnifiedRunCleanupWorker(
      prisma as never,
      { releaseForExecutionRun: vi.fn() } as never,
    );

    await worker.tick();

    expect(executionRunUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deadlineAt: { lte: expect.any(Date) },
        }),
      }),
    );
    expect(tx.agentRuntimeTask.updateMany).not.toHaveBeenCalled();
  });
});
