import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  RUNTIME_PROTOCOL,
  runtimeClientMessageSchema,
} from "@devproof/runtime-protocol";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// No dotenv, gateway connection, browser process, or production database.
vi.mock("../config/env.js", () => ({
  env: () => ({
    RUNTIME_LEASE_SECONDS: 90,
    RUNTIME_SESSION_RECOVERY_ENABLED: true,
    RUNTIME_GATEWAY_WS_URL: "ws://127.0.0.1:1/disposable-runtime-fixture",
  }),
}));

import type { AuthContext } from "../auth/auth.types.js";
import { BrowserRuntimeService } from "../console/browser-runtime.service.js";
import { RuntimeDrainService } from "./runtime-drain.service.js";
import { RuntimeGatewayService } from "./runtime-gateway.service.js";
import { SessionClosureService } from "./session-closure.service.js";
import type { AuthenticatedRuntimeContext } from "./session-closure.types.js";
import { SessionRecoveryService } from "./session-recovery.service.js";

const connectionString = process.env.DEVPROOF_CONCURRENCY_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("Use apps/api/scripts/test-execution-concurrency.mjs.");
const destination = new URL(connectionString);
if (
  destination.hostname !== "127.0.0.1" ||
  destination.username !== "devproof_test" ||
  !/^\/devproof_concurrency_test_[a-f\d]{8}$/u.test(destination.pathname)
)
  throw new Error(
    "Refusing drain resume tests against a non-disposable database.",
  );

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString, max: 20 }),
});
const previousRecoveryEnabled = process.env.RUNTIME_SESSION_RECOVERY_ENABLED;
const recoveries = new SessionRecoveryService(db as never);
const closures = new SessionClosureService(db as never);
const drains = new RuntimeDrainService(db as never, recoveries, closures);
const hub = { close: vi.fn() };
const redis = {
  isRuntimeOnline: vi.fn(async () => false),
  markRuntimeOffline: vi.fn(async () => undefined),
  disconnectOlderGateways: vi.fn(async () => undefined),
};
const runtimes = new BrowserRuntimeService(
  db as never,
  { record: vi.fn(async () => undefined) } as never,
  redis as never,
  hub as never,
  recoveries,
);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
let current: AuthContext;
let runtime: Awaited<ReturnType<typeof db.browserRuntime.create>>;
let profile: Awaited<ReturnType<typeof db.userBrowserProfile.create>>;
let session: Awaited<ReturnType<typeof db.browserRuntimeSession.create>>;
let taskId: string;

async function clearFixtures() {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "runtime_recovery_permits", "runtime_recovery_outbox", "session_closure_evidence", "runtime_session_recoveries", "runtime_drain_attestations", "teams", "users" RESTART IDENTITY CASCADE',
  );
}

