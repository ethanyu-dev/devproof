import { describe, expect, it, vi } from "vitest";

import { UnifiedRunCleanupWorker } from "./unified-run-cleanup.worker.js";

describe("UnifiedRunCleanupWorker deadline races", () => {
  it("claims the Run before the intervention to match resume lock ordering", async () => {
    const executionRunUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const interventionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      agentRuntimeTask: { updateMany: vi.fn() },
      executionRun: { updateMany: executionRunUpdateMany },
      humanIntervention: { updateMany: interventionUpdateMany },
      notificationOutbox: { create: vi.fn() },
      runAttempt: { updateMany: vi.fn() },
      runEvent: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      browserExecution: { findMany: vi.fn().mockResolvedValue([]) },
      executionRun: { findMany: vi.fn().mockResolvedValue([]) },
      humanIntervention: {
        findMany: vi.fn().mockResolvedValue([
          {
            attemptId: "attempt-1",
            expiresAt: new Date(Date.now() - 1_000),
            id: "intervention-1",
            run: {
              executionPolicy: {
                hitl: {
                  enabled: true,
                  notificationChannels: [],
                  onTimeout: "INCONCLUSIVE",
                  timeoutSeconds: 3_600,
                },
              },
              startedAt: new Date(),
            },
            runId: "run-1",
            taskId: "task-1",
            teamId: "team-1",
          },
        ]),
      },
    };
    const worker = new UnifiedRunCleanupWorker(
      prisma as never,
      { releaseForExecutionRun: vi.fn() } as never,
    );

    await worker.tick();

    expect(executionRunUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      interventionUpdateMany.mock.invocationCallOrder[0]!,
    );
  });

  it("rechecks the deadline when claiming a run selected for expiry", async () => {
    const executionRunUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = {
      agentRuntimeTask: { updateMany: vi.fn() },
      executionRun: { updateMany: executionRunUpdateMany },
      humanIntervention: { updateMany: vi.fn() },
      notificationOutbox: { create: vi.fn() },
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

  it("queues a Feishu card update when a human intervention expires", async () => {
    const tx = {
      agentRuntimeTask: { updateMany: vi.fn() },
      executionRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      humanIntervention: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      notificationOutbox: { create: vi.fn() },
      runAttempt: { updateMany: vi.fn() },
      runEvent: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      browserExecution: { findMany: vi.fn().mockResolvedValue([]) },
      executionRun: { findMany: vi.fn().mockResolvedValue([]) },
      humanIntervention: {
        findMany: vi.fn().mockResolvedValue([
          {
            attemptId: "attempt-1",
            id: "intervention-1",
            run: {
              executionPolicy: {
                hitl: {
                  enabled: true,
                  notificationChannels: ["FEISHU"],
                  onTimeout: "INCONCLUSIVE",
                  timeoutSeconds: 3_600,
                },
              },
              startedAt: new Date(),
            },
            runId: "run-1",
            taskId: "task-1",
            teamId: "team-1",
          },
        ]),
      },
    };
    const worker = new UnifiedRunCleanupWorker(
      prisma as never,
      { releaseForExecutionRun: vi.fn() } as never,
    );

    await worker.tick();

    expect(tx.notificationOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        channel: "FEISHU",
        eventType: "hitl.expired",
        payload: expect.objectContaining({
          notificationKind: "HITL_EXPIRED",
        }),
      }),
    });
  });
});
