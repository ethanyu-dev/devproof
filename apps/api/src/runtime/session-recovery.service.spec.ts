import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRecoveryService } from "./session-recovery.service.js";
import { SessionClosureService } from "./session-closure.service.js";
import {
  initialWriteState,
  isHealthySession,
  leaseDigest,
  materializeRecoveryGuards,
} from "./session-recovery.state.js";
import type {
  AuthenticatedRuntimeContext,
  RuntimeClosureProof,
} from "./session-closure.types.js";

const current = { team: { id: "team-1" }, user: { id: "admin-1" } } as never;
const now = new Date();
function setup() {
  const session = {
    id: "session-1",
    teamId: "team-1",
    runtimeId: "runtime-1",
    ownerTaskId: null,
    ownerFencingToken: null,
    fencingToken: 5n,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date(0),
    status: "LOST",
    closureVerifiedAt: null,
    closureEvidenceId: null,
    purpose: "EXECUTION",
    protocolMinor: 12,
    protocolMajor: 1,
    launchHostInstanceId: null,
    quarantinedAt: null,
    closedAt: null,
    launchIdentity: null,
    createdAt: now,
  };
  const recovery = {
    id: "recovery-1",
    teamId: session.teamId,
    runtimeId: session.runtimeId,
    sessionId: session.id,
    expectedSessionFence: session.fencingToken,
    expectedLeaseDigest: leaseDigest(session.leaseToken),
    reason: "TEST",
    closureState: "REQUESTED",
    closureVerifiedAt: null,
    closureEvidenceId: null,
    writeOutcomeState: "UNKNOWN",
    activeCommandId: "command-1",
    attempts: 1,
    claimToken: "claim-1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    nextAttemptAt: now,
    lastErrorCode: null,
    scopeSnapshot: [],
    sourceRunId: null,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    teamMembership: {
      findUnique: vi.fn().mockResolvedValue({ role: "ADMIN" }),
    },
    browserRuntime: {
      findUnique: vi.fn().mockResolvedValue({
        id: "runtime-1",
        enabled: true,
        revokedAt: null,
        drainState: "NONE",
        status: "ONLINE",
        connectionId: "connection-1",
        connectionGeneration: 3n,
        hostInstanceId: "host-1",
        daemonInstanceId: "daemon-1",
      }),
    },
    browserRuntimeSession: {
      findUnique: vi.fn().mockResolvedValue(session),
      findUniqueOrThrow: vi.fn().mockResolvedValue(session),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    runtimeSessionRecovery: {
      findUnique: vi.fn().mockResolvedValue(recovery),
      findUniqueOrThrow: vi.fn().mockResolvedValue(recovery),
      findFirst: vi.fn().mockResolvedValue(recovery),
      update: vi
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ ...recovery, ...data, version: 2 }),
        ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    executionResourceLease: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    browserExecution: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    verificationRun: { findFirst: vi.fn().mockResolvedValue(null) },
    agentRuntimeTask: { findUnique: vi.fn().mockResolvedValue(null) },
    humanIntervention: { findFirst: vi.fn().mockResolvedValue(null) },
    browserRuntimeCommand: {
      findUnique: vi.fn().mockResolvedValue({
        id: "command-1",
        sessionId: session.id,
        commandType: "session.close",
        leaseToken: session.leaseToken,
        fencingToken: session.fencingToken,
        payload: {
          recovery: { recoveryId: recovery.id, requestId: "command-1" },
        },
      }),
      count: vi.fn().mockResolvedValue(0),
    },
    sessionClosureEvidence: { findUnique: vi.fn().mockResolvedValue(null) },
    runtimeRecoveryOutbox: { upsert: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  tx.$transaction.mockImplementation((callback) => callback(tx));
  return { tx, session, recovery };
}
const context: AuthenticatedRuntimeContext = {
  runtimeId: "runtime-1",
  connectionId: "connection-1",
  connectionGeneration: 3n,
  negotiatedMinor: 14,
  capabilities: new Set(["closure-evidence-v1"]),
  hostInstanceId: "host-1",
  daemonInstanceId: "daemon-1",
};
const proof: RuntimeClosureProof = {
  evidenceId: "evidence-1",
  recoveryId: "recovery-1",
  requestId: "command-1",
  sessionId: "session-1",
  leaseToken: "lease-1",
  fencingToken: "5",
  hostInstanceId: "host-1",
  daemonInstanceId: "daemon-1",
  launchIdentityVersion: 1,
  method: "LIVE_SESSION_TERMINATED",
  networkRevoked: true,
  closureCompletedAt: new Date().toISOString(),
};

beforeEach(() => vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("recovery classification and business protection", () => {
  it("materializes a wildcard WRITE guard for an unscoped, ownerless legacy execution", async () => {
    const { tx, session, recovery } = setup();
    await materializeRecoveryGuards(
      tx as never,
      session as never,
      recovery as never,
    );
    expect(tx.executionResourceLease.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rootKey: "*",
        resourceKey: "",
        mode: "WRITE",
        origin: "LEGACY_RECOVERY",
        recoveryId: recovery.id,
        quarantined: true,
      }),
    });
  });
  it("adopts an existing NORMAL quarantine without broadening its resource scope", async () => {
    const { tx, session, recovery } = setup();
    tx.executionResourceLease.findMany.mockResolvedValue([
      {
        mode: "WRITE",
        rootKey: "origin:https://app.test",
        resourceKey: "customers/1",
        origin: "NORMAL",
      },
    ]);
    await materializeRecoveryGuards(
      tx as never,
      session as never,
      recovery as never,
    );
    expect(tx.executionResourceLease.create).not.toHaveBeenCalled();
    expect(tx.executionResourceLease.updateMany).toHaveBeenCalledWith({
      where: { sessionId: session.id },
      data: { recoveryId: recovery.id },
    });
  });
  it("never rebuilds a guard after durable ownerless RESOLVED", async () => {
    const { tx, session, recovery } = setup();
    await materializeRecoveryGuards(
      tx as never,
      session as never,
      { ...recovery, writeOutcomeState: "RESOLVED" } as never,
    );
    expect(tx.executionResourceLease.create).not.toHaveBeenCalled();
    expect(tx.executionResourceLease.updateMany).not.toHaveBeenCalled();
  });
  it("missing command history cannot establish NO_WRITE", async () => {
    const { tx, session } = setup();
    expect(
      await initialWriteState(
        tx as never,
        { ...session, protocolMinor: 14 } as never,
      ),
    ).toBe("UNKNOWN");
    expect(tx.browserRuntimeCommand.count).not.toHaveBeenCalled();
  });
  it("preserves a valid human-control permit even when no Agent lease is active", async () => {
    const { tx, session } = setup();
    const future = new Date(Date.now() + 60_000);
    expect(
      await isHealthySession(
        tx as never,
        {
          ...session,
          status: "HUMAN_CONTROL",
          leaseExpiresAt: future,
          humanControlExpiresAt: future,
        } as never,
        now,
      ),
    ).toBe(true);
  });
  it("does not stop an ownerless manual session with a live permit", async () => {
    const { tx, session } = setup();
    expect(
      await isHealthySession(
        tx as never,
        {
          ...session,
          status: "ACTIVE",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        } as never,
        now,
      ),
    ).toBe(true);
  });
});

