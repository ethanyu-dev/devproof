import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type BrowserRuntimeSession } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Never load application dotenv files, production services, or external Runtime RPCs.
vi.mock("../config/env.js", () => ({
  env: () => ({
    RUNTIME_LEASE_SECONDS: 90,
    AGENT_RUNTIME_TASK_LEASE_SECONDS: 90,
    RUNTIME_SESSION_RECOVERY_ENABLED: true,
    RUNTIME_DATA_RETENTION_DAYS: 30,
  }),
}));
import type { AuthContext } from "../auth/auth.types.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { RetentionWorker } from "../observability/retention-worker.service.js";
import { BrowserExecutionRunner } from "../verification/browser-execution-runner.service.js";
import { businessEnvironmentKey } from "../verification/execution-concurrency.js";
import { SessionClosureService } from "./session-closure.service.js";
import type {
  AuthenticatedRuntimeContext,
  RuntimeClosureProof,
} from "./session-closure.types.js";
import { SessionRecoveryService } from "./session-recovery.service.js";
import { SessionRecoveryWorker } from "./session-recovery.worker.js";
import { leaseDigest } from "./session-recovery.state.js";
import { releaseCompletedSessionData } from "./session-resource-cleanup.js";

const previousRecoveryEnabled = process.env.RUNTIME_SESSION_RECOVERY_ENABLED;
const connectionString = process.env.DEVPROOF_CONCURRENCY_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("Run the disposable-Postgres concurrency launcher.");
const destination = new URL(connectionString);
if (
  destination.hostname !== "127.0.0.1" ||
  destination.username !== "devproof_test" ||
  !/^\/devproof_concurrency_test_[a-f\d]{8}$/u.test(destination.pathname)
) {
  throw new Error("Refusing recovery tests against a non-disposable database.");
}
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString, max: 20 }),
});
const recoveries = new SessionRecoveryService(db as never);
const closures = new SessionClosureService(db as never);
const retention = new RetentionWorker(
  db as never,
  {} as never,
  {} as never,
) as unknown as { purgeRuntimeData(): Promise<void> };
const runner = new BrowserExecutionRunner(
  db as never,
  {} as never,
  {} as never,
  {} as never,
  recoveries,
  closures,
);
const targetUrl = "https://recovery-fixture.example.test/app";
const rootKey = businessEnvironmentKey(targetUrl);
let teamId: string;
let runtimeId: string;
let admin: AuthContext;
let context: AuthenticatedRuntimeContext;

beforeEach(async () => {
  process.env.RUNTIME_SESSION_RECOVERY_ENABLED = "true";
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "runtime_recovery_permits", "runtime_recovery_outbox", "session_closure_evidence", "runtime_session_recoveries", "runtime_drain_attestations", "object_storage_deletion_tasks", "teams", "users" RESTART IDENTITY CASCADE',
  );
  const team = await db.team.create({
    data: {
      slug: randomUUID(),
      name: "Disposable recovery fixture",
      feishuTenantKey: randomUUID(),
    },
  });
  teamId = team.id;
  const user = await db.user.create({
    data: {
      name: "Recovery administrator",
      memberships: { create: { teamId, role: "ADMIN" } },
    },
  });
  admin = { sessionId: randomUUID(), team, user };
  const runtime = await db.browserRuntime.create({
    data: {
      teamId,
      instanceKey: randomUUID(),
      name: "Proof-capable fixture",
      tokenHash: randomUUID(),
      tokenHint: "test",
      status: "ONLINE",
      enabled: true,
      protocolMajor: 1,
      protocolMinor: 14,
      maxConcurrency: 8,
      capabilities: ["browser", "session-permits-v1", "closure-evidence-v1"],
      connectionId: randomUUID(),
      connectionGeneration: 1n,
      hostInstanceId: "original-host",
      daemonInstanceId: "original-daemon",
    },
  });
  runtimeId = runtime.id;
  context = {
    runtimeId,
    connectionId: runtime.connectionId!,
    connectionGeneration: 1n,
    negotiatedMinor: 14,
    capabilities: new Set(["closure-evidence-v1"]),
    hostInstanceId: "original-host",
    daemonInstanceId: "original-daemon",
  };
});
afterAll(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "runtime_recovery_permits", "runtime_recovery_outbox", "session_closure_evidence", "runtime_session_recoveries", "runtime_drain_attestations", "object_storage_deletion_tasks" CASCADE',
  );
  await db.$disconnect();
  if (previousRecoveryEnabled === undefined)
    delete process.env.RUNTIME_SESSION_RECOVERY_ENABLED;
  else process.env.RUNTIME_SESSION_RECOVERY_ENABLED = previousRecoveryEnabled;
});

