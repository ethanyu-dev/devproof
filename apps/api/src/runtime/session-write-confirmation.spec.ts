import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SessionClosureService } from "./session-closure.service.js";
import { SessionRecoveryService } from "./session-recovery.service.js";
import { initialWriteState, leaseDigest } from "./session-recovery.state.js";
import { releaseCompletedSessionData } from "./session-resource-cleanup.js";
import type {
  AuthenticatedRuntimeContext,
  RuntimeClosureProof,
} from "./session-closure.types.js";

const context: AuthenticatedRuntimeContext = {
  runtimeId: "runtime-1",
  connectionId: "connection-1",
  connectionGeneration: 1n,
  negotiatedMinor: 14,
  capabilities: new Set(["closure-evidence-v1"]),
  hostInstanceId: "host-1",
  daemonInstanceId: "daemon-1",
};
const proof: RuntimeClosureProof = {
  sessionId: "session-1",
  fencingToken: "7",
  leaseToken: "session-lease",
  recoveryId: "recovery-1",
  requestId: "command-1",
  evidenceId: "evidence-1",
  hostInstanceId: "host-1",
  daemonInstanceId: "daemon-1",
  launchIdentityVersion: 1,
  method: "LIVE_SESSION_TERMINATED",
  networkRevoked: true,
  closureCompletedAt: new Date().toISOString(),
};