describe("closure evidence trust boundary", () => {
  it.each([
    [
      "missing capability",
      { ...context, capabilities: new Set<string>() },
      proof,
    ],
    ["old negotiated protocol", { ...context, negotiatedMinor: 13 }, proof],
    ["another host", context, { ...proof, hostInstanceId: "host-2" }],
    ["wrong epoch", context, { ...proof, fencingToken: "6" }],
    [
      "expired connection generation",
      { ...context, connectionGeneration: 2n },
      proof,
    ],
    [
      "unknown launch identity",
      context,
      { ...proof, method: "IDENTIFIED_PROCESS_SET_TERMINATED" },
    ],
  ] as const)(
    "rejects %s without releasing resources",
    async (_name, auth, evidence) => {
      const { tx } = setup();
      await expect(
        new SessionClosureService(tx as never).acceptRuntimeEvidence(
          auth,
          evidence as RuntimeClosureProof,
        ),
      ).rejects.toThrow();
      expect(tx.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    { enabled: false },
    { revokedAt: new Date() },
    { drainState: "FROZEN" },
    { status: "OFFLINE" },
  ])(
    "rejects Runtime authority revoked during an in-flight proof: %j",
    async (change) => {
      const { tx } = setup();
      tx.browserRuntime.findUnique.mockResolvedValue({
        id: "runtime-1",
        enabled: true,
        revokedAt: null,
        drainState: "NONE",
        status: "ONLINE",
        connectionId: "connection-1",
        connectionGeneration: 3n,
        hostInstanceId: "host-1",
        daemonInstanceId: "daemon-1",
        ...change,
      } as never);
      await expect(
        new SessionClosureService(tx as never).acceptRuntimeEvidence(
          context,
          proof,
        ),
      ).rejects.toThrow("superseded");
      expect(tx.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
    },
  );

  it("refreshes a Profile once after the first verified closure, never on duplicate proof", async () => {
    const { tx, session, recovery } = setup();
    Object.assign(session, { userBrowserProfileId: "profile-1" });
    let evidence: Record<string, unknown> | null = null;
    tx.sessionClosureEvidence.findUnique.mockImplementation(
      async ({ where }) =>
        evidence &&
        (where.id === evidence.id || where.evidenceId === evidence.evidenceId)
          ? evidence
          : null,
    );
    Object.assign(tx.sessionClosureEvidence, {
      create: vi.fn(
        async ({ data }) => (evidence = { id: "proof-row-1", ...data }),
      ),
    });
    tx.browserRuntimeSession.updateMany.mockImplementation(async ({ data }) => {
      Object.assign(session, data);
      return { count: 1 };
    });
    tx.runtimeSessionRecovery.update.mockImplementation(async ({ data }) =>
      Object.assign(recovery, data, { version: 2 }),
    );
    Object.assign(tx.executionResourceLease, {
      count: vi.fn().mockResolvedValue(1),
    });
    Object.assign(tx.browserExecution, { updateMany: vi.fn() });
    const completeTx = Object.assign(tx, {
      userBrowserProfile: { updateMany: vi.fn() },
      browserRuntimeSlot: { deleteMany: vi.fn() },
      browserRuntimeProfileLease: { deleteMany: vi.fn() },
      browserHumanControlLease: { deleteMany: vi.fn() },
      runtimeRecoveryPermit: { deleteMany: vi.fn() },
      browserRuntimeEvent: { create: vi.fn() },
    });
    const service = new SessionClosureService(completeTx as never);
    await service.acceptRuntimeEvidence(context, proof);
    await service.acceptRuntimeEvidence(context, proof);
    expect(completeTx.userBrowserProfile.updateMany).toHaveBeenCalledOnce();
    const update = completeTx.userBrowserProfile.updateMany.mock.calls[0]![0];
    expect(update.where).toEqual({
      id: "profile-1",
      teamId: session.teamId,
      status: "READY",
    });
    expect(
      update.data.inactivityExpiresAt.getTime() -
        update.data.lastUsedAt.getTime(),
    ).toBe(30 * 24 * 60 * 60 * 1_000);
  });

  it("ignores a late failed close after a verified success", async () => {
    const { tx, session } = setup();
    tx.browserRuntimeSession.findUniqueOrThrow.mockResolvedValue({
      ...session,
      closureVerifiedAt: now,
      closureEvidenceId: "evidence-1",
      status: "CLOSED",
    });
    expect(
      await new SessionClosureService(tx as never).recordFailure({
        sessionId: session.id,
        expectedLeaseToken: session.leaseToken,
        expectedFencingToken: "5",
        errorCode: "TIMEOUT",
      }),
    ).toEqual({ changed: false });
    expect(tx.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
  });
  it("an expired Worker cannot record failure for its successor's request", async () => {
    const { tx, session } = setup();
    expect(
      await new SessionClosureService(tx as never).recordFailure({
        sessionId: session.id,
        expectedLeaseToken: session.leaseToken,
        expectedFencingToken: "5",
        requestId: "old-command",
        errorCode: "TIMEOUT",
      }),
    ).toEqual({ changed: false });
    expect(tx.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
  });
  it("rejects no-launch inference for an ordinary execution even with an empty audit", async () => {
    const { tx, session } = setup();
    await expect(
      new SessionClosureService(tx as never).acceptNeverLaunched(
        session.id,
        "5",
        session.leaseToken,
      ),
    ).rejects.toThrow("no complete no-launch audit");
    expect(tx.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
  });
});

describe("administrator actions", () => {
  it("checks current membership rather than authentication alone", async () => {
    const { tx } = setup();
    tx.teamMembership.findUnique.mockResolvedValue({ role: "MEMBER" });
    await expect(
      new SessionRecoveryService(tx as never).resolveWriteOutcome(
        current,
        "recovery-1",
        {
          expectedVersion: 1,
          idempotencyKey: "key",
          outcome: "VERIFIED",
          note: "Checked external records",
          evidenceRefs: ["audit:1"],
        },
      ),
    ).rejects.toThrow("administrator");
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
  });
  it("a capable Runtime reconnect wakes offline and unsupported-capability waits only", async () => {
    const { tx, recovery } = setup();
    tx.browserRuntime.findUnique.mockResolvedValue({
      id: "runtime-1",
      status: "ONLINE",
      enabled: true,
      capabilities: ["closure-evidence-v1"],
    } as never);
    const model = Object.assign(tx.runtimeSessionRecovery, {
      findMany: vi
        .fn()
        .mockResolvedValue([{ ...recovery, closureState: "WAITING_RUNTIME" }]),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        ...recovery,
        closureState: "REQUESTED",
        version: 2,
      }),
    });
    expect(
      await new SessionRecoveryService(tx as never).wakeRuntime("runtime-1"),
    ).toBe(1);
    expect(model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { closureState: "WAITING_RUNTIME" },
            {
              closureState: "NEEDS_OPERATOR",
              lastErrorCode: "UNSUPPORTED_CLOSURE_EVIDENCE",
            },
          ],
        }),
      }),
    );
    expect(tx.runtimeRecoveryOutbox.upsert).toHaveBeenCalledOnce();
  });

  it("a repeated explicit close cannot move a verified recovery back to CLOSING", async () => {
    const { tx, session, recovery } = setup();
    Object.assign(session, {
      status: "CLOSED",
      closureVerifiedAt: now,
      closureEvidenceId: "proof-1",
    });
    Object.assign(recovery, {
      closureState: "VERIFIED",
      closureVerifiedAt: now,
      closureEvidenceId: "proof-1",
      writeOutcomeState: "RESOLVED",
    });
    await expect(
      new SessionRecoveryService(tx as never).prepareClose(
        session.id,
        "new-command",
      ),
    ).rejects.toThrow("already has verified");
    expect(tx.runtimeSessionRecovery.update).not.toHaveBeenCalled();
  });

  it("rollout switch disables write actions, including explicit close", async () => {
    vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "false");
    const { tx } = setup();
    await expect(
      new SessionRecoveryService(tx as never).prepareClose(
        "session-1",
        "command-1",
      ),
    ).rejects.toThrow();
    expect(tx.$transaction).not.toHaveBeenCalled();
  });
});
