import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import type { VerificationRequest } from "@devproof/contracts";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: () => ({
    RUNTIME_LEASE_SECONDS: 90,
    RUNTIME_SESSION_RECOVERY_ENABLED: true,
  }),
}));

import type { AuthContext } from "../auth/auth.types.js";
import { RuntimeSessionsService } from "../runtime/runtime-sessions.service.js";
import { SessionClosureService } from "../runtime/session-closure.service.js";
import { SessionRecoveryService } from "../runtime/session-recovery.service.js";
import { BrowserExecutionRunner } from "../verification/browser-execution-runner.service.js";
import { UserBrowserProfilesService } from "./user-browser-profiles.service.js";

// Never import dotenv or connect to an application database from this suite.
const connectionString = process.env.DEVPROOF_CONCURRENCY_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("Use apps/api/scripts/test-execution-concurrency.mjs.");
const destination = new URL(connectionString);
if (
  destination.hostname !== "127.0.0.1" ||
  destination.username !== "devproof_test" ||
  !/^\/devproof_concurrency_test_[a-f\d]{8}$/u.test(destination.pathname)
)
  throw new Error("Refusing a non-disposable profile preparation database.");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString, max: 20 }),
});
const redis = { isRuntimeOnline: vi.fn(async () => true) };
const commands = {
  execute: vi.fn(
    async (_input: { commandType: string; sessionId: string }) => ({
      id: randomUUID(),
      status: "SUCCEEDED",
      fencingToken: 1n,
      payload: {},
      result: {},
      artifacts: [],
      error: null,
    }),
  ),
};
const audit = { record: vi.fn(async () => undefined) };
const targetUrl = "https://profile-preparation.example.test/settings";
let current: AuthContext;
let runtimeId: string;
let profile: Awaited<ReturnType<typeof db.userBrowserProfile.create>>;

async function clearFixtures() {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "runtime_recovery_permits", "runtime_recovery_outbox", "session_closure_evidence", "runtime_session_recoveries", "runtime_drain_attestations", "teams", "users" RESTART IDENTITY CASCADE',
  );
}

afterAll(async () => {
  await clearFixtures();
  await db.$disconnect();
});

beforeEach(async () => {
  await clearFixtures();
  redis.isRuntimeOnline.mockReset().mockResolvedValue(true);
  commands.execute.mockClear();
  audit.record.mockClear();
  const team = await db.team.create({
    data: {
      slug: randomUUID(),
      name: "Preparation test",
      feishuTenantKey: randomUUID(),
    },
  });
  const user = await db.user.create({
    data: {
      name: "Profile owner",
      memberships: { create: { teamId: team.id } },
    },
  });
  current = { sessionId: randomUUID(), team, user };
  const runtime = await db.browserRuntime.create({
    data: {
      teamId: team.id,
      instanceKey: randomUUID(),
      name: "Preparation fixture",
      tokenHash: randomUUID(),
      tokenHint: "test",
      status: "ONLINE",
      protocolMajor: 1,
      protocolMinor: 14,
      connectionId: randomUUID(),
      connectionGeneration: 1n,
      hostInstanceId: "preparation-test-host",
      daemonInstanceId: "preparation-test-daemon",
      maxConcurrency: 4,
      capabilities: [
        "browser",
        "auth-snapshot-v1",
        "session-permits-v1",
        "closure-evidence-v1",
      ],
    },
  });
  runtimeId = runtime.id;
  profile = await db.userBrowserProfile.create({
    data: {
      teamId: team.id,
      ownerUserId: user.id,
      assignedRuntimeId: runtimeId,
      runtimeProfileKey: `profile-${randomUUID()}`,
      displayName: "Verified identity",
      scopeKey: randomUUID(),
      status: "READY",
      executionMode: "ISOLATED_AUTH",
      executionConcurrency: 4,
      authSnapshotGeneration: 1,
      authSnapshotCreatedAt: new Date(),
      verificationUrl: targetUrl,
      verificationRules: { successUrlPatterns: [`${targetUrl}*`] },
      lastVerifiedAt: new Date(),
      inactivityExpiresAt: new Date(Date.now() + 86_400_000),
      grants: {
        create: {
          teamId: team.id,
          triggerSource: "CONSOLE",
          hostnamePattern: new URL(targetUrl).hostname,
          consentedByUserId: user.id,
        },
      },
    },
  });
});

function services(client = db) {
  const recovery = new SessionRecoveryService(client as never);
  const closure = new SessionClosureService(client as never);
  const sessions = new RuntimeSessionsService(
    client as never,
    redis as never,
    commands as never,
    {} as never,
    audit as never,
    recovery,
    closure,
  );
  const runner = new BrowserExecutionRunner(
    client as never,
    redis as never,
    commands as never,
    {} as never,
    recovery,
    closure,
  );
  return {
    runner,
    sessions,
    profiles: new UserBrowserProfilesService(
      client as never,
      redis as never,
      sessions,
      {} as never,
      runner,
      audit as never,
    ),
  };
}

