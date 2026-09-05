import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: () => ({
    RUNTIME_LEASE_SECONDS: 90,
    RUNTIME_SESSION_RECOVERY_ENABLED: true,
  }),
}));

import { SessionRecoveryService } from "../runtime/session-recovery.service.js";
import { SessionClosureService } from "../runtime/session-closure.service.js";
import { SessionRecoveryWorker } from "../runtime/session-recovery.worker.js";
import { ExecutionRunService } from "../execution-runs/execution-run.service.js";
import { UnifiedRunCleanupWorker } from "../execution-runs/unified-run-cleanup.worker.js";
import { RuntimeSessionsService } from "../runtime/runtime-sessions.service.js";
import { releaseVerifiedSessionResources } from "../runtime/session-resource-cleanup.js";
import { BrowserExecutionRunner } from "./browser-execution-runner.service.js";

const connectionString = process.env.DEVPROOF_CONCURRENCY_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("Use the disposable PostgreSQL concurrency test launcher.");
const destination = new URL(connectionString);
if (
  destination.hostname !== "127.0.0.1" ||
  destination.username !== "devproof_test" ||
  !/^\/devproof_concurrency_test_[a-f\d]{8}$/u.test(destination.pathname)
)
  throw new Error(
    "Refusing to test HITL cleanup against a non-disposable database.",
  );

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const previousRecoveryEnabled = process.env.RUNTIME_SESSION_RECOVERY_ENABLED;
const recoveries = new SessionRecoveryService(db as never);
const closures = new SessionClosureService(db as never);
const commands = { execute: vi.fn(verifiedCommand) };
const runner = new BrowserExecutionRunner(
  db as never,
  {} as never,
  commands as never,
  {} as never,
  recoveries,
  closures,
);
const cleanup = new UnifiedRunCleanupWorker(
  db as never,
  runner,
  undefined,
  recoveries,
);
const recoveryWorker = new SessionRecoveryWorker(
  db as never,
  recoveries,
  closures,
  commands as never,
);
const sessions = new RuntimeSessionsService(
  db as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  recoveries,
  closures,
);

beforeEach(async () => {
  process.env.RUNTIME_SESSION_RECOVERY_ENABLED = "true";
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "runtime_recovery_permits", "runtime_recovery_outbox", "session_closure_evidence", "runtime_session_recoveries", "runtime_drain_attestations", "teams", "users" RESTART IDENTITY CASCADE',
  );
  commands.execute.mockClear();
});
afterAll(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "runtime_recovery_permits", "runtime_recovery_outbox", "session_closure_evidence", "runtime_session_recoveries", "runtime_drain_attestations" CASCADE',
  );
  await db.$disconnect();
  if (previousRecoveryEnabled === undefined)
    delete process.env.RUNTIME_SESSION_RECOVERY_ENABLED;
  else process.env.RUNTIME_SESSION_RECOVERY_ENABLED = previousRecoveryEnabled;
});

async function verifiedCommand(input: {
  commandType: string;
  sessionId: string;
  commandId?: string;
}) {
  if (input.commandType !== "session.close")
    throw new Error("The cleanup fixture must not execute business commands.");
  const stored = input.commandId
    ? await db.browserRuntimeCommand.findUnique({
        where: { id: input.commandId },
      })
    : null;
  const recoveryPayload = stored?.payload as {
    recovery?: { recoveryId: string; requestId: string };
  } | null;
  const request =
    recoveryPayload?.recovery ??
    (await recoveries.prepareClose(
      input.sessionId,
      input.commandId ?? randomUUID(),
    ));
  const session = await db.browserRuntimeSession.findUniqueOrThrow({
    where: { id: input.sessionId },
    include: { runtime: true },
  });
  const runtime = session.runtime;
  await closures.acceptRuntimeEvidence(
    {
      runtimeId: runtime.id,
      connectionId: runtime.connectionId!,
      connectionGeneration: runtime.connectionGeneration,
      negotiatedMinor: 14,
      capabilities: new Set(["closure-evidence-v1"]),
      hostInstanceId: runtime.hostInstanceId!,
      daemonInstanceId: runtime.daemonInstanceId!,
    },
    {
      evidenceId: randomUUID(),
      recoveryId: request.recoveryId,
      requestId: request.requestId,
      sessionId: session.id,
      leaseToken: session.leaseToken,
      fencingToken: session.fencingToken.toString(),
      hostInstanceId: runtime.hostInstanceId!,
      daemonInstanceId: runtime.daemonInstanceId!,
      launchIdentityVersion: 1,
      method: "LIVE_SESSION_TERMINATED",
      networkRevoked: true,
      closureCompletedAt: new Date().toISOString(),
    },
  );
  return {
    id: request.requestId,
    status: "SUCCEEDED",
    artifacts: [],
    error: null,
  };
}

