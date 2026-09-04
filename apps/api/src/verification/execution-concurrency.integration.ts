import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import type { VerificationRequest } from "@devproof/contracts";
import {
  runtimeTaskSnapshotSchema,
  type RuntimeTaskClaimInput,
} from "@devproof/agent-runtime-protocol";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// This suite must never read application dotenv files or create a production client.
vi.mock("../config/env.js", () => ({
  env: () => ({
    RUNTIME_LEASE_SECONDS: 90,
    AGENT_RUNTIME_TASK_LEASE_SECONDS: 90,
  }),
}));

import { BrowserExecutionRunner } from "./browser-execution-runner.service.js";
import { BrowserAdmissionService } from "./browser-admission.service.js";
import { AgentRuntimeTaskService } from "../agent-runtime/agent-runtime-task.service.js";
import {
  quarantineSession,
  releaseVerifiedSessionResources,
} from "../runtime/session-resource-cleanup.js";

const connectionString = process.env.DEVPROOF_CONCURRENCY_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "Use node apps/api/scripts/test-execution-concurrency.mjs to create a disposable test database.",
  );
const destination = new URL(connectionString);
if (
  destination.hostname !== "127.0.0.1" ||
  destination.username !== "devproof_test" ||
  !/^\/devproof_concurrency_test_[a-f\d]{8}$/u.test(destination.pathname)
) {
  throw new Error(
    "Refusing to run concurrency tests against a non-disposable database.",
  );
}
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString, max: 20 }),
});
const commands = {
  execute: vi
    .fn()
    .mockResolvedValue({ status: "SUCCEEDED", artifacts: [], error: null }),
};
const runner = new BrowserExecutionRunner(
  db as never,
  { isRuntimeOnline: async () => true } as never,
  commands as never,
  {} as never,
);
const targetUrl = "https://test-duo.paigod.work/product-ops";
let teamId: string;
let runtimeId: string;
let profiles: Array<{
  id: string;
  runtimeProfileKey: string;
  ownerUserId: string;
}>;
let sequence = 0;

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "teams", "users" RESTART IDENTITY CASCADE',
  );
  sequence = 0;
  commands.execute
    .mockReset()
    .mockResolvedValue({ status: "SUCCEEDED", artifacts: [], error: null });
  const team = await db.team.create({
    data: {
      slug: randomUUID(),
      name: "Concurrency test",
      feishuTenantKey: randomUUID(),
    },
  });
  teamId = team.id;
  const runtime = await db.browserRuntime.create({
    data: {
      teamId,
      instanceKey: randomUUID(),
      name: "Isolated fixture",
      tokenHash: randomUUID(),
      tokenHint: "test",
      status: "ONLINE",
      protocolMajor: 1,
      protocolMinor: 13,
      maxConcurrency: 4,
      capabilities: ["browser", "auth-snapshot-v1", "session-permits-v1"],
    },
  });
  runtimeId = runtime.id;
  profiles = [];
  for (let index = 0; index < 2; index++) {
    const user = await db.user.create({
      data: { name: `Owner ${index}`, memberships: { create: { teamId } } },
    });
    profiles.push(
      await db.userBrowserProfile.create({
        data: {
          teamId,
          ownerUserId: user.id,
          assignedRuntimeId: runtimeId,
          runtimeProfileKey: `profile-${randomUUID()}`,
          displayName: "Prepared test identity",
          scopeKey: `test-${index}`,
          status: "READY",
          executionMode: "ISOLATED_AUTH",
          executionConcurrency: 4,
          authSnapshotGeneration: 1,
          authSnapshotCreatedAt: new Date(),
          inactivityExpiresAt: new Date(Date.now() + 86_400_000),
          grants: {
            create: {
              teamId,
              triggerSource: "CONSOLE",
              hostnamePattern: "test-duo.paigod.work",
              consentedByUserId: user.id,
            },
          },
        },
      }),
    );
  }
});

