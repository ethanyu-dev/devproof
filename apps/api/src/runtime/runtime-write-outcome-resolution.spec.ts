import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRecoveryService } from "./session-recovery.service.js";
import { leaseDigest } from "./session-recovery.state.js";
import {
  releaseCompletedSessionData,
  releaseVerifiedSessionResources,
} from "./session-resource-cleanup.js";

const current = {
  sessionId: "login-session",
  team: { id: "team-1", name: "Team", slug: "team" },
  user: {
    avatarUrl: null,
    email: "operator@example.com",
    id: "operator-1",
    name: "Operator",
  },
};
const input = {
  expectedVersion: 1,
  idempotencyKey: "key-1",
  outcome: "VERIFIED" as const,
  note: "Verified the business record and reconciled the previous write.",
  evidenceRefs: ["audit:business-record-1"],
};

function fixture() {
  const now = new Date();
  const owner = {
    id: "task-1",
    status: "FAILED",
    recoveryStatus: "WRITE_OUTCOME_UNKNOWN" as string | null,
    fencingToken: 3n,
    completionId: null as string | null,
    result: null as unknown,
    run: {
      id: "run-1",
      lifecycle: "COMPLETED",
      concurrencyPolicy: { accessMode: "MUTATING" },
    },
  };
  const session = {
    id: "session-1",
    teamId: "team-1",
    runtimeId: "runtime-1",
    ownerTaskId: "task-1" as string | null,
    ownerFencingToken: 3n,
    status: "CLOSED",
    purpose: "EXECUTION",
    leaseToken: "lease-1",
    fencingToken: 7n,
    closureVerifiedAt: now as Date | null,
    closureEvidenceId: "proof-1" as string | null,
    quarantinedAt: now as Date | null,
    browserExecutions: [{ runId: "run-1", run: owner.run }],
  };
  const recovery = {
    id: "recovery-1",
    teamId: "team-1",
    runtimeId: session.runtimeId,
    sessionId: session.id,
    expectedSessionFence: session.fencingToken,
    expectedLeaseDigest: leaseDigest(session.leaseToken),
    closureState: "VERIFIED",
    closureVerifiedAt: now,
    closureEvidenceId: "proof-1",
    writeOutcomeState: "UNKNOWN",
    resolutionKey: null,
    resolutionDigest: null,
    version: 1,
    attempts: 1,
    nextAttemptAt: null,
    sourceRunId: "run-1",
    reason: "TEST",
    scopeSnapshot: [],
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  };
  let lease: {
    sessionId: string;
    mode: string;
    recoveryId: string | null;
    quarantined: boolean;
  } | null = {
    sessionId: session.id,
    mode: "WRITE",
    recoveryId: null,
    quarantined: true,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: "" }]),
    teamMembership: {
      findUnique: vi.fn().mockResolvedValue({ role: "ADMIN" }),
    },
    browserRuntimeSession: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(session),
      findUnique: vi.fn().mockResolvedValue(session),
      findMany: vi.fn().mockResolvedValue([session]),
      updateMany: vi.fn().mockImplementation(async ({ data }) => {
        Object.assign(session, data);
        return { count: 1 };
      }),
    },
    runtimeSessionRecovery: {
      findFirst: vi.fn().mockResolvedValue(recovery),
      findUnique: vi.fn().mockResolvedValue(recovery),
      update: vi.fn().mockImplementation(async ({ data }) => {
        Object.assign(recovery, data, { version: recovery.version + 1 });
        return recovery;
      }),
    },
    sessionClosureEvidence: {
      findUnique: vi.fn().mockResolvedValue({
        id: "proof-1",
        sessionId: session.id,
        sessionFence: session.fencingToken,
        leaseDigest: leaseDigest(session.leaseToken),
        recoveryId: recovery.id,
      }),
    },
    agentRuntimeTask: {
      findUnique: vi.fn().mockResolvedValue(owner),
      updateMany: vi.fn().mockImplementation(async ({ data }) => {
        Object.assign(owner, data);
        return { count: 1 };
      }),
      create: vi.fn(),
    },
    executionResourceLease: {
      findMany: vi.fn().mockImplementation(async () => (lease ? [lease] : [])),
      deleteMany: vi.fn().mockImplementation(async ({ where }) => {
        if (
          !lease ||
          (where.mode && where.mode !== lease.mode) ||
          (where.recoveryId && where.recoveryId !== lease.recoveryId)
        )
          return { count: 0 };
        lease = null;
        return { count: 1 };
      }),
      updateMany: vi.fn().mockImplementation(async ({ data }) => {
        if (!lease) return { count: 0 };
        Object.assign(lease, data);
        return { count: 1 };
      }),
      count: vi
        .fn()
        .mockImplementation(async () => (lease?.quarantined ? 1 : 0)),
      create: vi.fn(),
    },
    browserRuntimeSlot: { deleteMany: vi.fn() },
    browserRuntimeProfileLease: { deleteMany: vi.fn() },
    browserHumanControlLease: { deleteMany: vi.fn() },
    auditEvent: { create: vi.fn() },
    runAttempt: { create: vi.fn() },
    runtimeRecoveryOutbox: { upsert: vi.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  return {
    service: new SessionRecoveryService(prisma as never),
    prisma,
    tx,
    session,
    owner,
    recovery,
    getLease: () => lease,
  };
}