async function legacySession(slotNumber = 0) {
  return db.browserRuntimeSession.create({
    data: {
      teamId,
      runtimeId,
      status: "LOST",
      profileMode: "EPHEMERAL",
      profileKey: `legacy-${randomUUID()}`,
      purpose: "EXECUTION",
      slotNumber,
      leaseToken: randomUUID(),
      fencingToken: BigInt(slotNumber + 10),
      leaseExpiresAt: new Date(Date.now() - 60_000),
      protocolMajor: 1,
      protocolMinor: 12,
      closedAt: new Date(Date.now() - 60_000),
      launchHostInstanceId: "original-host",
      lastError: { code: "CLOSE_FAILED" },
    },
  });
}

/** Real atomic allocation, without browser startup or any RPC mock affecting admission. */
function allocate(binding?: {
  browserExecutionId: string;
  allocationToken: string;
}) {
  const allocateSession = runner as unknown as {
    allocateSession(input: {
      teamId: string;
      runtimeId: string;
      profileKey: string;
      profileMode: "EPHEMERAL";
      slotNumber: number;
      leaseExpiresAt: Date;
      leaseToken: string;
      targetUrl: string;
      browserExecutionId?: string;
      allocationToken?: string;
    }): Promise<BrowserRuntimeSession>;
  };
  return allocateSession.allocateSession({
    teamId,
    runtimeId,
    profileKey: randomUUID(),
    profileMode: "EPHEMERAL",
    slotNumber: 7,
    leaseExpiresAt: new Date(Date.now() + 90_000),
    leaseToken: randomUUID(),
    targetUrl,
    ...binding,
  });
}

async function executionRun(
  accessMode: "READ_ONLY" | "MUTATING",
  lifecycle: "RUNNING" | "QUEUED",
) {
  const deadline = new Date(Date.now() + 600_000);
  return db.executionRun.create({
    data: {
      teamId,
      idempotencyKey: randomUUID(),
      goal: "Verify confirmed business outcome recovery",
      lifecycle,
      criteriaSnapshot: [],
      environmentSnapshot: { targetUrl },
      concurrencyPolicy: { accessMode },
      traceId: randomUUID().replaceAll("-", ""),
      deadlineAt: deadline,
      initialDeadlineAt: deadline,
      hardDeadlineAt: deadline,
      attempts: {
        create: {
          number: 1,
          status: lifecycle === "RUNNING" ? "RUNNING" : "PENDING",
          inputSnapshot: {},
        },
      },
    },
    include: { attempts: true },
  });
}

async function allocateReader() {
  const run = await executionRun("READ_ONLY", "QUEUED");
  const allocationToken = randomUUID();
  const execution = await db.browserExecution.create({
    data: {
      runId: run.id,
      attemptId: run.attempts[0]!.id,
      status: "ALLOCATING",
      allocationToken,
      input: { targetUrl },
    },
  });
  return allocate({ browserExecutionId: execution.id, allocationToken });
}