beforeEach(async () => {
  process.env.RUNTIME_SESSION_RECOVERY_ENABLED = "true";
  await clearFixtures();
  hub.close.mockClear();
  const team = await db.team.create({
    data: {
      slug: randomUUID(),
      name: "Disposable drain resume fixture",
      feishuTenantKey: randomUUID(),
    },
  });
  const user = await db.user.create({
    data: {
      name: "Drain administrator",
      memberships: { create: { teamId: team.id, role: "ADMIN" } },
    },
  });
  current = { sessionId: randomUUID(), team, user };
  runtime = await db.browserRuntime.create({
    data: {
      teamId: team.id,
      instanceKey: `original-installation-${randomUUID()}`,
      name: "Original Runtime",
      tokenHash: digest(randomUUID()),
      tokenHint: "test",
      enabled: true,
      status: "ONLINE",
      connectionGeneration: 7n,
      connectionId: randomUUID(),
      hostInstanceId: "original-boot-scope",
      daemonInstanceId: randomUUID(),
      maxConcurrency: 4,
      networkAllowlist: ["private.example.test"],
      protocolMajor: 1,
      protocolMinor: 14,
      capabilities: ["session-permits-v1", "closure-evidence-v1"],
      fenceCounter: { create: { value: 17n } },
      routingRules: {
        create: {
          teamId: team.id,
          hostnamePattern: "drain-resume.example.test",
          priority: 42,
        },
      },
    },
  });
  profile = await db.userBrowserProfile.create({
    data: {
      teamId: team.id,
      ownerUserId: user.id,
      assignedRuntimeId: runtime.id,
      runtimeProfileKey: `retained-profile-${randomUUID()}`,
      displayName: "Retained login",
      scopeKey: randomUUID(),
      status: "READY",
      executionMode: "ISOLATED_AUTH",
      executionConcurrency: 4,
      authSnapshotGeneration: 3,
      authSnapshotCreatedAt: new Date(),
      lastVerifiedAt: new Date(),
      inactivityExpiresAt: new Date(Date.now() + 86_400_000),
      verificationUrl: "https://drain-resume.example.test/settings",
      grants: {
        create: {
          teamId: team.id,
          triggerSource: "CONSOLE",
          hostnamePattern: "drain-resume.example.test",
          consentedByUserId: user.id,
        },
      },
    },
  });
  const task = await db.taskExecution.create({
    data: {
      teamId: team.id,
      requestedByUserId: user.id,
      kind: "ISSUE_SPEC",
      sourceKind: "TEST",
      idempotencyKey: randomUUID(),
      title: "Retain logical profile binding",
      lifecycle: "CANCELLED",
      inputSnapshot: {},
      traceId: randomUUID().replaceAll("-", ""),
      deadlineAt: new Date(Date.now() + 600_000),
      profileBinding: {
        create: {
          strategy: "REQUESTER",
          status: "RESOLVED",
          unavailablePolicy: "WAIT_FOR_PROFILE",
          triggerSource: "CONSOLE",
          resolvedProfileId: profile.id,
          resolvedAt: new Date(),
        },
      },
    },
  });
  taskId = task.id;
  session = await db.browserRuntimeSession.create({
    data: {
      teamId: team.id,
      runtimeId: runtime.id,
      userBrowserProfileId: profile.id,
      status: "LOST",
      profileMode: "PERSISTENT",
      profileKey: profile.runtimeProfileKey,
      purpose: "EXECUTION",
      slotNumber: 0,
      leaseToken: randomUUID(),
      fencingToken: 17n,
      leaseExpiresAt: new Date(Date.now() - 60_000),
      protocolMajor: 1,
      protocolMinor: 10,
    },
  });
  await physicalSlot();
  await db.browserRuntimeProfileLease.create({
    data: {
      teamId: team.id,
      runtimeId: runtime.id,
      sessionId: session.id,
      profileKey: session.profileKey,
      leaseToken: session.leaseToken,
      fencingToken: session.fencingToken,
      expiresAt: session.leaseExpiresAt,
    },
  });
});

afterAll(async () => {
  await clearFixtures();
  await db.$disconnect();
  if (previousRecoveryEnabled === undefined)
    delete process.env.RUNTIME_SESSION_RECOVERY_ENABLED;
  else process.env.RUNTIME_SESSION_RECOVERY_ENABLED = previousRecoveryEnabled;
});

async function physicalSlot() {
  return db.browserRuntimeSlot.create({
    data: {
      runtimeId: runtime.id,
      sessionId: session.id,
      slotNumber: 0,
      leaseToken: session.leaseToken,
      fencingToken: session.fencingToken,
      expiresAt: session.leaseExpiresAt,
    },
  });
}

async function attestedDrain() {
  const preview = await drains.preview(current, runtime.id);
  const frozen = await drains.freeze(current, runtime.id, {
    snapshotDigest: preview.snapshotDigest,
    note: "Disposable fixture: stop the old process scope",
  });
  // This simulates the verified infrastructure stop, not a browser RPC or proof.
  await db.browserRuntime.update({
    where: { id: runtime.id },
    data: { status: "OFFLINE" },
  });
  const attestationInput = {
    snapshotDigest: frozen.snapshotDigest,
    idempotencyKey: randomUUID(),
    note: "Disposable fixture confirms the entire old process scope is stopped",
    evidenceRefs: ["fixture://stopped-original-runtime-cgroup"],
    infrastructureTerminated: true as const,
  };
  const attested = await drains.attest(
    current,
    runtime.id,
    frozen.id,
    attestationInput,
  );
  expect(attested.state).toBe("ATTESTED");
  expect(await db.browserRuntimeSlot.count()).toBe(0);
  expect(await db.browserRuntimeProfileLease.count()).toBe(0);
  expect(await db.executionResourceLease.count()).toBe(1);
  return { ...attested, attestationInput };
}

