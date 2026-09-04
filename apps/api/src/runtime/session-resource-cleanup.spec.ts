import { describe, expect, it, vi } from "vitest";
import {
  quarantineSession,
  releaseCompletedSessionData,
  releaseVerifiedSessionResources,
} from "./session-resource-cleanup.js";

function fixture() {
  return {
    browserRuntimeSession: {
      findUnique: vi.fn().mockResolvedValue({
        status: "CLOSED",
        closureVerifiedAt: new Date(),
        ownerTaskId: "task-1",
      }),
      findMany: vi.fn().mockResolvedValue([{ id: "session-1" }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentRuntimeTask: {
      findUnique: vi.fn().mockResolvedValue({
        completionId: null,
        status: "RUNNING",
        result: null,
        recoveryStatus: null,
        run: { concurrencyPolicy: { accessMode: "MUTATING" } },
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    executionResourceLease: {
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    browserRuntimeCommand: { count: vi.fn().mockResolvedValue(0) },
    browserRuntimeSlot: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    browserRuntimeProfileLease: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe("verified browser resource release", () => {
  it("releases a quarantined startup reservation only after closure and an empty complete write audit", async () => {
    const tx = fixture();
    tx.browserRuntimeSession.findUnique.mockResolvedValue({
      status: "CLOSED",
      closureVerifiedAt: new Date(),
      ownerTaskId: null,
      purpose: "EXECUTION",
      protocolMinor: 13,
      browserExecutions: [{ id: "execution-1" }],
    } as never);
    await releaseVerifiedSessionResources(tx as never, "session-1");
    expect(tx.browserRuntimeCommand.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        sessionId: "session-1",
        commandType: {
          notIn: expect.arrayContaining(["page.snapshot", "session.close"]),
        },
        NOT: {
          AND: [
            { commandType: "session.open" },
            { source: "SYSTEM" },
            {
              session: {
                purpose: "EXECUTION",
                protocolMinor: { gte: 13 },
                browserExecutions: { some: {} },
              },
            },
          ],
        },
      }),
    });
    expect(
      tx.browserRuntimeCommand.count.mock.calls[0]![0].where,
    ).not.toHaveProperty("source");
    expect(tx.executionResourceLease.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: "session-1" },
    });
    expect(tx.executionResourceLease.updateMany).not.toHaveBeenCalled();
  });

  it.each(["CONSOLE", "HUMAN"])(
    "retains an ownerless execution's data quarantine after a possible %s write",
    async () => {
      const tx = fixture();
      tx.browserRuntimeSession.findUnique.mockResolvedValue({
        status: "CLOSED",
        closureVerifiedAt: new Date(),
        ownerTaskId: null,
        purpose: "EXECUTION",
        protocolMinor: 13,
        browserExecutions: [],
      } as never);
      tx.browserRuntimeCommand.count.mockResolvedValue(1);
      tx.executionResourceLease.count.mockResolvedValue(1);
      await releaseVerifiedSessionResources(tx as never, "session-1");
      expect(tx.executionResourceLease.updateMany).toHaveBeenCalledWith({
        where: { sessionId: "session-1", mode: "WRITE" },
        data: { quarantined: true },
      });
      expect(tx.executionResourceLease.deleteMany).toHaveBeenCalledWith({
        where: { sessionId: "session-1", quarantined: false },
      });
      expect(tx.browserRuntimeSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ quarantinedAt: expect.any(Date) }),
        }),
      );
    },
  );

  it("keeps an uncertain physical session and its write resource reserved", async () => {
    const tx = fixture();
    tx.browserRuntimeSession.findUnique.mockResolvedValue({
      status: "LOST",
      closureVerifiedAt: null,
      ownerTaskId: "task-1",
    } as never);
    await quarantineSession(tx as never, "session-1", "LEASE_EXPIRED");
    expect(
      await releaseVerifiedSessionResources(tx as never, "session-1"),
    ).toBe(false);
    expect(tx.executionResourceLease.updateMany).toHaveBeenCalledWith({
      where: { sessionId: "session-1", mode: "WRITE" },
      data: { quarantined: true },
    });
    expect(tx.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
  });

  it("preserves the isolation start time after browser closure while an uncertain write remains", async () => {
    const tx = fixture();
    const quarantinedAt = new Date("2026-09-04T08:00:00Z");
    tx.browserRuntimeSession.findUnique.mockResolvedValue({
      status: "CLOSED",
      closureVerifiedAt: new Date(),
      ownerTaskId: "task-1",
      quarantinedAt,
    } as never);
    tx.executionResourceLease.count.mockResolvedValue(1);
    await releaseVerifiedSessionResources(tx as never, "session-1");
    expect(tx.browserRuntimeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quarantinedAt, identityPermit: null }),
      }),
    );
  });

  it("releases physical capacity after close while deferring a writer's data lock until outcome", async () => {
    const tx = fixture();
    await releaseVerifiedSessionResources(tx as never, "session-1");
    expect(tx.browserRuntimeSlot.deleteMany).toHaveBeenCalledOnce();
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    tx.agentRuntimeTask.findUnique.mockResolvedValue({
      completionId: "completion-1",
      recoveryStatus: null,
      result: { kind: "VERIFICATION_COMPLETED" },
      status: "SUCCEEDED",
    } as never);
    await releaseCompletedSessionData(tx as never, "task-1");
    expect(tx.executionResourceLease.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: { in: ["session-1"] }, quarantined: false },
    });
  });

  it("never clears quarantine through ordinary completion handling", async () => {
    const tx = fixture();
    tx.agentRuntimeTask.findUnique.mockResolvedValue({
      completionId: "completion-1",
      recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
      result: { kind: "VERIFICATION_COMPLETED" },
      status: "SUCCEEDED",
    } as never);
    await releaseCompletedSessionData(tx as never, "task-1");
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
  });

  it("releases a confirmed final verification after closure without quarantining it", async () => {
    const tx = fixture();
    tx.agentRuntimeTask.findUnique.mockResolvedValue({
      completionId: "completed-verification",
      status: "SUCCEEDED",
      result: { kind: "VERIFICATION_COMPLETED", verdict: "FAILED" },
      recoveryStatus: null,
      run: { concurrencyPolicy: { accessMode: "MUTATING" } },
    } as never);
    await releaseVerifiedSessionResources(tx as never, "session-1");
    expect(tx.executionResourceLease.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: "session-1", quarantined: false },
    });
    expect(tx.agentRuntimeTask.updateMany).not.toHaveBeenCalled();
    expect(tx.executionResourceLease.updateMany).not.toHaveBeenCalled();
  });

  it.each(["WAITING_HUMAN", "CANCELLED", "TIMED_OUT", "FAILED"])(
    "does not treat an intermediate completion as a confirmed write outcome after %s",
    async (status) => {
      const tx = fixture();
      tx.agentRuntimeTask.findUnique.mockResolvedValue({
        completionId: "human-wait-completion",
        recoveryStatus: null,
        result: { kind: "WAITING_HUMAN" },
        status,
      } as never);
      await releaseCompletedSessionData(tx as never, "task-1");
      expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    },
  );

  it("releases a closed recovery session when a complete audit proves no possible write", async () => {
    const tx = fixture();
    tx.browserRuntimeSession.findUnique.mockResolvedValue({
      status: "CLOSED",
      closureVerifiedAt: new Date(),
      ownerTaskId: "task-1",
      purpose: "EXECUTION",
      protocolMinor: 13,
      browserExecutions: [{ id: "execution-1" }],
    } as never);
    tx.agentRuntimeTask.findUnique.mockResolvedValue({
      completionId: "human-wait-completion",
      recoveryStatus: "PENDING",
      result: { kind: "WAITING_HUMAN" },
      status: "FAILED",
      run: { concurrencyPolicy: { accessMode: "MUTATING" } },
    } as never);
    await releaseVerifiedSessionResources(tx as never, "session-1");
    expect(tx.executionResourceLease.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: "session-1" },
    });
    expect(tx.agentRuntimeTask.updateMany).not.toHaveBeenCalled();
    expect(tx.executionResourceLease.updateMany).not.toHaveBeenCalled();
  });

  it("does not recreate quarantine when reconciliation wins a concurrent owner CAS", async () => {
    const tx = fixture();
    tx.agentRuntimeTask.findUnique.mockResolvedValue({
      completionId: "human-wait-completion",
      recoveryStatus: null,
      result: { kind: "WAITING_HUMAN" },
      status: "CANCELLED",
      run: { concurrencyPolicy: { accessMode: "MUTATING" } },
    } as never);
    tx.agentRuntimeTask.updateMany.mockResolvedValue({ count: 0 });
    await releaseVerifiedSessionResources(tx as never, "session-1");
    expect(tx.executionResourceLease.updateMany).not.toHaveBeenCalled();
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
  });
});