async function observedWriter() {
  const run = await executionRun("MUTATING", "RUNNING");
  const owner = await db.agentRuntimeTask.create({
    data: {
      runId: run.id,
      attemptId: run.attempts[0]!.id,
      capability: "browser.verify",
      snapshot: {},
      status: "RUNNING",
      fencingToken: 1n,
      leaseOwner: "fixture-owner",
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 90_000),
      deadlineAt: run.deadlineAt,
    },
  });
  const created = await legacySession();
  const session = await db.browserRuntimeSession.update({
    where: { id: created.id },
    data: {
      status: "ACTIVE",
      closedAt: null,
      ownerTaskId: owner.id,
      ownerFencingToken: 1n,
      leaseExpiresAt: new Date(Date.now() + 90_000),
      executionPermitExpiresAt: new Date(Date.now() + 90_000),
    },
  });
  await db.browserExecution.create({
    data: {
      runId: run.id,
      attemptId: run.attempts[0]!.id,
      runtimeSessionId: session.id,
      status: "ACTIVE",
      input: { targetUrl },
    },
  });
  await db.executionResourceLease.create({
    data: { sessionId: session.id, rootKey, resourceKey: "", mode: "WRITE" },
  });
  const recovery = await recoveries.request(
    session.id,
    "PERIODIC_RECONCILIATION",
  );
  expect(recovery).toMatchObject({
    closureState: "OBSERVED",
    writeOutcomeState: "UNKNOWN",
  });
  expect(
    await db.executionResourceLease.findFirstOrThrow({
      where: { sessionId: session.id },
    }),
  ).toMatchObject({ quarantined: false });
  async function completeOwner(fence = 1n) {
    await db.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      await tx.agentRuntimeTask.update({
        where: { id: owner.id },
        data: {
          status: "SUCCEEDED",
          completionId: randomUUID(),
          result: { kind: "VERIFICATION_COMPLETED" },
          fencingToken: fence,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
        },
      });
      await tx.executionRun.update({
        where: { id: run.id },
        data: {
          lifecycle: "COMPLETED",
          executionDisposition: "EXECUTED",
          verdict: "PASSED",
          finishedAt: new Date(),
        },
      });
      await releaseCompletedSessionData(tx, owner.id);
    });
  }
  return { run, owner, session, recovery, completeOwner };
}

async function closeProof(
  session: BrowserRuntimeSession,
): Promise<RuntimeClosureProof> {
  const request = await recoveries.prepareClose(session.id, randomUUID());
  return {
    evidenceId: randomUUID(),
    recoveryId: request.recoveryId,
    requestId: request.requestId,
    sessionId: session.id,
    leaseToken: session.leaseToken,
    fencingToken: session.fencingToken.toString(),
    hostInstanceId: "original-host",
    daemonInstanceId: "original-daemon",
    launchIdentityVersion: 1,
    method: "LIVE_SESSION_TERMINATED",
    networkRevoked: true,
    closureCompletedAt: new Date().toISOString(),
  };
}