function resumeInput(snapshotDigest: string) {
  return {
    snapshotDigest,
    note: "Resume the original installation with its retained Profile storage",
    evidenceRefs: ["fixture://retained-original-profile-directory"],
    profileStoragePreserved: true as const,
  };
}

function pairInput(pairingToken: string, instanceKey = runtime.instanceKey) {
  return {
    pairingToken,
    instanceKey,
    name: "Repaired Runtime",
    deviceInfo: "Disposable Linux fixture",
    version: "0.2.18",
    capabilities: ["playwright", "persistent-profile"],
    maxConcurrency: 1,
  };
}

async function issueToken(drain: { id: string; snapshotDigest: string }) {
  return drains.resumeToken(
    current,
    runtime.id,
    drain.id,
    resumeInput(drain.snapshotDigest),
  );
}

async function durableState() {
  return {
    runtime: await db.browserRuntime.findUniqueOrThrow({
      where: { id: runtime.id },
    }),
    profile: await db.userBrowserProfile.findUniqueOrThrow({
      where: { id: profile.id },
    }),
    session: await db.browserRuntimeSession.findUniqueOrThrow({
      where: { id: session.id },
    }),
    guards: await db.executionResourceLease.findMany({
      orderBy: { id: "asc" },
    }),
    slots: await db.browserRuntimeSlot.findMany({ orderBy: { id: "asc" } }),
    profileLeases: await db.browserRuntimeProfileLease.findMany({
      orderBy: { id: "asc" },
    }),
    fence: await db.browserRuntimeFenceCounter.findUniqueOrThrow({
      where: { runtimeId: runtime.id },
    }),
  };
}