async function storedProfile() {
  return db.userBrowserProfile.findUniqueOrThrow({ where: { id: profile.id } });
}

async function inventory() {
  return {
    sessions: await db.browserRuntimeSession.count(),
    slots: await db.browserRuntimeSlot.count(),
    persistentLeases: await db.browserRuntimeProfileLease.count(),
    dataLeases: await db.executionResourceLease.count(),
  };
}

async function oldSession(status: "LOST" | "CLOSED", userProfile = true) {
  return db.browserRuntimeSession.create({
    data: {
      teamId: current.team.id,
      runtimeId,
      status,
      profileMode: userProfile ? "PERSISTENT" : "EPHEMERAL",
      profileKey: userProfile ? profile.runtimeProfileKey : randomUUID(),
      ...(userProfile ? { userBrowserProfileId: profile.id } : {}),
      purpose: "EXECUTION",
      slotNumber: 0,
      leaseToken: randomUUID(),
      fencingToken: 1n,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      protocolMajor: 1,
      protocolMinor: 10,
    },
  });
}

async function readExecution() {
  const deadlineAt = new Date(Date.now() + 600_000);
  const task = await db.taskExecution.create({
    data: {
      teamId: current.team.id,
      requestedByUserId: current.user.id,
      kind: "ISSUE_SPEC",
      sourceKind: "TEST",
      idempotencyKey: randomUUID(),
      title: "Competing read",
      lifecycle: "RUNNING",
      inputSnapshot: {},
      traceId: randomUUID().replaceAll("-", ""),
      deadlineAt,
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
  const run = await db.executionRun.create({
    data: {
      teamId: current.team.id,
      taskExecutionId: task.id,
      browserProfileId: profile.id,
      idempotencyKey: randomUUID(),
      goal: "Compete with identity maintenance",
      criteriaSnapshot: [],
      environmentSnapshot: { targetUrl },
      concurrencyPolicy: { accessMode: "READ_ONLY" },
      traceId: randomUUID().replaceAll("-", ""),
      deadlineAt,
      initialDeadlineAt: deadlineAt,
      hardDeadlineAt: deadlineAt,
      attempts: { create: { number: 1, inputSnapshot: {} } },
    },
    include: { attempts: true },
  });
  const execution = await db.browserExecution.create({
    data: {
      runId: run.id,
      attemptId: run.attempts[0]!.id,
      status: "ALLOCATING",
      allocationToken: randomUUID(),
      input: {
        targetUrl,
        profile: { mode: "PERSISTENT", key: profile.runtimeProfileKey },
      },
    },
  });
  const request = {
    inputs: {},
    execution: {
      profile: { mode: "PERSISTENT", key: profile.runtimeProfileKey },
      targetUrl,
      availabilityPolicy: "WAIT",
      requiredCapabilities: ["browser"],
    },
  } as VerificationRequest;
  return (runner: BrowserExecutionRunner) =>
    runner.acquireForExecutionRun(current.team.id, execution.id, request);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The barriers only control timing around the real PostgreSQL advisory lock.
// No query, transaction, lease allocation or conflict result is mocked.
function coordinateAllocations() {
  const firstLocked = deferred();
  const secondArrived = deferred();
  const releaseFirst = deferred();
  let allocations = 0;
  const client = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "$transaction")
        return Reflect.get(target, property, receiver);
      return (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: {
          isolationLevel?: Prisma.TransactionIsolationLevel;
          maxWait?: number;
          timeout?: number;
        },
      ) =>
        target.$transaction(async (tx) => {
          const decorated = new Proxy(tx, {
            get(transaction, name, txReceiver) {
              if (name !== "$queryRaw")
                return Reflect.get(transaction, name, txReceiver);
              return async (query: Prisma.Sql) => {
                const isCoordinator = query.values.includes(
                  "browser-execution-resources",
                );
                const ordinal = isCoordinator ? ++allocations : 0;
                if (ordinal === 2) secondArrived.resolve();
                const result = await transaction.$queryRaw(query);
                if (ordinal === 1) {
                  firstLocked.resolve();
                  await releaseFirst.promise;
                }
                return result;
              };
            },
          });
          return callback(decorated);
        }, options);
    },
  });
  return { client, firstLocked, secondArrived, releaseFirst };
}