async function execution(
  accessMode: "READ_ONLY" | "MUTATING" | "UNKNOWN",
  profileIndex = 0,
  resourceScopes?: string[],
) {
  const profile = profiles[profileIndex]!;
  const deadlineAt = new Date(Date.now() + 600_000);
  const task = await db.taskExecution.create({
    data: {
      teamId,
      requestedByUserId: profile.ownerUserId,
      kind: "ISSUE_SPEC",
      sourceKind: "TEST",
      idempotencyKey: randomUUID(),
      title: "Concurrency fixture",
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
  const policy = { accessMode, ...(resourceScopes ? { resourceScopes } : {}) };
  const run = await db.executionRun.create({
    data: {
      teamId,
      taskExecutionId: task.id,
      browserProfileId: profile.id,
      idempotencyKey: randomUUID(),
      goal: "Exercise real browser admission",
      criteriaSnapshot: [],
      environmentSnapshot: { targetUrl },
      concurrencyPolicy: policy,
      traceId: randomUUID().replaceAll("-", ""),
      deadlineAt,
      initialDeadlineAt: deadlineAt,
      hardDeadlineAt: deadlineAt,
      attempts: { create: { number: 1, inputSnapshot: {} } },
    },
    include: { attempts: true },
  });
  const row = await db.browserExecution.create({
    data: {
      runId: run.id,
      attemptId: run.attempts[0]!.id,
      input: {
        targetUrl,
        profile: { mode: "PERSISTENT", key: profile.runtimeProfileKey },
      },
      status: "ALLOCATING",
      allocationToken: randomUUID(),
      createdAt: new Date(Date.now() - 60_000 + sequence++ * 10),
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
  return {
    row,
    run,
    request,
    acquire: () => runner.acquireForExecutionRun(teamId, row.id, request),
  };
}

async function assertAtomicInventory(expected: number) {
  const [sessions, slots, resources, bound] = await Promise.all([
    db.browserRuntimeSession.findMany(),
    db.browserRuntimeSlot.findMany(),
    db.executionResourceLease.findMany(),
    db.browserExecution.findMany({
      where: { runtimeSessionId: { not: null } },
    }),
  ]);
  expect(sessions).toHaveLength(expected);
  expect(slots).toHaveLength(expected);
  expect(resources).toHaveLength(expected);
  expect(bound).toHaveLength(expected);
  expect(new Set(slots.map((slot) => slot.slotNumber)).size).toBe(expected);
  for (const session of sessions) {
    expect(session.profileMode).toBe("EPHEMERAL");
    expect(session.authSnapshotGeneration).toBe(1);
    expect(session.identityPermit).not.toBeNull();
    expect(
      bound.filter((row) => row.runtimeSessionId === session.id),
    ).toHaveLength(1);
  }
  expect(await db.browserRuntimeProfileLease.count()).toBe(0);
}

async function recordTimedOutCommand(
  sessionId: string,
  commandType: "page.click" | "session.open",
) {
  const session = await db.browserRuntimeSession.findUniqueOrThrow({
    where: { id: sessionId },
  });
  await db.browserRuntimeCommand.create({
    data: {
      sessionId,
      commandType,
      source: commandType === "page.click" ? "CONSOLE" : "SYSTEM",
      status: "TIMED_OUT",
      payload:
        commandType === "page.click"
          ? { point: { x: 100, y: 100 } }
          : {
              profileKey: session.profileKey,
              profileMode: session.profileMode,
            },
      leaseToken: session.leaseToken,
      fencingToken: session.fencingToken,
      deadlineAt: new Date(),
      dispatchedAt: new Date(Date.now() - 1_000),
      completedAt: new Date(),
      error: { code: "COMMAND_TIMED_OUT" },
    },
  });
}

describe("PostgreSQL browser admission transactions", () => {
  it.each(["LOST", "CLOSED"] as const)(
    "rejects a late open ACK after the Session became %s",
    async (status) => {
      const work = await execution("READ_ONLY");
      commands.execute.mockImplementationOnce(
        async ({ sessionId }: { sessionId: string }) => {
          await db.$transaction(async (tx) => {
            await tx.browserRuntimeSession.update({
              where: { id: sessionId },
              data: {
                status,
                ...(status === "CLOSED"
                  ? { closureVerifiedAt: new Date() }
                  : {}),
              },
            });
            if (status === "CLOSED")
              await releaseVerifiedSessionResources(tx, sessionId);
          });
          return { status: "SUCCEEDED", artifacts: [], error: null };
        },
      );
      await expect(work.acquire()).rejects.toMatchObject({
        reason: "LEASE_RECOVERY",
      });
      expect(
        await db.browserExecution.findUniqueOrThrow({
          where: { id: work.row.id },
        }),
      ).toMatchObject({ status: "ALLOCATING", startedAt: null });
      expect(await db.browserRuntimeSession.findFirstOrThrow()).toMatchObject({
        status,
        openedAt: null,
      });
      expect(
        await db.runEvent.count({
          where: { runId: work.run.id, kind: "browser.execution.acquired" },
        }),
      ).toBe(0);
      expect(
        await db.executionRun.findUniqueOrThrow({ where: { id: work.run.id } }),
      ).toMatchObject({ lifecycle: "QUEUED" });
      expect(
        (
          await db.userBrowserProfile.findUniqueOrThrow({
            where: { id: profiles[0]!.id },
          })
        ).lastUsedAt,
      ).toBeNull();
      if (status === "CLOSED")
        expect(await db.browserRuntimeSlot.count()).toBe(0);
    },
  );

  it("rolls back Session activation when the open ACK belongs to a superseded allocation", async () => {
    const work = await execution("READ_ONLY");
    commands.execute.mockImplementationOnce(async () => {
      await db.browserExecution.update({
        where: { id: work.row.id },
        data: { allocationToken: randomUUID() },
      });
      return { status: "SUCCEEDED", artifacts: [], error: null };
    });
    await expect(work.acquire()).rejects.toMatchObject({
      reason: "ADMISSION_STALE",
    });
    expect(await db.browserRuntimeSession.findFirstOrThrow()).toMatchObject({
      status: "OPENING",
      openedAt: null,
    });
    expect(
      await db.browserExecution.findUniqueOrThrow({
        where: { id: work.row.id },
      }),
    ).toMatchObject({ status: "ALLOCATING", startedAt: null });
    expect(
      await db.runEvent.count({
        where: { runId: work.run.id, kind: "browser.execution.acquired" },
      }),
    ).toBe(0);
  });

  it.each(["AUTH_REQUIRED", "NO_MATCHING_RUNNER", "STALE_DATA_LOCK"])(
    "does not reserve writer preference for an earlier UNKNOWN request waiting on %s",
    async (reason) => {
      const waiting = await execution("UNKNOWN");
      await db.browserExecution.update({
        where: { id: waiting.row.id },
        data: {
          status: "WAITING_CAPACITY",
          error: { code: reason === "STALE_DATA_LOCK" ? "DATA_LOCK" : reason },
          ...(reason === "STALE_DATA_LOCK"
            ? { updatedAt: new Date(Date.now() - 11_000) }
            : {}),
        },
      });
      const reader = await execution("READ_ONLY", 1, ["llm-policy"]);
      await reader.acquire();
      await assertAtomicInventory(1);
    },
  );

  it("allows writes to independent declared resources on the same backend", async () => {
    const first = await execution("MUTATING", 0, ["whitelists/legacy"]);
    const second = await execution("MUTATING", 1, ["llm-policy"]);
    const results = await Promise.allSettled([
      first.acquire(),
      second.acquire(),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    await assertAtomicInventory(2);
  });

  it("admits four simultaneous reads across Tasks and holds the fifth without partial allocations", async () => {
    const work = await Promise.all(
      Array.from({ length: 8 }, () => execution("READ_ONLY")),
    );
    const results = await Promise.allSettled(
      work.map((item) => item.acquire()),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(4);
    const rejected = results.filter((result) => result.status === "rejected");
    for (const result of rejected)
      if (result.status === "rejected")
        expect(["NO_AVAILABLE_SLOT", "IDENTITY_CAPACITY"]).toContain(
          result.reason.reason,
        );
    await assertAtomicInventory(4);
    const extra = await execution("READ_ONLY");
    await expect(extra.acquire()).rejects.toMatchObject({
      reason: "IDENTITY_CAPACITY",
    });
    await assertAtomicInventory(4);
  });

  it("prevents conflicting writes across different users, Profiles and Tasks", async () => {
    const first = await execution("MUTATING", 0, ["llm-policy"]);
    const second = await execution("MUTATING", 1, ["llm-policy"]);
    const results = await Promise.allSettled([
      first.acquire(),
      second.acquire(),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { reason: "DATA_LOCK" } });
    await assertAtomicInventory(1);
  });

  it("UNKNOWN blocks known reads and writes at the root", async () => {
    const unknown = await execution("UNKNOWN");
    await unknown.acquire();
    const knownRead = await execution("READ_ONLY", 1, ["whitelists/legacy"]);
    const knownWrite = await execution("MUTATING", 1, ["llm-policy"]);
    await expect(knownRead.acquire()).rejects.toMatchObject({
      reason: "DATA_LOCK",
    });
    await expect(knownWrite.acquire()).rejects.toMatchObject({
      reason: "DATA_LOCK",
    });
    await assertAtomicInventory(1);
  });

  it("never creates two sessions when competing callers acquire the same Attempt", async () => {
    const work = await execution("READ_ONLY");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => work.acquire()),
    );
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(
      new Set(
        fulfilled.map((result) =>
          result.status === "fulfilled" ? result.value.leaseId : "",
        ),
      ).size,
    ).toBe(1);
    await assertAtomicInventory(1);
    expect(commands.execute).toHaveBeenCalledTimes(1);
  });

  it("releases confirmed closed read resources and lets an earlier waiting writer enter", async () => {
    const reader = await execution("READ_ONLY", 0, ["llm-policy"]);
    const lease = await reader.acquire();
    const writer = await execution("MUTATING", 1, ["llm-policy"]);
    await expect(writer.acquire()).rejects.toMatchObject({
      reason: "DATA_LOCK",
    });
    // BrowserAdmission persists a capacity deferral after the runner rejects.
    await db.browserExecution.update({
      where: { id: writer.row.id },
      data: { status: "WAITING_CAPACITY", error: { code: "DATA_LOCK" } },
    });
    const laterRead = await execution("READ_ONLY", 0, ["llm-policy"]);
    await expect(laterRead.acquire()).rejects.toMatchObject({
      reason: "DATA_LOCK",
    });
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.browserRuntimeSession.update({
        where: { id: lease.leaseId },
        data: { status: "CLOSED", closureVerifiedAt: new Date() },
      });
      await releaseVerifiedSessionResources(tx, lease.leaseId);
    });
    expect(await db.browserRuntimeSlot.count()).toBe(0);
    expect(await db.executionResourceLease.count()).toBe(0);
    expect(
      await db.browserRuntimeSession.count({
        where: { identityPermit: { not: null } },
      }),
    ).toBe(0);
    await writer.acquire();
    await expect(laterRead.acquire()).rejects.toMatchObject({
      reason: "DATA_LOCK",
    });
    expect(await db.browserRuntimeSlot.count()).toBe(1);
  });

  it("preserves uncertain write locks after verified browser closure", async () => {
    const writer = await execution("MUTATING", 0, ["llm-policy"]);
    const lease = await writer.acquire();
    await recordTimedOutCommand(lease.leaseId, "page.click");
    await db.$transaction((tx: Prisma.TransactionClient) =>
      quarantineSession(tx, lease.leaseId, "INTEGRATION_LOST"),
    );
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.browserRuntimeSession.update({
        where: { id: lease.leaseId },
        data: { status: "CLOSED", closureVerifiedAt: new Date() },
      });
      await releaseVerifiedSessionResources(tx, lease.leaseId);
    });
    expect(await db.browserRuntimeSlot.count()).toBe(0);
    expect(await db.executionResourceLease.findMany()).toMatchObject([
      { quarantined: true, mode: "WRITE" },
    ]);
    const reader = await execution("READ_ONLY", 1, ["llm-policy"]);
    await expect(reader.acquire()).rejects.toMatchObject({
      reason: "LEASE_RECOVERY",
    });
  });

  it("reclaims reserved write resources after a confirmed open failure without a dispatched write", async () => {
    const writer = await execution("MUTATING", 0, ["llm-policy"]);
    commands.execute.mockImplementationOnce(
      async ({ sessionId }: { sessionId: string }) => {
        await recordTimedOutCommand(sessionId, "session.open");
        return { status: "TIMED_OUT", artifacts: [], error: null };
      },
    );
    await expect(writer.acquire()).rejects.toMatchObject({
      reason: "SESSION_OPEN_FAILED",
    });
    expect(commands.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        commandType: "session.close",
        source: "SYSTEM",
      }),
    );
    expect(await db.browserRuntimeSession.findFirstOrThrow()).toMatchObject({
      status: "CLOSED",
      identityPermit: null,
      quarantinedAt: null,
      closureVerifiedAt: expect.any(Date),
    });
    expect(await db.executionResourceLease.count()).toBe(0);
    expect(await db.browserRuntimeSlot.count()).toBe(0);
    const retry = await writer.acquire();
    expect(await db.executionResourceLease.findMany()).toMatchObject([
      { sessionId: retry.leaseId, mode: "WRITE", quarantined: false },
    ]);
    expect(await db.browserRuntimeSlot.count()).toBe(1);
  });
});

const claimInput: RuntimeTaskClaimInput = {
  capabilities: ["BROWSER_VERIFICATION"],
  protocol: { major: 2, minor: 10, name: "devproof-agent-runtime" as const },
  workerId: "startup-recovery-test-worker",
};
const agentModels = {
  candidatesForPool: async () => [
    {
      apiKey: "test",
      baseUrl: "https://model.example/v1",
      displayName: "Test",
      modelId: "test",
    },
  ],
};

async function unclaimedExecution() {
  const fixture = await execution("READ_ONLY");
  const snapshot = runtimeTaskSnapshotSchema.parse({
    attemptId: fixture.row.attemptId,
    attemptNumber: 1,
    businessReferences: [],
    criteria: [
      {
        id: "page",
        description: "Read the page",
        required: true,
        requiredEvidenceKinds: [],
      },
    ],
    deadlineAt: fixture.run.deadlineAt.toISOString(),
    hardDeadlineAt: fixture.run.hardDeadlineAt.toISOString(),
    environment: { targetUrl },
    executionPolicy: {},
    goal: fixture.run.goal,
    runId: fixture.run.id,
    teamId,
    traceId: fixture.run.traceId,
  });
  const task = await db.agentRuntimeTask.create({
    data: {
      runId: fixture.run.id,
      attemptId: fixture.row.attemptId,
      capability: "BROWSER_VERIFICATION",
      provider: "GENERIC",
      snapshot: snapshot as Prisma.InputJsonValue,
      deadlineAt: fixture.run.deadlineAt,
      createdAt: fixture.row.createdAt,
    },
  });
  await db.executionRun.update({
    where: { id: fixture.run.id },
    data: {
      queueDeadlineAt: fixture.run.deadlineAt,
      executionBudgetSeconds: 120,
      executionMaxExtensionSeconds: 0,
    },
  });
  const lease = await fixture.acquire();
  return { ...fixture, task, lease };
}

async function expireStartup(sessionId: string) {
  await db.browserRuntimeSession.update({
    where: { id: sessionId },
    data: { executionPermitExpiresAt: new Date(Date.now() - 1_000) },
  });
}

function openedBrowsers() {
  return commands.execute.mock.calls.filter(
    ([input]) =>
      (input as { commandType: string }).commandType === "session.open",
  );
}

describe("unclaimed browser startup recovery with PostgreSQL", () => {
  it("skips an expired oldest session and claims the next healthy candidate without a 409", async () => {
    const oldest = await unclaimedExecution();
    const healthy = await unclaimedExecution();
    await expireStartup(oldest.lease.leaseId);
    const service = new AgentRuntimeTaskService(
      db as never,
      agentModels as never,
    );
    const claimed = await service.claim(teamId, claimInput);
    expect(claimed.task?.taskId).toBe(healthy.task.id);
    expect(
      await db.agentRuntimeTask.findUniqueOrThrow({
        where: { id: oldest.task.id },
      }),
    ).toMatchObject({ status: "PENDING", startedAt: null, fencingToken: 0n });
    expect(
      await db.executionRun.findUniqueOrThrow({ where: { id: oldest.run.id } }),
    ).toMatchObject({
      executionBudgetStartedAt: null,
      queueDeadlineAt: oldest.run.deadlineAt,
      deadlineAt: oldest.run.deadlineAt,
    });
  });

  it("rolls back a claim whose Session loses eligibility mid-transaction and continues to a healthy candidate", async () => {
    const oldest = await unclaimedExecution();
    const healthy = await unclaimedExecution();
    let invalidated = false;
    const racing = db.$extends({
      query: {
        browserRuntimeSession: {
          async updateMany({ args, query }) {
            if (!invalidated && args.data.ownerTaskId === oldest.task.id) {
              invalidated = true;
              await db.browserRuntimeSession.update({
                where: { id: oldest.lease.leaseId },
                data: { status: "LOST", quarantinedAt: new Date() },
              });
            }
            return query(args);
          },
        },
      },
    });
    const service = new AgentRuntimeTaskService(
      racing as never,
      agentModels as never,
    );
    expect((await service.claim(teamId, claimInput)).task?.taskId).toBe(
      healthy.task.id,
    );
    expect(invalidated).toBe(true);
    expect(
      await db.agentRuntimeTask.findUniqueOrThrow({
        where: { id: oldest.task.id },
      }),
    ).toMatchObject({ status: "PENDING", startedAt: null, fencingToken: 0n });
    expect(
      await db.executionRun.findUniqueOrThrow({ where: { id: oldest.run.id } }),
    ).toMatchObject({
      executionBudgetStartedAt: null,
      deadlineAt: oldest.run.deadlineAt,
    });
  });

  it("serializes startup cleanup, verifies closure, and re-admits once without resetting the queue budget", async () => {
    const fixture = await unclaimedExecution();
    await expireStartup(fixture.lease.leaseId);
    const admission = new BrowserAdmissionService(db as never, runner);
    await Promise.all([
      admission.recoverStartupExecutions(),
      admission.recoverStartupExecutions(),
    ]);
    expect(
      commands.execute.mock.calls.filter(
        ([input]) =>
          (input as { commandType: string }).commandType === "session.close",
      ),
    ).toHaveLength(1);
    expect(
      await db.browserRuntimeSession.findUniqueOrThrow({
        where: { id: fixture.lease.leaseId },
      }),
    ).toMatchObject({
      status: "CLOSED",
      closureVerifiedAt: expect.any(Date),
      identityPermit: null,
    });
    expect(
      await db.browserExecution.findUniqueOrThrow({
        where: { id: fixture.row.id },
      }),
    ).toMatchObject({
      status: "WAITING_CAPACITY",
      runtimeSessionId: fixture.lease.leaseId,
      startupRecoveryCount: 0,
    });
    expect(await db.browserRuntimeSlot.count()).toBe(0);
    await admission.reconcile();
    const recovered = await db.browserExecution.findUniqueOrThrow({
      where: { id: fixture.row.id },
    });
    expect(recovered).toMatchObject({
      status: "ACTIVE",
      startupRecoveryCount: 1,
    });
    expect(recovered.runtimeSessionId).not.toBe(fixture.lease.leaseId);
    expect(openedBrowsers()).toHaveLength(2);
    expect(
      await db.executionRun.findUniqueOrThrow({
        where: { id: fixture.run.id },
      }),
    ).toMatchObject({
      executionBudgetStartedAt: null,
      queueDeadlineAt: fixture.run.deadlineAt,
      deadlineAt: fixture.run.deadlineAt,
    });
    const service = new AgentRuntimeTaskService(
      db as never,
      agentModels as never,
    );
    expect((await service.claim(teamId, claimInput)).task?.taskId).toBe(
      fixture.task.id,
    );
    expect(
      await db.browserRuntimeSession.findUniqueOrThrow({
        where: { id: recovered.runtimeSessionId! },
      }),
    ).toMatchObject({ ownerTaskId: fixture.task.id, ownerFencingToken: 1n });
  });

  it("does not close a replacement browser when an older recovery scan becomes stale", async () => {
    const fixture = await unclaimedExecution();
    await db.$transaction(async (tx) => {
      await tx.browserRuntimeSession.update({
        where: { id: fixture.lease.leaseId },
        data: { status: "CLOSED", closureVerifiedAt: new Date() },
      });
      await releaseVerifiedSessionResources(tx, fixture.lease.leaseId);
    });
    let replacementSessionId: string | undefined;
    const racing = db.$extends({
      query: {
        agentRuntimeTask: {
          async updateMany({ args, query }) {
            if (
              !replacementSessionId &&
              args.data.recoveryStatus === "STARTUP_CLOSING"
            ) {
              await db.browserExecution.update({
                where: { id: fixture.row.id },
                data: { status: "ALLOCATING", allocationToken: randomUUID() },
              });
              replacementSessionId = (await fixture.acquire()).leaseId;
            }
            return query(args);
          },
        },
      },
    });
    await new BrowserAdmissionService(
      racing as never,
      runner,
    ).recoverStartupExecutions();
    expect(replacementSessionId).toBeDefined();
    expect(
      await db.browserRuntimeSession.findUniqueOrThrow({
        where: { id: replacementSessionId! },
      }),
    ).toMatchObject({
      status: "ACTIVE",
      closureVerifiedAt: null,
      quarantinedAt: null,
    });
    expect(
      await db.agentRuntimeTask.findUniqueOrThrow({
        where: { id: fixture.task.id },
      }),
    ).toMatchObject({ status: "PENDING", recoveryStatus: null });
    expect(
      commands.execute.mock.calls.filter(
        ([input]) =>
          (input as { commandType: string }).commandType === "session.close",
      ),
    ).toHaveLength(0);
  });

  it("exhausts the single startup retry instead of opening browsers forever", async () => {
    const fixture = await unclaimedExecution();
    const admission = new BrowserAdmissionService(db as never, runner);
    await expireStartup(fixture.lease.leaseId);
    await admission.reconcile();
    await admission.reconcile();
    const retried = await db.browserExecution.findUniqueOrThrow({
      where: { id: fixture.row.id },
    });
    expect(retried.startupRecoveryCount).toBe(1);
    await expireStartup(retried.runtimeSessionId!);
    await admission.reconcile();
    await admission.reconcile();
    expect(openedBrowsers()).toHaveLength(2);
    expect(
      await db.browserExecution.findUniqueOrThrow({
        where: { id: fixture.row.id },
      }),
    ).toMatchObject({
      status: "FAILED",
      startupRecoveryCount: 1,
      error: { code: "SESSION_OPEN_FAILED" },
    });
    expect(
      await db.agentRuntimeTask.findUniqueOrThrow({
        where: { id: fixture.task.id },
      }),
    ).toMatchObject({ status: "FAILED", startedAt: null, fencingToken: 0n });
    expect(
      await db.executionRun.findUniqueOrThrow({
        where: { id: fixture.run.id },
      }),
    ).toMatchObject({
      lifecycle: "COMPLETED",
      executionDisposition: "BROWSER_UNAVAILABLE",
      executionBudgetStartedAt: null,
      queueDeadlineAt: fixture.run.deadlineAt,
      deadlineAt: fixture.run.deadlineAt,
    });
  });

  it("bounds repeated session.open failures even when availability policy is WAIT", async () => {
    const fixture = await execution("READ_ONLY");
    await db.browserExecution.update({
      where: { id: fixture.row.id },
      data: { status: "REQUESTED" },
    });
    commands.execute.mockImplementation(
      async (input: { commandType: string }) => ({
        status:
          input.commandType === "session.open" ? "TIMED_OUT" : "SUCCEEDED",
        artifacts: [],
        error: null,
      }),
    );
    const admission = new BrowserAdmissionService(db as never, runner);
    for (let index = 0; index < 4; index++) {
      await db.browserExecution.update({
        where: { id: fixture.row.id },
        data: { nextAdmissionAt: new Date(0) },
      });
      await admission.reconcile();
    }
    expect(openedBrowsers()).toHaveLength(2);
    expect(
      await db.browserExecution.findUniqueOrThrow({
        where: { id: fixture.row.id },
      }),
    ).toMatchObject({
      status: "FAILED",
      startupRecoveryCount: 1,
      error: { code: "SESSION_OPEN_FAILED" },
    });
    expect(await db.browserRuntimeSlot.count()).toBe(0);
    expect(await db.executionResourceLease.count()).toBe(0);
  });

  it("admits unrelated work before waiting for a slow startup close", async () => {
    const expired = await unclaimedExecution();
    await expireStartup(expired.lease.leaseId);
    const waiting = await execution("READ_ONLY");
    await db.browserExecution.update({
      where: { id: waiting.row.id },
      data: { status: "REQUESTED" },
    });
    let notifyClosing!: () => void;
    let completeClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      notifyClosing = resolve;
    });
    const closeCompleted = new Promise<void>((resolve) => {
      completeClose = resolve;
    });
    commands.execute.mockImplementation(
      async (input: { commandType: string }) => {
        if (input.commandType === "session.close") {
          notifyClosing();
          await closeCompleted;
        }
        return { status: "SUCCEEDED", artifacts: [], error: null };
      },
    );
    const reconciliation = new BrowserAdmissionService(
      db as never,
      runner,
    ).reconcile();
    await closing;
    try {
      expect(
        await db.browserExecution.findUniqueOrThrow({
          where: { id: waiting.row.id },
        }),
      ).toMatchObject({ status: "ACTIVE" });
    } finally {
      completeClose();
      await reconciliation;
    }
  });

  it("keeps unknown closure reserved while unrelated healthy work remains claimable", async () => {
    const expired = await unclaimedExecution();
    const healthy = await unclaimedExecution();
    await expireStartup(expired.lease.leaseId);
    commands.execute.mockResolvedValueOnce({
      status: "TIMED_OUT",
      artifacts: [],
      error: null,
    });
    const admission = new BrowserAdmissionService(db as never, runner);
    await admission.recoverStartupExecutions();
    await admission.recoverStartupExecutions();
    expect(openedBrowsers()).toHaveLength(2);
    expect(
      await db.browserExecution.findUniqueOrThrow({
        where: { id: expired.row.id },
      }),
    ).toMatchObject({
      status: "LOST",
      runtimeSessionId: expired.lease.leaseId,
      startupRecoveryCount: 0,
    });
    expect(await db.browserRuntimeSlot.count()).toBe(2);
    expect(
      await db.agentRuntimeTask.findUniqueOrThrow({
        where: { id: expired.task.id },
      }),
    ).toMatchObject({
      status: "PENDING",
      recoveryStatus: "STARTUP_CLOSING",
      fencingToken: 0n,
    });
    expect(
      (
        await new AgentRuntimeTaskService(
          db as never,
          agentModels as never,
        ).claim(teamId, claimInput)
      ).task?.taskId,
    ).toBe(healthy.task.id);
  });

  it("preserves an unclaimed browser during its valid human control window", async () => {
    const fixture = await unclaimedExecution();
    await db.browserRuntimeSession.update({
      where: { id: fixture.lease.leaseId },
      data: {
        status: "HUMAN_CONTROL",
        executionPermitExpiresAt: new Date(Date.now() - 1_000),
        humanControlExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await new BrowserAdmissionService(
      db as never,
      runner,
    ).recoverStartupExecutions();
    expect(
      commands.execute.mock.calls.filter(
        ([input]) =>
          (input as { commandType: string }).commandType === "session.close",
      ),
    ).toHaveLength(0);
    expect(
      await db.browserRuntimeSession.findUniqueOrThrow({
        where: { id: fixture.lease.leaseId },
      }),
    ).toMatchObject({ status: "HUMAN_CONTROL", quarantinedAt: null });
  });

  it("never startup-recovers or reopens an Attempt that an Agent already claimed", async () => {
    const fixture = await unclaimedExecution();
    await new AgentRuntimeTaskService(db as never, agentModels as never).claim(
      teamId,
      claimInput,
    );
    await db.$transaction(async (tx) => {
      await quarantineSession(tx, fixture.lease.leaseId, "TEST_CLAIMED_LOST");
      await tx.browserRuntimeSession.update({
        where: { id: fixture.lease.leaseId },
        data: { status: "CLOSED", closureVerifiedAt: new Date() },
      });
      await releaseVerifiedSessionResources(tx, fixture.lease.leaseId);
    });
    await new BrowserAdmissionService(
      db as never,
      runner,
    ).recoverStartupExecutions();
    await expect(fixture.acquire()).rejects.toMatchObject({
      reason: "LEASE_RECOVERY",
    });
    expect(openedBrowsers()).toHaveLength(1);
    expect(
      await db.browserExecution.findUniqueOrThrow({
        where: { id: fixture.row.id },
      }),
    ).toMatchObject({
      runtimeSessionId: fixture.lease.leaseId,
      startupRecoveryCount: 0,
    });
  });
});
