import { describe, expect, it, vi } from "vitest";
import { verificationRequestSchema } from "@devproof/contracts";

import { ExecutionRunnerUnavailableError } from "./runtime-adapters.js";
import { VerificationExecutionService } from "./verification-execution.service.js";

function fixture(status: string, runtimeSessionId: string | null) {
  const release = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    verificationRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: "run-1",
        runnerKind: "BROWSER",
        runtimeSessionId,
        status,
        teamId: "team-1",
      }),
    },
  };
  const runners = { get: vi.fn().mockReturnValue({ release }) };
  const service = new VerificationExecutionService(
    prisma as never,
    runners as never,
    {} as never,
  );
  return { release, service };
}

describe("Verification execution release", () => {
  it("preserves the original browser session while HITL is pending", async () => {
    const { release, service } = fixture("WAITING_HUMAN", "session-1");

    await expect(service.release("team-1", "run-1")).rejects.toThrow(
      /must remain active while browser HITL is waiting/u,
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("allows terminal cleanup to release the execution", async () => {
    const { release, service } = fixture("PASSED", "session-1");

    await expect(service.release("team-1", "run-1")).resolves.toEqual({
      ok: true,
    });
    expect(release).toHaveBeenCalledWith("team-1", "run-1");
  });
});

function acquisitionFixture(
  availabilityPolicy: "WAIT" | "FAIL_FAST",
  profile: { key?: string; mode: "EPHEMERAL" | "PERSISTENT" } = {
    mode: "EPHEMERAL",
  },
) {
  const requestSnapshot = verificationRequestSchema.parse({
    acceptanceCriteria: [{ description: "Page loads", id: "page-loads" }],
    execution: {
      acquireTimeoutSeconds: 30,
      availabilityPolicy,
      profile,
      requiredCapabilities: ["browser"],
    },
    goal: "Verify a page",
    idempotencyKey: `execution-${availabilityPolicy}`,
  });
  const run = {
    executionAcquireDeadlineAt: null,
    id: "run-1",
    requestSnapshot,
    runnerKind: "BROWSER",
    runtimeSessionId: null,
    status: "QUEUED",
    teamId: "team-1",
  };
  const acquire = vi.fn();
  const release = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    verificationRun: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(run),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  Object.assign(prisma, {
    $transaction: vi.fn(async (operation: (tx: unknown) => unknown) =>
      operation(prisma),
    ),
  });
  const lifecycle = {
    appendEvent: vi.fn().mockResolvedValue({}),
    transition: vi.fn().mockResolvedValue({}),
    transitionInTransaction: vi.fn().mockResolvedValue({}),
  };
  const runners = {
    get: vi.fn().mockReturnValue({ acquire, release }),
  };
  return {
    acquire,
    lifecycle,
    prisma,
    service: new VerificationExecutionService(
      prisma as never,
      runners as never,
      lifecycle as never,
    ),
  };
}

describe("Verification execution availability", () => {
  it("moves a WAIT request into WAITING_EXECUTION", async () => {
    const { acquire, lifecycle, service } = acquisitionFixture("WAIT");
    acquire.mockRejectedValue(
      new ExecutionRunnerUnavailableError(
        "NO_MATCHING_RUNNER",
        "No online runner.",
      ),
    );

    await expect(
      service.acquire("team-1", "run-1", { profileMode: "EPHEMERAL" }),
    ).resolves.toMatchObject({
      nextAction: "RETRY_ENSURE_EXECUTION",
      reason: "NO_MATCHING_RUNNER",
      status: "WAITING_EXECUTION",
    });
    expect(lifecycle.transitionInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventKind: "execution.waiting",
        to: "WAITING_EXECUTION",
      }),
    );
  });

  it("returns an acquired lease and starts a queued run", async () => {
    const { acquire, lifecycle, service } = acquisitionFixture("WAIT");
    acquire.mockResolvedValue({
      expiresAt: new Date("2026-08-11T08:00:00.000Z"),
      fencingToken: "4",
      leaseId: "session-1",
      runnerId: "runner-1",
      runnerKind: "BROWSER",
    });

    await expect(
      service.acquire("team-1", "run-1", { profileMode: "EPHEMERAL" }),
    ).resolves.toMatchObject({
      nextAction: "RUN_VERIFICATION",
      status: "ACQUIRED",
    });
    expect(lifecycle.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "verification.started",
        to: "RUNNING",
      }),
    );
    expect(lifecycle.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "execution.acquired" }),
    );
  });

  it("reuses the profile declared by the immutable verification request", async () => {
    const { acquire, service } = acquisitionFixture("WAIT", {
      key: "fp-issue-cycle",
      mode: "PERSISTENT",
    });
    acquire.mockResolvedValue({
      expiresAt: new Date("2026-08-11T08:00:00.000Z"),
      fencingToken: "4",
      leaseId: "session-1",
      runnerId: "runner-1",
      runnerKind: "BROWSER",
    });

    await service.acquire("team-1", "run-1");

    expect(acquire).toHaveBeenCalledWith(
      "team-1",
      "run-1",
      expect.objectContaining({
        execution: expect.objectContaining({
          profile: { key: "fp-issue-cycle", mode: "PERSISTENT" },
        }),
      }),
    );
  });

  it("keeps FAIL_FAST behavior available for smoke tests", async () => {
    const { acquire, lifecycle, service } = acquisitionFixture("FAIL_FAST");
    acquire.mockRejectedValue(
      new ExecutionRunnerUnavailableError(
        "NO_AVAILABLE_SLOT",
        "No available slot.",
      ),
    );

    await expect(
      service.acquire("team-1", "run-1", { profileMode: "EPHEMERAL" }),
    ).rejects.toThrow("No available slot.");
    expect(lifecycle.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "execution.acquire.failed" }),
    );
  });

  it("lets a team routing rule override request availability", async () => {
    const { acquire, lifecycle, service } = acquisitionFixture("FAIL_FAST");
    acquire.mockRejectedValue(
      new ExecutionRunnerUnavailableError(
        "NO_MATCHING_RUNNER",
        "The routed Runtime is offline.",
        "WAIT",
      ),
    );

    await expect(
      service.acquire("team-1", "run-1", { profileMode: "EPHEMERAL" }),
    ).resolves.toMatchObject({ status: "WAITING_EXECUTION" });
    expect(lifecycle.transitionInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: "WAITING_EXECUTION" }),
    );
  });

  it("returns QUEUE_FULL and closes the run when wait capacity is exhausted", async () => {
    const { acquire, lifecycle, prisma, service } = acquisitionFixture("WAIT");
    prisma.verificationRun.count.mockResolvedValue(100);
    acquire.mockRejectedValue(
      new ExecutionRunnerUnavailableError(
        "NO_AVAILABLE_SLOT",
        "No available slot.",
      ),
    );

    await expect(
      service.acquire("team-1", "run-1", { profileMode: "EPHEMERAL" }),
    ).resolves.toMatchObject({
      message: "Execution wait queue is full (100/100).",
      nextAction: "STOP",
      queueCapacity: 100,
      queueDepth: 100,
      reason: "EXECUTION_QUEUE_FULL",
      status: "QUEUE_FULL",
    });
    expect(lifecycle.transitionInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventKind: "execution.queue.full",
        to: "INCONCLUSIVE",
      }),
    );
  });
});