describe("PostgreSQL profile preparation admission", () => {
  it("keeps the public session create API compatible without an internal preparation claim", async () => {
    const opened = await services().sessions.create(current, {
      runtimeId,
      userBrowserProfileId: profile.id,
      profileMode: "PERSISTENT",
      purpose: "PROFILE_PREPARATION",
    });
    expect(opened.status).toBe("ACTIVE");
    expect(await storedProfile()).toMatchObject({
      status: "READY",
      version: profile.version,
      lastVerifiedAt: profile.lastVerifiedAt,
      authSnapshotGeneration: profile.authSnapshotGeneration,
    });
    expect(await inventory()).toEqual({
      sessions: 1,
      slots: 1,
      persistentLeases: 1,
      dataLeases: 0,
    });
    expect(commands.execute).toHaveBeenCalledTimes(1);
  });

  it("preserves READY and authentication metadata when a LOST session blocks preparation", async () => {
    await oldSession("LOST");
    const before = await storedProfile();
    await expect(
      services().profiles.reauth(current, profile.id, { ttlSeconds: 60 }),
    ).rejects.toThrow(/identity is in use/u);
    expect(await storedProfile()).toEqual(before);
    expect(await inventory()).toEqual({
      sessions: 1,
      slots: 0,
      persistentLeases: 0,
      dataLeases: 0,
    });
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it("preserves READY when the selected Runtime has no capacity", async () => {
    await db.browserRuntime.update({
      where: { id: runtimeId },
      data: { maxConcurrency: 1 },
    });
    const session = await oldSession("LOST", false);
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
    const before = await storedProfile();
    await expect(
      services().profiles.reauth(current, profile.id, { ttlSeconds: 60 }),
    ).rejects.toThrow(/no available slot/u);
    expect(await storedProfile()).toEqual(before);
    expect(await inventory()).toEqual({
      sessions: 1,
      slots: 1,
      persistentLeases: 0,
      dataLeases: 0,
    });
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it("rolls the Profile claim and new allocations back on a persistent lease constraint failure", async () => {
    const session = await oldSession("CLOSED");
    await db.browserRuntimeProfileLease.create({
      data: {
        teamId: current.team.id,
        runtimeId,
        sessionId: session.id,
        profileKey: profile.runtimeProfileKey,
        leaseToken: session.leaseToken,
        fencingToken: session.fencingToken,
        expiresAt: session.leaseExpiresAt,
      },
    });
    const before = await storedProfile();
    await expect(
      services().profiles.reauth(current, profile.id, { ttlSeconds: 60 }),
    ).rejects.toThrow(/already used/u);
    expect(await storedProfile()).toEqual(before);
    expect(await inventory()).toEqual({
      sessions: 1,
      slots: 0,
      persistentLeases: 1,
      dataLeases: 0,
    });
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it.each(["maintenance", "execution"] as const)(
    "admits only the %s winner when preparation and execution contend",
    async (winner) => {
      const acquire = await readExecution();
      const gate = coordinateAllocations();
      const service = services(gate.client);
      const prepare = () =>
        service.profiles.reauth(current, profile.id, { ttlSeconds: 60 });
      const execute = () => acquire(service.runner);
      const start = winner === "maintenance" ? prepare : execute;
      const follow = winner === "maintenance" ? execute : prepare;
      const first = start();
      const firstResult = Promise.allSettled([first]);
      let secondResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let gateError: unknown;
      try {
        await Promise.race([
          gate.firstLocked.promise,
          firstResult.then(() => {
            throw new Error(
              "The first request did not reach the allocation lock.",
            );
          }),
        ]);
        secondResult = Promise.allSettled([follow()]);
        await Promise.race([
          gate.secondArrived.promise,
          secondResult.then(() => {
            throw new Error(
              "The competing request did not reach the allocation lock.",
            );
          }),
        ]);
      } catch (error) {
        gateError = error;
      } finally {
        gate.releaseFirst.resolve();
      }
      const [firstOutcome, secondOutcome] = await Promise.all([
        firstResult,
        secondResult,
      ]);
      if (gateError) throw gateError;
      if (firstOutcome[0]?.status === "rejected") throw firstOutcome[0].reason;
      expect(firstOutcome[0]?.status).toBe("fulfilled");
      expect(secondOutcome?.[0]?.status).toBe("rejected");
      const saved = await storedProfile();
      expect(saved.status).toBe(
        winner === "maintenance" ? "PREPARING" : "READY",
      );
      expect(saved.lastVerifiedAt).toEqual(profile.lastVerifiedAt);
      expect(saved.authSnapshotGeneration).toBe(profile.authSnapshotGeneration);
      expect(await inventory()).toEqual({
        sessions: 1,
        slots: 1,
        persistentLeases: winner === "maintenance" ? 1 : 0,
        dataLeases: winner === "maintenance" ? 0 : 1,
      });
      expect(
        commands.execute.mock.calls.filter(
          ([call]) => call.commandType === "session.open",
        ),
      ).toHaveLength(1);
    },
  );
});