async function waitingHumanFixture(transition: string) {
  const team = await db.team.create({
    data: {
      slug: randomUUID(),
      name: "HITL write cleanup",
      feishuTenantKey: randomUUID(),
    },
  });
  const user = await db.user.create({
    data: {
      name: "Operator",
      memberships: { create: { teamId: team.id, role: "ADMIN" } },
    },
  });
  const deadline = new Date(
    Date.now() + (transition === "run-timeout" ? -1000 : 600_000),
  );
  const run = await db.executionRun.create({
    data: {
      teamId: team.id,
      idempotencyKey: randomUUID(),
      goal: "Confirm a possibly completed write after human intervention",
      lifecycle: "WAITING_HUMAN",
      criteriaSnapshot: [],
      concurrencyPolicy: { accessMode: "MUTATING" },
      executionPolicy: {
        hitl: {
          enabled: true,
          notificationChannels: [],
          onTimeout: transition === "hitl-cancel" ? "CANCEL" : "INCONCLUSIVE",
          timeoutSeconds: 3600,
        },
      },
      traceId: randomUUID().replaceAll("-", ""),
      initialDeadlineAt: deadline,
      deadlineAt: deadline,
      hardDeadlineAt: deadline,
      startedAt: new Date(Date.now() - 60_000),
      attempts: {
        create: { number: 1, status: "WAITING_HUMAN", inputSnapshot: {} },
      },
    },
    include: { attempts: true },
  });
  const attemptId = run.attempts[0]!.id;
  const task = await db.agentRuntimeTask.create({
    data: {
      runId: run.id,
      attemptId,
      capability: "browser.verify",
      status: "WAITING_HUMAN",
      snapshot: {},
      result: { kind: "WAITING_HUMAN" },
      completionId: randomUUID(),
      fencingToken: 1n,
      deadlineAt: deadline,
    },
  });
  const runtime = await db.browserRuntime.create({
    data: {
      teamId: team.id,
      instanceKey: randomUUID(),
      name: "HITL runtime",
      tokenHash: randomUUID(),
      tokenHint: "test",
      protocolMajor: 1,
      protocolMinor: 14,
      status: "ONLINE",
      capabilities: ["closure-evidence-v1"],
      connectionId: randomUUID(),
      connectionGeneration: 1n,
      hostInstanceId: "hitl-original-host",
      daemonInstanceId: "hitl-original-daemon",
      maxConcurrency: 4,
    },
  });
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 60_000);
  const session = await db.browserRuntimeSession.create({
    data: {
      teamId: team.id,
      runtimeId: runtime.id,
      status: "HUMAN_CONTROL",
      profileMode: "EPHEMERAL",
      profileKey: randomUUID(),
      purpose: "EXECUTION",
      slotNumber: 0,
      protocolMajor: 1,
      protocolMinor: 13,
      leaseToken,
      leaseExpiresAt,
      fencingToken: 1n,
      ownerTaskId: task.id,
      ownerFencingToken: 1n,
      slot: {
        create: {
          runtimeId: runtime.id,
          slotNumber: 0,
          leaseToken,
          fencingToken: 1n,
          expiresAt: leaseExpiresAt,
        },
      },
      resourceLeases: {
        create: {
          rootKey: "origin:https://test-duo.paigod.work",
          resourceKey: "model-names",
          mode: "WRITE",
        },
      },
    },
  });
  await db.browserExecution.create({
    data: {
      runId: run.id,
      attemptId,
      runtimeSessionId: session.id,
      status: "HUMAN_CONTROL",
    },
  });
  await db.browserRuntimeCommand.create({
    data: {
      sessionId: session.id,
      source: "CONSOLE",
      commandType: "page.click",
      status: "TIMED_OUT",
      payload: { point: { x: 100, y: 100 } },
      leaseToken,
      fencingToken: 1n,
      deadlineAt: new Date(),
    },
  });
  await db.humanIntervention.create({
    data: {
      teamId: team.id,
      runId: run.id,
      attemptId,
      taskId: task.id,
      kind: "BROWSER_CONTROL",
      prompt: "Confirm whether the submitted change completed.",
      expiresAt: new Date(
        Date.now() + (transition.startsWith("hitl-") ? -1000 : 600_000),
      ),
    },
  });
  return {
    run,
    task,
    session,
    current: {
      sessionId: randomUUID(),
      team: { id: team.id, name: team.name, slug: team.slug },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: null,
      },
    },
  };
}