describe("attested Runtime resume with disposable PostgreSQL", () => {
  it("completes the real recovery handshake and fences old evidence and tickets from a second drain", async () => {
    const first = await attestedDrain();
    const ticket = await issueToken(first);
    const paired = await runtimes.pair(pairInput(ticket.pairingToken));
    const beforeHello = await durableState();
    const gatewayRedis = {
      ...redis,
      instanceId: "disposable-resume-gateway",
      markRuntimeOnline: vi.fn(async () => undefined),
    };
    const gatewayHub = { register: vi.fn(), close: vi.fn() };
    const gateway = new RuntimeGatewayService(
      db as never,
      gatewayRedis as never,
      gatewayHub as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      recoveries,
    );
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const handleHello = Reflect.get(gateway, "handleHello") as (
      connection: typeof socket,
      message: ReturnType<typeof runtimeClientMessageSchema.parse>,
    ) => Promise<AuthenticatedRuntimeContext | undefined>;
    const daemonInstanceId = randomUUID();
    const hello = runtimeClientMessageSchema.parse({
      type: "runtime.hello",
      runtimeId: runtime.id,
      runtimeToken: paired.runtimeToken,
      protocol: RUNTIME_PROTOCOL,
      instanceNonce: randomUUID(),
      activeSessions: [],
      hostInstanceId: runtime.hostInstanceId,
      daemonInstanceId,
      capabilities: ["session-permits-v1", "closure-evidence-v1"],
      sentAt: new Date().toISOString(),
      version: "0.2.18",
    });

    const context = await handleHello.call(gateway, socket, hello);
    expect(context).toMatchObject({
      runtimeId: runtime.id,
      connectionGeneration: beforeHello.runtime.connectionGeneration + 1n,
      hostInstanceId: runtime.hostInstanceId,
      daemonInstanceId,
    });
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({
      type: "runtime.hello.accepted",
      reconcile: [],
    });
    const resumed = await durableState();
    expect(resumed.runtime).toMatchObject({
      enabled: true,
      status: "ONLINE",
      drainState: "NONE",
      daemonInstanceId,
      connectionGeneration: beforeHello.runtime.connectionGeneration + 1n,
    });
    expect(resumed.guards).toEqual(beforeHello.guards);
    expect(resumed.profile).toEqual(beforeHello.profile);
    expect(
      (
        await db.runtimeDrainAttestation.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).resumedAt,
    ).not.toBeNull();
    expect(gatewayHub.register).toHaveBeenCalledWith(
      runtime.id,
      socket,
      resumed.runtime.connectionGeneration,
    );
    expect(gatewayRedis.markRuntimeOnline).toHaveBeenCalledWith(
      runtime.id,
      resumed.runtime.connectionGeneration,
    );

    const preview = await drains.preview(current, runtime.id);
    const second = await drains.freeze(current, runtime.id, {
      snapshotDigest: preview.snapshotDigest,
      note: "Freeze a second generation after a real recovery handshake",
    });
    expect(second.id).not.toBe(first.id);
    const frozen = await durableState();
    expect(frozen.runtime).toMatchObject({
      enabled: false,
      drainState: "FROZEN",
      drainGeneration: beforeHello.runtime.drainGeneration + 1,
    });
    const secondDrain = await db.runtimeDrainAttestation.findUniqueOrThrow({
      where: { id: second.id },
    });
    const proofCount = await db.sessionClosureEvidence.count();
    await expect(
      drains.attest(current, runtime.id, first.id, first.attestationInput),
    ).resolves.toMatchObject({ id: first.id, state: "ATTESTED" });
    await expect(
      runtimes.pair(pairInput(ticket.pairingToken)),
    ).rejects.toThrow();
    await expect(issueToken(first)).rejects.toThrow();
    expect(await durableState()).toEqual(frozen);
    expect(
      await db.runtimeDrainAttestation.findUniqueOrThrow({
        where: { id: second.id },
      }),
    ).toEqual(secondDrain);
    expect(await db.sessionClosureEvidence.count()).toBe(proofCount);
  });

  it("includes legacy CLOSED sessions without proof in the drain before allowing recovery", async () => {
    await db.browserRuntimeSession.update({
      where: { id: session.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    const preview = await drains.preview(current, runtime.id);
    expect(preview.sessions).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        status: "CLOSED",
        closureVerifiedAt: null,
      }),
    ]);
    const drain = await attestedDrain();
    const verified = await db.browserRuntimeSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(verified.closureEvidenceId).not.toBeNull();
    expect(verified.closureVerifiedAt).not.toBeNull();
    const ticket = await issueToken(drain);
    await expect(
      runtimes.pair(pairInput(ticket.pairingToken)),
    ).resolves.toMatchObject({
      runtimeId: runtime.id,
    });
  });

  it("retains the original identity, Profile bindings, and UNKNOWN write guard while awaiting a new handshake", async () => {
    const drain = await attestedDrain();
    const before = await durableState();
    const bindings = await db.taskProfileBinding.findMany({
      where: { taskExecutionId: taskId },
    });
    const grants = await db.browserProfileGrant.findMany({
      where: { profileId: profile.id },
    });
    const routes = await db.runtimeRoutingRule.findMany({
      where: { runtimeId: runtime.id },
    });
    const ticket = await issueToken(drain);
    expect(ticket).toMatchObject({
      runtimeId: runtime.id,
      drainId: drain.id,
      instanceKey: runtime.instanceKey,
    });
    const issued = await durableState();
    expect(issued.runtime.connectionGeneration).toBe(
      before.runtime.connectionGeneration + 1n,
    );
    expect(issued.runtime.tokenHash).not.toBe(before.runtime.tokenHash);
    expect(issued.runtime.enabled).toBe(false);

    const paired = await runtimes.pair(pairInput(ticket.pairingToken));
    expect(paired.runtimeId).toBe(runtime.id);
    expect(await db.browserRuntime.count()).toBe(1);
    const after = await durableState();
    expect(after.runtime).toMatchObject({
      id: runtime.id,
      teamId: current.team.id,
      instanceKey: runtime.instanceKey,
      enabled: false,
      drainState: "RESUMING",
      maxConcurrency: 4,
      networkAllowlist: runtime.networkAllowlist,
      connectionGeneration: issued.runtime.connectionGeneration + 1n,
      tokenHash: digest(paired.runtimeToken),
    });
    expect(after.runtime.tokenHash).not.toBe(before.runtime.tokenHash);
    expect(after.profile).toMatchObject({
      id: profile.id,
      assignedRuntimeId: runtime.id,
      ownerUserId: profile.ownerUserId,
      runtimeProfileKey: profile.runtimeProfileKey,
      status: "REAUTH_REQUIRED",
      authSnapshotGeneration: null,
      authSnapshotCreatedAt: null,
    });
    expect(after.guards).toEqual(before.guards);
    expect(after.fence).toEqual(before.fence);
    expect(after.session).toEqual(before.session);
    expect(after.guards[0]).toMatchObject({ mode: "WRITE", quarantined: true });
    expect(
      await db.runtimeSessionRecovery.findFirstOrThrow({
        where: { sessionId: session.id },
      }),
    ).toMatchObject({
      closureState: "VERIFIED",
      writeOutcomeState: "UNKNOWN",
      resolvedAt: null,
    });
    expect(
      await db.taskProfileBinding.findMany({
        where: { taskExecutionId: taskId },
      }),
    ).toEqual(bindings);
    expect(
      await db.browserProfileGrant.findMany({
        where: { profileId: profile.id },
      }),
    ).toEqual(grants);
    expect(
      await db.runtimeRoutingRule.findMany({
        where: { runtimeId: runtime.id },
      }),
    ).toEqual(routes);
  });

  it("allows exactly one of two concurrent consumers of the same recovery ticket", async () => {
    const drain = await attestedDrain();
    const ticket = await issueToken(drain);
    const before = await durableState();
    const results = await Promise.allSettled([
      runtimes.pair(pairInput(ticket.pairingToken)),
      runtimes.pair(pairInput(ticket.pairingToken)),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const after = await durableState();
    expect(after.runtime.connectionGeneration).toBe(
      before.runtime.connectionGeneration + 1n,
    );
    expect(after.runtime.drainState).toBe("RESUMING");
    expect(after.guards).toEqual(before.guards);
    expect(await db.browserRuntime.count()).toBe(1);
    expect(
      (
        await db.browserRuntimePairingToken.findUniqueOrThrow({
          where: { tokenHash: digest(ticket.pairingToken) },
        })
      ).usedAt,
    ).not.toBeNull();
  });

  it("invalidates a previous unconsumed recovery ticket when an administrator reissues it", async () => {
    const drain = await attestedDrain();
    const older = await issueToken(drain);
    const latest = await issueToken(drain);
    const before = await durableState();
    await expect(
      runtimes.pair(pairInput(older.pairingToken)),
    ).rejects.toThrow();
    expect(await durableState()).toEqual(before);
    expect(
      (await runtimes.pair(pairInput(latest.pairingToken))).runtimeId,
    ).toBe(runtime.id);
  });

  it("rejects a recovery ticket for a different instance without consuming it or creating a Runtime", async () => {
    const drain = await attestedDrain();
    const ticket = await issueToken(drain);
    const before = await durableState();
    await expect(
      runtimes.pair(pairInput(ticket.pairingToken, "different-installation")),
    ).rejects.toThrow();
    expect(await durableState()).toEqual(before);
    expect(await db.browserRuntime.count()).toBe(1);
    expect(
      (
        await db.browserRuntimePairingToken.findUniqueOrThrow({
          where: { tokenHash: digest(ticket.pairingToken) },
        })
      ).usedAt,
    ).toBeNull();
    await expect(
      runtimes.pair(pairInput(ticket.pairingToken)),
    ).resolves.toMatchObject({ runtimeId: runtime.id });
  });

  it("recovers a lost pair response by reissuing a ticket and revoking the abandoned credential", async () => {
    const drain = await attestedDrain();
    const originalTicket = await issueToken(drain);
    const abandoned = await runtimes.pair(
      pairInput(originalTicket.pairingToken),
    );
    const before = await durableState();
    const replacement = await issueToken(drain);
    const issued = await durableState();
    expect(issued.runtime.enabled).toBe(false);
    expect(issued.runtime.tokenHash).not.toBe(digest(abandoned.runtimeToken));
    expect(issued.runtime.connectionGeneration).toBe(
      before.runtime.connectionGeneration + 1n,
    );
    expect(issued.guards).toEqual(before.guards);
    await expect(
      runtimes.pair(pairInput(originalTicket.pairingToken)),
    ).rejects.toThrow();
    const paired = await runtimes.pair(pairInput(replacement.pairingToken));
    expect(paired.runtimeId).toBe(runtime.id);
    expect(paired.runtimeToken).not.toBe(abandoned.runtimeToken);
    expect((await durableState()).runtime.drainState).toBe("RESUMING");
    expect(await db.browserRuntime.count()).toBe(1);
  });

  it("rejects a different team's administrator even with the exact runtime and drain identifiers", async () => {
    const drain = await attestedDrain();
    const foreignTeam = await db.team.create({
      data: {
        slug: randomUUID(),
        name: "Other team",
        feishuTenantKey: randomUUID(),
      },
    });
    await db.teamMembership.create({
      data: { teamId: foreignTeam.id, userId: current.user.id, role: "ADMIN" },
    });
    const before = await durableState();
    await expect(
      drains.resumeToken(
        { ...current, team: foreignTeam },
        runtime.id,
        drain.id,
        resumeInput(drain.snapshotDigest),
      ),
    ).rejects.toThrow();
    expect(await durableState()).toEqual(before);
    expect(await db.browserRuntimePairingToken.count()).toBe(0);
  });

  it.each(["issuance", "consumption"] as const)(
    "requires current ADMIN membership at ticket %s",
    async (stage) => {
      const drain = await attestedDrain();
      const ticket = stage === "consumption" ? await issueToken(drain) : null;
      await db.teamMembership.update({
        where: {
          teamId_userId: { teamId: current.team.id, userId: current.user.id },
        },
        data: { role: "MEMBER" },
      });
      const before = await durableState();
      await expect(
        ticket
          ? runtimes.pair(pairInput(ticket.pairingToken))
          : issueToken(drain),
      ).rejects.toThrow();
      expect(await durableState()).toEqual(before);
      if (ticket)
        expect(
          (
            await db.browserRuntimePairingToken.findUniqueOrThrow({
              where: { tokenHash: digest(ticket.pairingToken) },
            })
          ).usedAt,
        ).toBeNull();
    },
  );

  it.each(["issuance", "consumption"] as const)(
    "rejects an older drain generation at ticket %s",
    async (stage) => {
      const drain = await attestedDrain();
      const ticket = stage === "consumption" ? await issueToken(drain) : null;
      await db.browserRuntime.update({
        where: { id: runtime.id },
        data: { drainGeneration: { increment: 1 } },
      });
      const before = await durableState();
      await expect(
        ticket
          ? runtimes.pair(pairInput(ticket.pairingToken))
          : issueToken(drain),
      ).rejects.toThrow();
      expect(await durableState()).toEqual(before);
    },
  );

  it.each(["issuance", "consumption"] as const)(
    "refuses an uncleared physical slot at ticket %s",
    async (stage) => {
      const drain = await attestedDrain();
      const ticket = stage === "consumption" ? await issueToken(drain) : null;
      // A stale allocator or incomplete cleanup recreates a slot after attestation.
      await physicalSlot();
      const before = await durableState();
      await expect(
        ticket
          ? runtimes.pair(pairInput(ticket.pairingToken))
          : issueToken(drain),
      ).rejects.toThrow();
      expect(await durableState()).toEqual(before);
    },
  );

  it.each(["missing proof", "changed epoch"] as const)(
    "rechecks historical closure evidence at consumption after %s",
    async (change) => {
      const drain = await attestedDrain();
      const ticket = await issueToken(drain);
      await db.browserRuntimeSession.update({
        where: { id: session.id },
        data:
          change === "missing proof"
            ? { closureEvidenceId: null }
            : { fencingToken: { increment: 1n } },
      });
      const before = await durableState();
      await expect(
        runtimes.pair(pairInput(ticket.pairingToken)),
      ).rejects.toThrow();
      expect(await durableState()).toEqual(before);
      expect(
        (
          await db.browserRuntimePairingToken.findUniqueOrThrow({
            where: { tokenHash: digest(ticket.pairingToken) },
          })
        ).usedAt,
      ).toBeNull();
    },
  );

  it("does not let a normal team pairing token re-enable an attested Runtime", async () => {
    await attestedDrain();
    const ticket = await runtimes.createPairingToken(current);
    const before = await durableState();
    await expect(
      runtimes.pair(pairInput(ticket.pairingToken)),
    ).rejects.toThrow();
    expect(await durableState()).toEqual(before);
  });
});