async function resolveInput(recoveryId: string) {
  const row = await db.runtimeSessionRecovery.findUniqueOrThrow({
    where: { id: recoveryId },
  });
  return {
    expectedVersion: row.version,
    idempotencyKey: randomUUID(),
    outcome: "VERIFIED" as const,
    note: "Verified the original business state against the audit record.",
    evidenceRefs: ["fixture://business-audit/verified"],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForAdvisoryWaiters(minimum: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
    if (Number(rows[0]?.waiting) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    "The competing transactions did not reach the real PostgreSQL resource lock.",
  );
}

async function expectAdmissionBlocked() {
  const result = await Promise.allSettled([allocate()]);
  expect(result[0]?.status).toBe("rejected");
  if (result[0]?.status === "rejected")
    expect(result[0].reason).toMatchObject({
      reason: expect.stringMatching(/^(DATA_LOCK|LEASE_RECOVERY)$/u),
    });
}

function runtimeArtifact(sessionId: string) {
  return db.browserRuntimeArtifact.create({
    data: {
      sessionId,
      kind: "SCREENSHOT",
      storageKey: `fixture/retained-evidence/${randomUUID()}`,
      contentType: "image/png",
      byteSize: 4,
      sha256: "a".repeat(64),
    },
  });
}

describe("verified session recovery against real PostgreSQL", () => {
  it.each(["unverified", "verified with unknown write"] as const)(
    "retains expired %s sessions, evidence, and guards during artifact retention",
    async (state) => {
      const session = await legacySession();
      await db.executionResourceLease.create({
        data: {
          sessionId: session.id,
          rootKey,
          resourceKey: "",
          mode: "WRITE",
          quarantined: true,
        },
      });
      const recovery = await recoveries.request(
        session.id,
        "RETENTION_FIXTURE",
      );
      if (state === "verified with unknown write") {
        await closures.acceptRuntimeEvidence(
          context,
          await closeProof(session),
        );
      }
      // Backdate only retention eligibility, preserving real closure evidence.
      await db.browserRuntimeSession.update({
        where: { id: session.id },
        data: { closedAt: new Date(Date.now() - 60 * 86_400_000) },
      });
      const artifact = await runtimeArtifact(session.id);
      await retention.purgeRuntimeData();
      expect(
        await db.browserRuntimeSession.findUnique({
          where: { id: session.id },
        }),
      ).toMatchObject({
        status: state === "unverified" ? "LOST" : "CLOSED",
      });
      expect(
        await db.runtimeSessionRecovery.findUnique({
          where: { id: recovery.id },
        }),
      ).toMatchObject({ writeOutcomeState: "UNKNOWN", resolvedAt: null });
      expect(
        await db.executionResourceLease.findFirstOrThrow({
          where: { sessionId: session.id },
        }),
      ).toMatchObject({ recoveryId: recovery.id, quarantined: true });
      expect(
        await db.sessionClosureEvidence.count({
          where: { sessionId: session.id },
        }),
      ).toBe(state === "unverified" ? 0 : 1);
      expect(
        await db.browserRuntimeArtifact.count({ where: { id: artifact.id } }),
      ).toBe(1);
      expect(
        await db.objectStorageDeletionTask.count({
          where: { storageKey: artifact.storageKey },
        }),
      ).toBe(0);
      await expect(allocateReader()).rejects.toMatchObject({
        reason: "LEASE_RECOVERY",
      });
    },
  );

  it("purges unreferenced settled artifacts while retaining RunEvidence and the recovery audit trail", async () => {
    const writer = await observedWriter();
    await writer.completeOwner();
    const proof = await closeProof(writer.session);
    await closures.acceptRuntimeEvidence(context, proof);
    await db.browserRuntimeSession.update({
      where: { id: writer.session.id },
      data: { closedAt: new Date(Date.now() - 60 * 86_400_000) },
    });
    const disposable = await runtimeArtifact(writer.session.id);
    const referenced = await runtimeArtifact(writer.session.id);
    const runEvidence = await db.runEvidence.create({
      data: {
        teamId,
        runId: writer.run.id,
        attemptId: writer.run.attempts[0]!.id,
        runtimeArtifactId: referenced.id,
        externalId: randomUUID(),
        kind: "SCREENSHOT",
      },
    });
    await retention.purgeRuntimeData();
    expect(
      await db.browserRuntimeArtifact.findUnique({
        where: { id: disposable.id },
      }),
    ).toBeNull();
    expect(
      await db.objectStorageDeletionTask.count({
        where: { storageKey: disposable.storageKey },
      }),
    ).toBe(1);
    expect(
      await db.browserRuntimeArtifact.findUnique({
        where: { id: referenced.id },
      }),
    ).toMatchObject({ sessionId: writer.session.id });
    expect(
      await db.objectStorageDeletionTask.count({
        where: { storageKey: referenced.storageKey },
      }),
    ).toBe(0);
    expect(
      await db.runEvidence.findUnique({ where: { id: runEvidence.id } }),
    ).toMatchObject({ runtimeArtifactId: referenced.id });
    expect(
      await db.browserRuntimeSession.findUnique({
        where: { id: writer.session.id },
      }),
    ).toMatchObject({
      status: "CLOSED",
      closureEvidenceId: expect.any(String),
    });
    expect(
      await db.runtimeSessionRecovery.findUnique({
        where: { id: writer.recovery.id },
      }),
    ).toMatchObject({
      closureState: "VERIFIED",
      writeOutcomeState: "CONFIRMED",
      resolvedAt: expect.any(Date),
    });
    expect(
      await db.sessionClosureEvidence.count({
        where: { sessionId: writer.session.id },
      }),
    ).toBe(1);
    expect(
      await db.browserRuntimeCommand.count({
        where: { id: proof.requestId },
      }),
    ).toBe(1);
  });

  it.each(["before", "after"] as const)(
    "accepts a normal WRITE outcome completed %s physical closure and releases the same-root reader",
    async (order) => {
      const writer = await observedWriter();
      if (order === "before") await writer.completeOwner();
      const proof = await closeProof(writer.session);
      await closures.acceptRuntimeEvidence(context, proof);
      if (order === "after") {
        expect(
          await db.executionResourceLease.findFirstOrThrow({
            where: { sessionId: writer.session.id },
          }),
        ).toMatchObject({ quarantined: true });
        await writer.completeOwner();
      }
      expect(
        await db.runtimeSessionRecovery.findUniqueOrThrow({
          where: { id: writer.recovery.id },
        }),
      ).toMatchObject({
        closureState: "VERIFIED",
        writeOutcomeState: "CONFIRMED",
        resolvedAt: expect.any(Date),
      });
      expect(
        await db.executionResourceLease.count({
          where: { sessionId: writer.session.id },
        }),
      ).toBe(0);
      const reader = await allocateReader();
      expect(
        await db.executionResourceLease.findFirstOrThrow({
          where: { sessionId: reader.id },
        }),
      ).toMatchObject({ rootKey, mode: "READ", quarantined: false });
    },
  );

  it("cannot use another owner fence's completion to settle the old WRITE outcome", async () => {
    const writer = await observedWriter();
    await writer.completeOwner(2n);
    const proof = await closeProof(writer.session);
    await closures.acceptRuntimeEvidence(context, proof);
    expect(
      await db.runtimeSessionRecovery.findUniqueOrThrow({
        where: { id: writer.recovery.id },
      }),
    ).toMatchObject({
      closureState: "VERIFIED",
      writeOutcomeState: "UNKNOWN",
      resolvedAt: null,
    });
    expect(
      await db.executionResourceLease.findFirstOrThrow({
        where: { sessionId: writer.session.id },
      }),
    ).toMatchObject({ quarantined: true });
    expect(
      await db.agentRuntimeTask.findUniqueOrThrow({
        where: { id: writer.owner.id },
      }),
    ).toMatchObject({ fencingToken: 2n, recoveryStatus: null });
    await expect(allocateReader()).rejects.toMatchObject({
      reason: "LEASE_RECOVERY",
    });
  });

  it("keeps legacy data protected while closure evidence competes with new admission", async () => {
    const session = await legacySession();
    // Represents a discovered pre-upgrade row whose guard has not yet been backfilled.
    // No production helper is mocked; closure must create the missing guard itself.
    const recovery = await db.runtimeSessionRecovery.create({
      data: {
        teamId,
        runtimeId,
        sessionId: session.id,
        expectedSessionFence: session.fencingToken,
        expectedLeaseDigest: leaseDigest(session.leaseToken),
        reason: "LEGACY_BACKFILL",
        observedProtocolMajor: 1,
        observedProtocolMinor: 12,
        closureState: "REQUESTED",
        writeOutcomeState: "UNKNOWN",
        scopeSnapshot: [{ rootKey: "*", resourceKey: "", mode: "WRITE" }],
        scopeProvenance: "UNKNOWN",
        aliasRegistryVersion: "fixture",
        nextAttemptAt: new Date(),
      },
    });
    const requestId = randomUUID();
    await db.browserRuntimeCommand.create({
      data: {
        id: requestId,
        sessionId: session.id,
        commandType: "session.close",
        source: "SYSTEM",
        leaseToken: session.leaseToken,
        fencingToken: session.fencingToken,
        deadlineAt: new Date(Date.now() + 90_000),
        payload: {
          recovery: recoveries.closePayload(recovery.id, requestId, session),
        },
      },
    });
    const proof: RuntimeClosureProof = {
      evidenceId: randomUUID(),
      recoveryId: recovery.id,
      requestId,
      sessionId: session.id,
      leaseToken: session.leaseToken,
      fencingToken: session.fencingToken.toString(),
      hostInstanceId: "original-host",
      daemonInstanceId: "original-daemon",
      launchIdentityVersion: 1,
      method: "LIVE_SESSION_TERMINATED",
      networkRevoked: true,
      closureCompletedAt: new Date().toISOString(),
    };
    expect(await db.executionResourceLease.count()).toBe(0);
    const held = deferred();
    const release = deferred();
    const barrier = db.$transaction(
      async (tx) => {
        await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
        held.resolve();
        await release.promise;
      },
      { timeout: 10_000 },
    );
    await held.promise;
    const competing = Promise.allSettled([
      closures.acceptRuntimeEvidence(context, proof),
      allocate(),
    ]);
    try {
      await waitForAdvisoryWaiters(2);
    } finally {
      release.resolve();
      await barrier;
    }
    const [closed, admitted] = await competing;
    expect(closed?.status).toBe("fulfilled");
    expect(admitted?.status).toBe("rejected");
    expect(
      await db.browserRuntimeSession.findUnique({ where: { id: session.id } }),
    ).toMatchObject({
      status: "CLOSED",
      closureEvidenceId: expect.any(String),
    });
    expect(
      await db.executionResourceLease.findMany({
        where: { sessionId: session.id },
      }),
    ).toMatchObject([
      {
        rootKey: "*",
        mode: "WRITE",
        quarantined: true,
        origin: "LEGACY_RECOVERY",
        recoveryId: recovery.id,
      },
    ]);
    await expectAdmissionBlocked();
    expect(await db.browserRuntimeSlot.count()).toBe(0);
  });

  it("adopts existing NORMAL quarantine and actually unblocks admission after business verification", async () => {
    const session = await legacySession();
    const lease = await db.executionResourceLease.create({
      data: {
        sessionId: session.id,
        rootKey,
        resourceKey: "",
        mode: "WRITE",
        quarantined: true,
      },
    });
    await db.browserRuntimeSlot.create({
      data: {
        runtimeId,
        sessionId: session.id,
        slotNumber: 0,
        leaseToken: session.leaseToken,
        fencingToken: session.fencingToken,
        expiresAt: session.leaseExpiresAt,
      },
    });
    const proof = await closeProof(session);
    expect(
      await db.executionResourceLease.findUnique({ where: { id: lease.id } }),
    ).toMatchObject({ recoveryId: proof.recoveryId, origin: "NORMAL" });
    await closures.acceptRuntimeEvidence(context, proof);
    expect(
      await db.browserRuntimeSlot.count({ where: { sessionId: session.id } }),
    ).toBe(0);
    await expectAdmissionBlocked();
    await recoveries.resolveWriteOutcome(
      admin,
      proof.recoveryId,
      await resolveInput(proof.recoveryId),
    );
    expect(
      await db.executionResourceLease.count({
        where: { sessionId: session.id },
      }),
    ).toBe(0);
    const admitted = await allocate();
    expect(admitted.id).not.toBe(session.id);
    expect(
      await db.browserRuntimeSlot.count({ where: { sessionId: admitted.id } }),
    ).toBe(1);
  });

  it("cannot regress a successful close when a delayed failure commits concurrently", async () => {
    const session = await legacySession();
    const proof = await closeProof(session);
    await Promise.all([
      closures.acceptRuntimeEvidence(context, proof),
      closures.recordFailure({
        sessionId: session.id,
        expectedFencingToken: session.fencingToken.toString(),
        expectedLeaseToken: session.leaseToken,
        requestId: proof.requestId,
        errorCode: "CLOSE_DISPATCH_FAILED",
      }),
    ]);
    const closed = await db.browserRuntimeSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closureVerifiedAt).not.toBeNull();
    expect(closed.closureEvidenceId).not.toBeNull();
    expect(
      await closures.recordFailure({
        sessionId: session.id,
        expectedFencingToken: session.fencingToken.toString(),
        expectedLeaseToken: session.leaseToken,
        requestId: proof.requestId,
        errorCode: "CLOSE_FAILED",
      }),
    ).toEqual({ changed: false });
    expect(
      await db.runtimeSessionRecovery.findUnique({
        where: { id: proof.recoveryId },
      }),
    ).toMatchObject({ closureState: "VERIFIED" });
  });

  it("does not recreate a guard when evidence, scans, and business resolution race or replay", async () => {
    const session = await legacySession();
    const proof = await closeProof(session);
    await closures.acceptRuntimeEvidence(context, proof);
    const input = await resolveInput(proof.recoveryId);
    await Promise.all([
      recoveries.resolveWriteOutcome(admin, proof.recoveryId, input),
      closures.acceptRuntimeEvidence(context, {
        ...proof,
        evidenceId: randomUUID(),
      }),
    ]);
    await Promise.all([
      recoveries.request(session.id, "PERIODIC_RECONCILIATION"),
      closures.acceptRuntimeEvidence(context, proof),
      recoveries.resolveWriteOutcome(admin, proof.recoveryId, input),
    ]);
    expect(
      await db.executionResourceLease.count({
        where: { sessionId: session.id },
      }),
    ).toBe(0);
    expect(
      await db.runtimeSessionRecovery.findUnique({
        where: { id: proof.recoveryId },
      }),
    ).toMatchObject({
      closureState: "VERIFIED",
      writeOutcomeState: "RESOLVED",
    });
    expect(
      await db.sessionClosureEvidence.count({
        where: { sessionId: session.id },
      }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: {
          action: "runtime.write_outcome.reconciled",
          entityId: proof.recoveryId,
        },
      }),
    ).toBe(1);
  });

  it("serializes two workers on one Runtime and reuses the durable command on claim takeover", async () => {
    const sessions = await Promise.all([legacySession(0), legacySession(1)]);
    await Promise.all(
      sessions.map((session) =>
        recoveries.request(session.id, "TEST_LOST_SESSION"),
      ),
    );
    const first = new SessionRecoveryWorker(
      db as never,
      recoveries,
      closures,
      {} as never,
    );
    const second = new SessionRecoveryWorker(
      db as never,
      recoveries,
      closures,
      {} as never,
    );
    const batches = await Promise.all([first.claim(1), second.claim(1)]);
    const claimed = batches.flat();
    expect(claimed).toHaveLength(1);
    const original = claimed[0]!;
    expect(await db.runtimeRecoveryPermit.count({ where: { runtimeId } })).toBe(
      1,
    );
    expect(
      await db.browserRuntimeCommand.count({
        where: { commandType: "session.close" },
      }),
    ).toBe(1);
    const expired = new Date(Date.now() - 1_000);
    await db.$transaction([
      db.runtimeSessionRecovery.update({
        where: { id: original.id },
        data: { claimExpiresAt: expired, nextAttemptAt: expired },
      }),
      db.runtimeRecoveryPermit.update({
        where: { runtimeId },
        data: { claimExpiresAt: expired },
      }),
    ]);
    const takeover = await second.claim(20);
    expect(takeover).toHaveLength(1);
    expect(takeover[0]).toMatchObject({
      id: original.id,
      activeCommandId: original.activeCommandId,
      attempts: 1,
      claimVersion: 2,
    });
    expect(takeover[0]!.claimToken).not.toBe(original.claimToken);
    expect(
      await db.browserRuntimeCommand.count({
        where: { commandType: "session.close" },
      }),
    ).toBe(1);
  });

  it("serializes a new close claim against a late valid proof for the prior command", async () => {
    const session = await legacySession();
    const proof = await closeProof(session);
    const expired = new Date(Date.now() - 1_000);
    await db.$transaction([
      db.browserRuntimeCommand.update({
        where: { id: proof.requestId },
        data: { status: "TIMED_OUT", deadlineAt: expired },
      }),
      db.runtimeSessionRecovery.update({
        where: { id: proof.recoveryId },
        data: { nextAttemptAt: expired, claimExpiresAt: expired },
      }),
      db.runtimeRecoveryPermit.update({
        where: { runtimeId },
        data: { claimExpiresAt: expired },
      }),
    ]);
    const worker = new SessionRecoveryWorker(
      db as never,
      recoveries,
      closures,
      {} as never,
    );
    await Promise.all([
      closures.acceptRuntimeEvidence(context, proof),
      worker.claim(1),
    ]);
    expect(
      await db.browserRuntimeSession.findUnique({ where: { id: session.id } }),
    ).toMatchObject({
      status: "CLOSED",
      closureEvidenceId: expect.any(String),
    });
    expect(await db.runtimeRecoveryPermit.count({ where: { runtimeId } })).toBe(
      0,
    );
    expect(
      await db.sessionClosureEvidence.count({
        where: { sessionId: session.id },
      }),
    ).toBe(1);
    await expectAdmissionBlocked();
  });

  it("rejects proof from a replaced connection without releasing the old guard", async () => {
    const session = await legacySession();
    const proof = await closeProof(session);
    await db.browserRuntime.update({
      where: { id: runtimeId },
      data: { connectionGeneration: 2n, connectionId: randomUUID() },
    });
    await expect(
      closures.acceptRuntimeEvidence(context, proof),
    ).rejects.toThrow("superseded Runtime connection");
    expect(
      await db.browserRuntimeSession.findUnique({ where: { id: session.id } }),
    ).toMatchObject({ status: "LOST", closureVerifiedAt: null });
    await expectAdmissionBlocked();
  });
});
