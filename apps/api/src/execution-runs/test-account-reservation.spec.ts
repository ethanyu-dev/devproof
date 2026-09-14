import { describe, it, expect, vi } from "vitest";
import { claimTestAccount } from "./test-account-reservation.js";
const input = {
  teamId: "team",
  runId: "current",
  environment: { targetUrl: "https://app.test/list" },
  account: "13962083614",
};
const other = {
  id: "other",
  lifecycle: "RUNNING",
  environmentSnapshot: input.environment,
  executionPolicy: { testAccountClaim: { account: "13962083614" } },
};
function tx(runs: unknown[]) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    browserExecution: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ id: "execution" }),
    },
    browserRuntimeCommand: {
      findFirst: vi.fn().mockResolvedValue({ id: "launch-command" }),
      count: vi.fn().mockResolvedValue(0),
    },
    runtimeSessionRecovery: { findFirst: vi.fn().mockResolvedValue(null) },
    executionRun: {
      findMany: vi.fn().mockResolvedValue(runs),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ executionPolicy: { browser: {} } }),
      update: vi.fn(),
    },
  };
}
const closedSession = {
  id: "session",
  purpose: "EXECUTION",
  protocolMinor: 14,
  ownerTaskId: "task",
  ownerFencingToken: 1n,
  fencingToken: 1n,
  leaseToken: "lease",
  launchIdentityVersion: 1,
  launchIdentity: { version: 1, id: "launch" },
  launchHostInstanceId: "host",
  launchConnectionGeneration: 1n,
  controlGeneration: 0,
  closureVerifiedAt: new Date(),
  closureEvidenceId: "closed-proof",
};
describe("shared business account allocation", () => {
  it("releases a cancelled claim before any browser execution was allocated", async () => {
    const db = tx([{ ...other, lifecycle: "CANCELLED" }]);
    await claimTestAccount(db as never, input);
    expect(db.executionRun.update).toHaveBeenCalledOnce();
  });
  it.each(["CANCELLED", "COMPLETED", "TIMED_OUT"])(
    "releases %s runs with audited observation-only closed sessions",
    async (lifecycle) => {
      const db = tx([{ ...other, lifecycle }]);
      db.browserExecution.findMany.mockResolvedValue([
        { runtimeSession: closedSession },
      ]);
      await claimTestAccount(db as never, input);
      expect(db.browserRuntimeCommand.count).toHaveBeenCalledOnce();
      expect(db.executionRun.update).toHaveBeenCalledOnce();
    },
  );
  it("keeps an empty journal reserved when browser history contains a potential write", async () => {
    const db = tx([{ ...other, lifecycle: "COMPLETED" }]);
    db.browserExecution.findMany.mockResolvedValue([
      { runtimeSession: closedSession },
    ]);
    db.browserRuntimeCommand.count.mockResolvedValue(1);
    await expect(claimTestAccount(db as never, input)).rejects.toThrow(
      "TEST_ACCOUNT_CONFLICT",
    );
    expect(db.executionRun.update).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...closedSession, closureVerifiedAt: null },
    { ...closedSession, launchIdentity: null },
    { ...closedSession, controlGeneration: 1 },
  ])(
    "does not infer no-write from missing closure or launch audit (case %#)",
    async (session) => {
      const db = tx([{ ...other, lifecycle: "COMPLETED" }]);
      db.browserExecution.findMany.mockResolvedValue([
        { runtimeSession: session },
      ]);
      await expect(claimTestAccount(db as never, input)).rejects.toThrow(
        "TEST_ACCOUNT_CONFLICT",
      );
    },
  );
  it("allows an explicit no-write reconciliation for a closed session", async () => {
    const db = tx([{ ...other, lifecycle: "COMPLETED" }]);
    db.browserExecution.findMany.mockResolvedValue([
      { runtimeSession: closedSession },
    ]);
    db.browserRuntimeCommand.count.mockResolvedValue(1);
    db.runtimeSessionRecovery.findFirst.mockResolvedValue({
      id: "no-write-proof",
    });
    await claimTestAccount(db as never, input);
    expect(db.runtimeSessionRecovery.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          writeOutcomeState: "RESOLVED",
          resolutionOutcome: "NO_WRITE",
          expectedSessionFence: 1n,
        }),
      }),
    );
  });
  it("blocks two cases using the same static account before a write", async () => {
    const db = tx([other]);
    await expect(claimTestAccount(db as never, input)).rejects.toThrow(
      "TEST_ACCOUNT_CONFLICT",
    );
    expect(db.executionRun.update).not.toHaveBeenCalled();
  });
  it("detects a newly resolved UUID alias", async () => {
    await expect(
      claimTestAccount(
        tx([
          {
            ...other,
            executionPolicy: { testAccountClaim: { account: "user-uuid" } },
          },
        ]) as never,
        { ...input, aliases: ["user-uuid"] },
      ),
    ).rejects.toThrow("TEST_ACCOUNT_CONFLICT");
  });
  it("retains a terminal claim with pending cleanup and releases only after verified cleanup", async () => {
    const state = {
      records: [
        {
          id: "123",
          ownership: "CREATED_THIS_RUN",
          evidenceRefs: ["proof"],
          cleanup: { instruction: "delete", status: "PENDING" },
        },
      ],
    };
    const done = {
      ...other,
      lifecycle: "COMPLETED",
      executionPolicy: { ...other.executionPolicy, executionState: state },
    };
    await expect(claimTestAccount(tx([done]) as never, input)).rejects.toThrow(
      "TEST_ACCOUNT_CONFLICT",
    );
    state.records[0]!.cleanup.status = "COMPLETED";
    const db = tx([done]);
    await claimTestAccount(db as never, input);
    expect(db.executionRun.update).toHaveBeenCalled();
  });
  it("allows a different environment and retains unrelated run policy", async () => {
    const db = tx([
      { ...other, environmentSnapshot: { targetUrl: "https://other.test" } },
    ]);
    await claimTestAccount(db as never, input);
    expect(db.executionRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          executionPolicy: expect.objectContaining({
            browser: {},
            testAccountClaim: { account: input.account, aliases: [] },
          }),
        },
      }),
    );
  });
});