function fixture() {
  const session = {
    id: "session-1",
    teamId: "team-1",
    runtimeId: "runtime-1",
    purpose: "EXECUTION",
    status: "ACTIVE",
    leaseToken: proof.leaseToken,
    fencingToken: 7n,
    ownerTaskId: "task-1",
    ownerFencingToken: 3n,
    closureVerifiedAt: null,
    closureEvidenceId: null,
    launchHostInstanceId: "host-1",
    closedAt: null,
    quarantinedAt: null,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
  const owner = {
    id: "task-1",
    fencingToken: 3n,
    status: "RUNNING",
    completionId: null as string | null,
    result: null as unknown,
    recoveryStatus: null as string | null,
    run: { lifecycle: "RUNNING" },
  };
  const recovery = {
    id: "recovery-1",
    sessionId: session.id,
    teamId: session.teamId,
    runtimeId: session.runtimeId,
    expectedSessionFence: 7n,
    expectedLeaseDigest: leaseDigest(session.leaseToken),
    reason: "OBSERVED",
    closureState: "OBSERVED",
    version: 1,
    writeOutcomeState: "UNKNOWN",
    closureVerifiedAt: null,
    closureEvidenceId: null,
    resolvedAt: null,
  };
  let evidence: Record<string, unknown> | null = null;
  let lease: Record<string, unknown> | null = {
    sessionId: session.id,
    mode: "WRITE",
    origin: "NORMAL",
    quarantined: false,
  };
  const assignRecovery = (data: Record<string, unknown>) =>
    Object.assign(recovery, data, { version: recovery.version + 1 });
  const tx = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    browserRuntime: {
      findUnique: vi.fn().mockResolvedValue({
        id: "runtime-1",
        enabled: true,
        revokedAt: null,
        drainState: "NONE",
        status: "ONLINE",
        connectionId: context.connectionId,
        connectionGeneration: context.connectionGeneration,
        hostInstanceId: context.hostInstanceId,
        daemonInstanceId: context.daemonInstanceId,
      }),
    },
    browserRuntimeSession: {
      findUnique: vi.fn().mockResolvedValue(session),
      findUniqueOrThrow: vi.fn().mockResolvedValue(session),
      findMany: vi.fn().mockResolvedValue([session]),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(session, data);
        return { count: 1 };
      }),
    },
    runtimeSessionRecovery: {
      findUnique: vi.fn().mockResolvedValue(recovery),
      findUniqueOrThrow: vi.fn().mockResolvedValue(recovery),
      update: vi.fn(async ({ data }) => assignRecovery(data)),
      updateMany: vi.fn(async ({ data }) => {
        assignRecovery(data);
        return { count: 1 };
      }),
    },
    agentRuntimeTask: {
      findUnique: vi.fn().mockResolvedValue(owner),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(owner, data);
        return { count: 1 };
      }),
    },
    executionResourceLease: {
      findMany: vi.fn(async () => (lease ? [lease] : [])),
      updateMany: vi.fn(async ({ data }) => {
        if (lease) Object.assign(lease, data);
        return { count: lease ? 1 : 0 };
      }),
      deleteMany: vi.fn(async ({ where }) => {
        if (lease && (!where.mode || where.mode === lease.mode)) {
          lease = null;
          return { count: 1 };
        }
        return { count: 0 };
      }),
      count: vi.fn(async () => (lease?.quarantined ? 1 : 0)),
    },
    browserRuntimeCommand: {
      findUnique: vi.fn().mockResolvedValue({
        id: "command-1",
        commandType: "session.close",
        sessionId: session.id,
        leaseToken: session.leaseToken,
        fencingToken: session.fencingToken,
        payload: {
          recovery: { recoveryId: recovery.id, requestId: "command-1" },
        },
      }),
    },
    sessionClosureEvidence: {
      findUnique: vi.fn(async () => evidence),
      create: vi.fn(
        async ({ data }) => (evidence = { id: "proof-row-1", ...data }),
      ),
    },
    browserRuntimeSlot: { deleteMany: vi.fn() },
    browserRuntimeProfileLease: { deleteMany: vi.fn() },
    browserHumanControlLease: { deleteMany: vi.fn() },
    browserExecution: { updateMany: vi.fn() },
    runtimeRecoveryPermit: { deleteMany: vi.fn() },
    browserRuntimeEvent: { create: vi.fn() },
    runtimeRecoveryOutbox: { upsert: vi.fn() },
  };
  tx.$transaction.mockImplementation((callback) => callback(tx));
  return {
    tx,
    session,
    owner,
    recovery,
    getLease: () => lease,
    closure: new SessionClosureService(tx as never),
    recoveryService: new SessionRecoveryService(tx as never),
  };
}
function complete(owner: ReturnType<typeof fixture>["owner"]) {
  Object.assign(owner, {
    status: "SUCCEEDED",
    completionId: "complete-1",
    result: { kind: "VERIFICATION_COMPLETED", verdict: "PASSED" },
  });
}
beforeEach(() => vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("normal write completion and physical closure ordering", () => {
  it("refreshes an OBSERVED UNKNOWN recovery when its matching owner finishes before closure", async () => {
    const { owner, recoveryService, closure, recovery, getLease } = fixture();
    complete(owner);
    await recoveryService.request("session-1", "NORMAL_CLOSE", {
      explicitClose: true,
    });
    expect(recovery.writeOutcomeState).toBe("CONFIRMED");
    expect(recovery.resolvedAt).toBeNull();
    await closure.acceptRuntimeEvidence(context, proof);
    expect(recovery.closureState).toBe("VERIFIED");
    expect(recovery.resolvedAt).toBeInstanceOf(Date);
    expect(getLease()).toBeNull();
  });

  it("rechecks the owner outcome at proof acceptance even when the close request predated completion", async () => {
    const { owner, recoveryService, closure, recovery, getLease } = fixture();
    await recoveryService.request("session-1", "NORMAL_CLOSE", {
      explicitClose: true,
    });
    expect(recovery.writeOutcomeState).toBe("UNKNOWN");
    complete(owner);
    await closure.acceptRuntimeEvidence(context, proof);
    expect(recovery.writeOutcomeState).toBe("CONFIRMED");
    expect(getLease()).toBeNull();
  });

  it("releases a closed session's guard when the matching owner subsequently supplies its final result", async () => {
    const { tx, owner, closure, recovery, getLease } = fixture();
    await closure.acceptRuntimeEvidence(context, proof);
    expect(recovery.writeOutcomeState).toBe("UNKNOWN");
    expect(getLease()?.quarantined).toBe(true);
    complete(owner);
    await releaseCompletedSessionData(tx as never, owner.id);
    expect(recovery.writeOutcomeState).toBe("CONFIRMED");
    expect(getLease()).toBeNull();
  });

  it.each(["duplicate proof", "recovery rediscovery"])(
    "%s releases an already closed guard after learning its matching owner's result",
    async (signal) => {
      const { owner, closure, recoveryService, recovery, getLease } = fixture();
      await closure.acceptRuntimeEvidence(context, proof);
      complete(owner);
      if (signal === "duplicate proof")
        await closure.acceptRuntimeEvidence(context, proof);
      else await recoveryService.request("session-1", "ADMISSION_BLOCKED");
      expect(recovery.writeOutcomeState).toBe("CONFIRMED");
      expect(getLease()).toBeNull();
    },
  );

  it("never applies a newer owner epoch's result to an older browser or quarantines that new owner", async () => {
    const { tx, session, owner, closure, recovery, getLease } = fixture();
    owner.fencingToken = 4n;
    complete(owner);
    expect(await initialWriteState(tx as never, session as never)).toBe(
      "UNKNOWN",
    );
    await closure.acceptRuntimeEvidence(context, proof);
    await releaseCompletedSessionData(tx as never, owner.id);
    expect(recovery.writeOutcomeState).toBe("UNKNOWN");
    expect(getLease()?.quarantined).toBe(true);
    expect(owner.recoveryStatus).toBeNull();
  });
});
