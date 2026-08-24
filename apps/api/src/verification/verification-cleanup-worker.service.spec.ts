import { describe, expect, it, vi } from "vitest";
import { verificationRequestSchema } from "@devproof/contracts";

import { VerificationCleanupWorker } from "./verification-cleanup-worker.service.js";

describe("Verification cleanup pagination", () => {
  it("advances past a healthy first page to find later timeouts", async () => {
    const traceId = "11111111111111111111111111111111";
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Page loads", id: "page" }],
      execution: {
        requiredCapabilities: ["browser"],
        runTimeoutSeconds: 30,
      },
      goal: "Verify release",
      idempotencyKey: "cleanup-pagination",
    });
    const healthy = Array.from({ length: 50 }, (_, index) => ({
      id: `run-${String(index).padStart(3, "0")}`,
      requestSnapshot: request,
      runnerKind: "BROWSER",
      runtimeSession: { status: "ACTIVE" },
      startedAt: new Date(),
      teamId: "team",
      traceId,
    }));
    const timedOut = {
      ...healthy[0],
      id: "run-999",
      startedAt: new Date(Date.now() - 180_000),
    };
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(healthy)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([timedOut]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
      ),
      notificationOutbox: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      verificationCheckpoint: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      verificationEvent: { create: vi.fn().mockResolvedValue({}) },
      verificationRun: { findMany, updateMany },
    };
    const release = vi.fn().mockResolvedValue(undefined);
    const observability = { log: vi.fn() };
    const worker = new VerificationCleanupWorker(
      prisma as never,
      {
        get: () => ({ release }),
      } as never,
      undefined,
      observability as never,
    );
    const converge = (
      worker as unknown as { convergeAbandonedRuns(): Promise<void> }
    ).convergeAbandonedRuns.bind(worker);

    await converge();
    await converge();

    expect(findMany.mock.calls[3]?.[0]).toMatchObject({
      where: { id: { gt: "run-049" } },
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-999" }),
      }),
    );
    expect(release).toHaveBeenCalledWith("team", "run-999");
    expect(observability.log).toHaveBeenCalledWith(
      "warn",
      "verification.run.timed_out",
      expect.objectContaining({
        deadlineAt: expect.any(String),
        reason: "AGENT_RUN_TIMEOUT",
        runId: "run-999",
        runTimeoutSeconds: 120,
        traceId,
      }),
    );
  });

  it("writes a matching INCONCLUSIVE result when a runtime session is lost", async () => {
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Page loads", id: "page" }],
      execution: { requiredCapabilities: ["browser"] },
      goal: "Verify release",
      idempotencyKey: "cleanup-lost-session",
    });
    const lost = {
      id: "run-lost",
      requestSnapshot: request,
      runnerKind: "BROWSER",
      runtimeSession: { status: "LOST" },
      startedAt: new Date(Date.now() - 5_000),
      teamId: "team",
      traceId: "11111111111111111111111111111111",
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
      ),
      notificationOutbox: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      verificationCheckpoint: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      verificationEvent: { create: vi.fn().mockResolvedValue({}) },
      verificationRun: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([lost])
          .mockResolvedValueOnce([]),
        updateMany,
      },
    };
    const worker = new VerificationCleanupWorker(
      prisma as never,
      {
        get: () => ({ release: vi.fn().mockResolvedValue(undefined) }),
      } as never,
    );

    await (
      worker as unknown as { convergeAbandonedRuns(): Promise<void> }
    ).convergeAbandonedRuns();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({ verdict: "INCONCLUSIVE" }),
          status: "INCONCLUSIVE",
        }),
      }),
    );
  });
});