beforeEach(() => vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("manual reconciliation through durable session recovery", () => {
  it("requires recovery ownership by the current team", async () => {
    const { service, tx } = fixture();
    tx.runtimeSessionRecovery.findFirst.mockResolvedValue(null as never);
    await expect(
      service.resolveWriteOutcome(current, "recovery-1", input),
    ).rejects.toThrow("not found");
    expect(tx.runtimeSessionRecovery.findFirst).toHaveBeenCalledWith({
      where: { id: "recovery-1", teamId: current.team.id },
    });
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
  });
  it("requires current administrator membership", async () => {
    const { service, tx } = fixture();
    tx.teamMembership.findUnique.mockResolvedValue({ role: "MEMBER" });
    await expect(
      service.resolveWriteOutcome(current, "recovery-1", input),
    ).rejects.toThrow("administrator");
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    { status: "CLOSED", closureVerifiedAt: null },
    { status: "LOST", closureVerifiedAt: null },
    { status: "CLOSING", closureVerifiedAt: new Date() },
    { status: "CLOSED", closureEvidenceId: null },
  ])("requires CLOSED state and positive evidence: $status", async (state) => {
    const { service, session, tx } = fixture();
    Object.assign(session, state);
    await expect(
      service.resolveWriteOutcome(current, "recovery-1", input),
    ).rejects.toThrow("closure proof");
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    expect(tx.agentRuntimeTask.updateMany).not.toHaveBeenCalled();
  });
  it("does not accept a timestamp or evidence ID without a durable matching proof", async () => {
    const { service, tx } = fixture();
    tx.sessionClosureEvidence.findUnique.mockResolvedValue(null as never);
    await expect(
      service.resolveWriteOutcome(current, "recovery-1", input),
    ).rejects.toThrow("durable closure evidence");
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
  });
  it.each(["PENDING", "RUNNING", "WAITING_HUMAN"])(
    "rejects an owner still %s",
    async (status) => {
      const { service, owner, tx } = fixture();
      owner.status = status;
      await expect(
        service.resolveWriteOutcome(current, "recovery-1", input),
      ).rejects.toThrow("must stop");
      expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    },
  );
  it.each(["QUEUED", "PREPARING", "RUNNING", "WAITING_HUMAN"])(
    "rejects a stopped owner while its Run remains %s",
    async (state) => {
      const { service, owner, tx } = fixture();
      owner.run.lifecycle = state;
      await expect(
        service.resolveWriteOutcome(current, "recovery-1", input),
      ).rejects.toThrow("must stop");
      expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    },
  );
  it.each(["PENDING", "CLOSING", "RETRY_SCHEDULED"])(
    "does not race an active Agent recovery %s",
    async (state) => {
      const { service, owner, tx } = fixture();
      owner.recoveryStatus = state;
      await expect(
        service.resolveWriteOutcome(current, "recovery-1", input),
      ).rejects.toThrow("lease recovery");
      expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    },
  );
  it("aborts when the owner CAS loses rather than silently releasing its guard", async () => {
    const { service, tx } = fixture();
    tx.agentRuntimeTask.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.resolveWriteOutcome(current, "recovery-1", input),
    ).rejects.toThrow("changed");
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    expect(tx.runtimeSessionRecovery.update).not.toHaveBeenCalled();
  });
  it("adopts old NORMAL leases and releases only this recovery's scope, with audit and no replay", async () => {
    const { service, tx, owner, recovery, getLease } = fixture();
    const result = await service.resolveWriteOutcome(
      current,
      recovery.id,
      input,
    );
    expect(result).toMatchObject({
      released: 1,
      writeOutcomeState: "RESOLVED",
    });
    expect(getLease()).toBeNull();
    expect(owner.recoveryStatus).toBe("RESOLVED");
    expect(tx.executionResourceLease.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: "session-1", recoveryId: "recovery-1" },
    });
    expect(tx.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "runtime.write_outcome.reconciled",
        actorUserId: current.user.id,
        metadata: {
          outcome: input.outcome,
          note: input.note,
          evidenceRefs: input.evidenceRefs,
          released: 1,
        },
      }),
    });
    expect(tx.runtimeRecoveryOutbox.upsert).toHaveBeenCalled();
    expect(tx.runAttempt.create).not.toHaveBeenCalled();
    expect(tx.agentRuntimeTask.create).not.toHaveBeenCalled();
  });
  it("propagates audit persistence failure to abort the entire release transaction", async () => {
    const { service, tx, prisma } = fixture();
    tx.auditEvent.create.mockRejectedValue(new Error("audit storage failed"));
    await expect(
      service.resolveWriteOutcome(current, "recovery-1", input),
    ).rejects.toThrow("audit storage failed");
    await expect(prisma.$transaction.mock.results[0]!.value).rejects.toThrow(
      "audit storage failed",
    );
    expect(tx.runtimeRecoveryOutbox.upsert).not.toHaveBeenCalled();
  });
  it("an exact idempotent retry preserves the first audited result", async () => {
    const { service, tx } = fixture();
    await service.resolveWriteOutcome(current, "recovery-1", input);
    expect(
      await service.resolveWriteOutcome(current, "recovery-1", input),
    ).toMatchObject({ released: 0, writeOutcomeState: "RESOLVED" });
    expect(tx.auditEvent.create).toHaveBeenCalledOnce();
  });
  it("rejects reuse of an idempotency key with altered business evidence", async () => {
    const { service } = fixture();
    await service.resolveWriteOutcome(current, "recovery-1", input);
    await expect(
      service.resolveWriteOutcome(current, "recovery-1", {
        ...input,
        outcome: "COMPENSATED",
      }),
    ).rejects.toThrow("different evidence");
  });
  it("rejects a stale client version before mutating guards", async () => {
    const { service, tx } = fixture();
    await expect(
      service.resolveWriteOutcome(current, "recovery-1", {
        ...input,
        expectedVersion: 2,
      }),
    ).rejects.toThrow("changed");
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
  });
  it("persists ownerless reconciliation so duplicate closure cannot recreate its quarantine", async () => {
    const { service, tx, session, recovery, getLease } = fixture();
    session.ownerTaskId = null;
    await service.resolveWriteOutcome(current, recovery.id, input);
    tx.executionResourceLease.updateMany.mockClear();
    await releaseVerifiedSessionResources(tx as never, session.id);
    expect(recovery.writeOutcomeState).toBe("RESOLVED");
    expect(getLease()).toBeNull();
    expect(tx.executionResourceLease.updateMany).not.toHaveBeenCalled();
  });
  it.each([
    ["cancel", "CANCELLED", "CANCELLED"],
    ["hitl-cancel", "CANCELLED", "CANCELLED"],
    ["hitl-inconclusive", "FAILED", "COMPLETED"],
    ["run-timeout", "TIMED_OUT", "TIMED_OUT"],
  ])(
    "keeps an intermediate WAITING_HUMAN result isolated through %s",
    async (_transition, status, lifecycle) => {
      const { service, tx, owner, session, recovery, getLease } = fixture();
      Object.assign(owner, {
        completionId: "intermediate-completion",
        result: { kind: "WAITING_HUMAN" },
        status: "WAITING_HUMAN",
        recoveryStatus: null,
      });
      owner.run.lifecycle = "WAITING_HUMAN";
      await releaseCompletedSessionData(tx as never, owner.id);
      expect(getLease()).not.toBeNull();
      Object.assign(owner, { status });
      owner.run.lifecycle = lifecycle;
      await releaseVerifiedSessionResources(tx as never, session.id);
      expect(getLease()?.quarantined).toBe(true);
      expect(owner.recoveryStatus).toBe("WRITE_OUTCOME_UNKNOWN");
      await service.resolveWriteOutcome(current, recovery.id, input);
      expect(getLease()).toBeNull();
      await releaseVerifiedSessionResources(tx as never, session.id);
      expect(owner.recoveryStatus).toBe("RESOLVED");
      expect(getLease()).toBeNull();
    },
  );
});
