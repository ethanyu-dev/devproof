import { describe, expect, it, vi } from "vitest";

import { VerificationExecutionWaitSweeper } from "./verification-execution-wait-sweeper.service.js";

describe("VerificationExecutionWaitSweeper", () => {
  it("times out execution waits even when the Agent Runtime is offline", async () => {
    const deadlineAt = new Date("2026-08-17T08:19:00.000Z");
    const prisma = {
      verificationRun: {
        findMany: vi.fn().mockResolvedValue([
          {
            executionAcquireDeadlineAt: deadlineAt,
            id: "run-1",
            teamId: "team-1",
            traceId: "11111111111111111111111111111111",
          },
        ]),
      },
    };
    const lifecycle = { transition: vi.fn().mockResolvedValue({}) };
    const observability = { log: vi.fn() };
    const sweeper = new VerificationExecutionWaitSweeper(
      prisma as never,
      lifecycle as never,
      undefined,
      observability as never,
    );

    await sweeper.sweep();

    expect(lifecycle.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "verification.timed_out",
        expected: ["WAITING_EXECUTION"],
        to: "TIMED_OUT",
      }),
    );
    expect(observability.log).toHaveBeenCalledWith(
      "warn",
      "verification.execution.acquire_timed_out",
      {
        deadlineAt: deadlineAt.toISOString(),
        reason: "EXECUTION_ACQUIRE_TIMEOUT",
        runId: "run-1",
        traceId: "11111111111111111111111111111111",
      },
    );
  });
});