describe("PostgreSQL uncertain writes after human intervention", () => {
  it("rolls back proof and resource release together on a transient database failure, then retries the same command", async () => {
    const { run, task, session, current } = await waitingHumanFixture("cancel");
    await new ExecutionRunService(db as never, {} as never).cancel(
      {
        ...current,
        credential: {
          id: randomUUID(),
          name: "Console",
          scopes: ["run:cancel"],
        },
      },
      run.id,
    );
    await cleanup.tick();
    // Fault injection occurs inside real PostgreSQL, after the proof insert but before slot removal.
    await db.$executeRawUnsafe(
      `CREATE FUNCTION fixture_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture transient cleanup failure'; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER fixture_cleanup_failure BEFORE DELETE ON browser_runtime_slots FOR EACH ROW EXECUTE FUNCTION fixture_cleanup_failure()`,
    );
    try {
      await recoveryWorker.tick();
      expect(
        await db.browserRuntimeSession.findUniqueOrThrow({
          where: { id: session.id },
        }),
      ).toMatchObject({
        status: "LOST",
        closureVerifiedAt: null,
        closureEvidenceId: null,
      });
      expect(await db.sessionClosureEvidence.count()).toBe(0);
      expect(await db.browserRuntimeSlot.count()).toBe(1);
      expect(await db.executionResourceLease.findFirstOrThrow()).toMatchObject({
        quarantined: true,
      });
    } finally {
      await db.$executeRawUnsafe(
        "DROP TRIGGER fixture_cleanup_failure ON browser_runtime_slots",
      );
      await db.$executeRawUnsafe("DROP FUNCTION fixture_cleanup_failure()");
    }
    // The pending RPC keeps its Runtime permit until the prior owner expires.
    expect(
      await db.runtimeRecoveryPermit.count({
        where: { runtimeId: session.runtimeId },
      }),
    ).toBe(1);
    await db.$transaction([
      db.runtimeSessionRecovery.updateMany({
        where: { sessionId: session.id },
        data: { nextAttemptAt: new Date(0), claimExpiresAt: new Date(0) },
      }),
      db.runtimeRecoveryPermit.updateMany({
        where: { runtimeId: session.runtimeId },
        data: { claimExpiresAt: new Date(0) },
      }),
    ]);
    await recoveryWorker.tick();
    expect(commands.execute).toHaveBeenCalledTimes(2);
    expect(
      await db.browserRuntimeCommand.count({
        where: { sessionId: session.id, commandType: "session.close" },
      }),
    ).toBe(1);
    expect(await db.browserRuntimeSlot.count()).toBe(0);
    expect(await db.browserExecution.findFirstOrThrow()).toMatchObject({
      status: "RELEASED",
    });
    expect(
      await db.agentRuntimeTask.findUniqueOrThrow({ where: { id: task.id } }),
    ).toMatchObject({ recoveryStatus: "WRITE_OUTCOME_UNKNOWN" });
    expect(await db.executionResourceLease.findFirstOrThrow()).toMatchObject({
      quarantined: true,
    });
  });

  it.each([
    { transition: "cancel", taskStatus: "CANCELLED", lifecycle: "CANCELLED" },
    {
      transition: "hitl-cancel",
      taskStatus: "CANCELLED",
      lifecycle: "CANCELLED",
    },
    {
      transition: "hitl-inconclusive",
      taskStatus: "FAILED",
      lifecycle: "COMPLETED",
    },
    {
      transition: "run-timeout",
      taskStatus: "TIMED_OUT",
      lifecycle: "TIMED_OUT",
    },
  ])(
    "preserves and reconciles the write after $transition",
    async ({ transition, taskStatus, lifecycle }) => {
      const { run, task, session, current } =
        await waitingHumanFixture(transition);
      if (transition === "cancel")
        await new ExecutionRunService(db as never, {} as never).cancel(
          {
            ...current,
            credential: {
              id: randomUUID(),
              name: "Console",
              scopes: ["run:cancel"],
            },
          },
          run.id,
        );

      // Cleanup enqueues durable recovery; the worker sends a challenge and this
      // fixture responds through the actual authenticated proof transaction.
      await cleanup.tick();
      await recoveryWorker.tick();
      expect(commands.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          commandType: "session.close",
        }),
      );
      expect(
        await db.agentRuntimeTask.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({
        status: taskStatus,
        result: { kind: "WAITING_HUMAN" },
        completionId: task.completionId,
        recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
      });
      expect(
        await db.executionRun.findUniqueOrThrow({ where: { id: run.id } }),
      ).toMatchObject({ lifecycle });
      expect(await db.executionResourceLease.findFirstOrThrow()).toMatchObject({
        sessionId: session.id,
        quarantined: true,
      });
      expect(await db.browserRuntimeSlot.count()).toBe(0);

      const recovery = await db.runtimeSessionRecovery.findFirstOrThrow({
        where: { sessionId: session.id },
      });
      await expect(
        sessions.resolveWriteOutcome(
          current,
          session.id,
          "Operator checked the model record and reconciled the pending write.",
          {
            expectedVersion: recovery.version,
            idempotencyKey: randomUUID(),
            outcome: "VERIFIED",
            evidenceRefs: ["fixture://hitl-business-audit"],
          },
        ),
      ).resolves.toMatchObject({ released: 1 });
      await db.$transaction((tx) =>
        releaseVerifiedSessionResources(tx, session.id),
      );
      expect(await db.executionResourceLease.count()).toBe(0);
      expect(
        await db.agentRuntimeTask.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({ recoveryStatus: "RESOLVED" });
      expect(
        await db.browserRuntimeSession.findUniqueOrThrow({
          where: { id: session.id },
        }),
      ).toMatchObject({ status: "CLOSED", quarantinedAt: null });
      expect(
        await db.auditEvent.count({
          where: { action: "runtime.write_outcome.reconciled" },
        }),
      ).toBe(1);
    },
  );
});
