import { describe, expect, it, vi } from "vitest";
import { leaseDigest } from "./session-recovery.state.js";
import {
  quarantineSession,
  releaseCompletedSessionData,
  releaseVerifiedSessionResources,
} from "./session-resource-cleanup.js";

function fixture() {
  const session = {
    id: "session-1",
    status: "CLOSED",
    closureVerifiedAt: new Date(),
    closureEvidenceId: "proof-1",
    ownerTaskId: null,
    purpose: "EXECUTION",
    leaseToken: "lease-1",
    fencingToken: 3n,
    quarantinedAt: new Date("2026-09-04T00:00:00Z"),
  };
  const recovery = {
    id: "recovery-1",
    closureState: "VERIFIED",
    closureEvidenceId: "proof-1",
    closureVerifiedAt: session.closureVerifiedAt,
    writeOutcomeState: "UNKNOWN",
  };
  return {
    session,
    recovery,
    sessionClosureEvidence: {
      findUnique: vi.fn().mockResolvedValue({
        id: "proof-1",
        sessionId: session.id,
        sessionFence: session.fencingToken,
        leaseDigest: leaseDigest(session.leaseToken),
        recoveryId: recovery.id,
      }),
    },
    browserRuntimeSession: {
      findUnique: vi.fn().mockResolvedValue(session),
      findMany: vi.fn().mockResolvedValue([session]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentRuntimeTask: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    runtimeSessionRecovery: {
      findUnique: vi.fn().mockResolvedValue(recovery),
      update: vi.fn(),
    },
    runtimeRecoveryOutbox: { upsert: vi.fn() },
    executionResourceLease: {
      count: vi.fn().mockResolvedValue(1),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    browserRuntimeCommand: { count: vi.fn().mockResolvedValue(0) },
    browserRuntimeSlot: { deleteMany: vi.fn() },
    browserRuntimeProfileLease: { deleteMany: vi.fn() },
    browserHumanControlLease: { deleteMany: vi.fn() },
  };
}

describe("verified browser resource release", () => {
  it.each(["CLOSED", "LOST", "FAILED"])(
    "never manufactures proof from status %s",
    async (status) => {
      const tx = fixture();
      tx.browserRuntimeSession.findUnique.mockResolvedValue({
        ...tx.session,
        status,
        closureVerifiedAt: null,
      });
      expect(
        await releaseVerifiedSessionResources(tx as never, tx.session.id),
      ).toBe(false);
      expect(tx.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
      expect(tx.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
    },
  );

  it("an old closure timestamp without an evidence ID never releases capacity or marks recovery resolved", async () => {
    const tx = fixture();
    Object.assign(tx.session, { closureEvidenceId: null });
    tx.agentRuntimeTask.findUnique.mockResolvedValue({
      completionId: "complete",
      status: "SUCCEEDED",
      result: { kind: "VERIFICATION_COMPLETED" },
      recoveryStatus: null,
    });
    expect(
      await releaseVerifiedSessionResources(tx as never, tx.session.id),
    ).toBe(false);
    await releaseCompletedSessionData(tx as never, "task-1");
    expect(tx.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
    expect(tx.runtimeSessionRecovery.update).not.toHaveBeenCalled();
  });
  it("a mismatched durable evidence epoch cannot release resources", async () => {
    const tx = fixture();
    tx.sessionClosureEvidence.findUnique.mockResolvedValue({
      id: "proof-1",
      sessionId: tx.session.id,
      sessionFence: 9n,
      leaseDigest: leaseDigest(tx.session.leaseToken),
      recoveryId: tx.recovery.id,
    });
    expect(
      await releaseVerifiedSessionResources(tx as never, tx.session.id),
    ).toBe(false);
    expect(tx.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
  });

  it("does not infer no-write from an empty command table or a modern stored version", async () => {
    const tx = fixture();
    await releaseVerifiedSessionResources(tx as never, tx.session.id);
    expect(tx.browserRuntimeCommand.count).not.toHaveBeenCalled();
    expect(tx.executionResourceLease.updateMany).toHaveBeenCalledWith({
      where: { sessionId: tx.session.id, mode: "WRITE" },
      data: { quarantined: true },
    });
    expect(tx.executionResourceLease.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: tx.session.id, mode: "READ", origin: "NORMAL" },
    });
    expect(
      tx.browserRuntimeSession.updateMany.mock.calls[0]![0].data,
    ).not.toHaveProperty("closureVerifiedAt");
  });

  it("releases only physical leases belonging to the verified epoch", async () => {
    const tx = fixture();
    await releaseVerifiedSessionResources(tx as never, tx.session.id);
    for (const model of [tx.browserRuntimeSlot, tx.browserRuntimeProfileLease])
      expect(model.deleteMany).toHaveBeenCalledWith({
        where: {
          sessionId: tx.session.id,
          leaseToken: tx.session.leaseToken,
          fencingToken: tx.session.fencingToken,
        },
      });
  });

  it("keeps the original quarantine timestamp while business results remain unknown", async () => {
    const tx = fixture();
    await releaseVerifiedSessionResources(tx as never, tx.session.id);
    expect(tx.browserRuntimeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          quarantinedAt: tx.session.quarantinedAt,
        }),
      }),
    );
  });

  it.each(["RESOLVED", "CONFIRMED", "NOT_APPLICABLE", "NO_WRITE_VERIFIED"])(
    "preserves durable %s resolution for an ownerless session",
    async (state) => {
      const tx = fixture();
      tx.runtimeSessionRecovery.findUnique.mockResolvedValue({
        ...tx.recovery,
        writeOutcomeState: state,
      });
      await releaseVerifiedSessionResources(tx as never, tx.session.id);
      expect(tx.executionResourceLease.updateMany).not.toHaveBeenCalled();
      expect(tx.executionResourceLease.deleteMany).toHaveBeenCalledWith({
        where: { sessionId: tx.session.id },
      });
    },
  );

  it("a late failure cannot quarantine already closed resources", async () => {
    const tx = fixture();
    tx.browserRuntimeSession.updateMany.mockResolvedValue({ count: 0 });
    await quarantineSession(tx as never, tx.session.id, "LATE_CLOSE_FAILURE");
    expect(tx.browserRuntimeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: tx.session.id,
          closureVerifiedAt: null,
          status: { not: "CLOSED" },
        },
      }),
    );
    expect(tx.executionResourceLease.updateMany).not.toHaveBeenCalled();
  });

  it.each(["WAITING_HUMAN", "CANCELLED", "TIMED_OUT", "FAILED"])(
    "does not mistake %s for a confirmed business result",
    async (status) => {
      const tx = fixture();
      tx.agentRuntimeTask.findUnique.mockResolvedValue({
        completionId: "intermediate",
        status,
        result: { kind: "WAITING_HUMAN" },
        recoveryStatus: null,
      });
      await releaseCompletedSessionData(tx as never, "task-1");
      expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    },
  );

  it("ordinary completion cannot bypass required manual outcome reconciliation", async () => {
    const tx = fixture();
    tx.agentRuntimeTask.findUnique.mockResolvedValue({
      completionId: "complete",
      status: "SUCCEEDED",
      result: { kind: "VERIFICATION_COMPLETED" },
      recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
    });
    await releaseCompletedSessionData(tx as never, "task-1");
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
  });
});
