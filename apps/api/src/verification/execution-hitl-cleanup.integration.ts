import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: () => ({ RUNTIME_LEASE_SECONDS: 90 }),
}));

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
const commands = {
  execute: vi.fn().mockResolvedValue({
    status: "SUCCEEDED",
    artifacts: [],
    error: null,
  }),
};
const runner = new BrowserExecutionRunner(
  db as never,
  {} as never,
  commands as never,
  {} as never,
);
const cleanup = new UnifiedRunCleanupWorker(db as never, runner);
const sessions = new RuntimeSessionsService(
  db as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
);

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "teams", "users" RESTART IDENTITY CASCADE',
  );
  commands.execute.mockClear();
});
afterAll(async () => db.$disconnect());

async function waitingHumanFixture(transition: string) {
  const team = await db.team.create({
    data: {
      slug: randomUUID(),
      name: "HITL write cleanup",
      feishuTenantKey: randomUUID(),
    },
  });
  const user = await db.user.create({
    data: { name: "Operator", memberships: { create: { teamId: team.id } } },
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
      protocolMinor: 13,
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
  it("retries resource cleanup after a verified close committed but the cleanup transaction failed", async () => {
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
    const transaction = db.$transaction.bind(db);
    const transactions = vi
      .spyOn(db, "$transaction")
      .mockImplementationOnce((input) => transaction(input))
      .mockRejectedValueOnce(
        new Error("transient cleanup transaction failure"),
      );
    try {
      await cleanup.tick();
      expect(
        await db.browserRuntimeSession.findUniqueOrThrow({
          where: { id: session.id },
        }),
      ).toMatchObject({
        status: "CLOSED",
        closureVerifiedAt: expect.any(Date),
      });
      expect(await db.browserExecution.findFirstOrThrow()).toMatchObject({
        status: "RELEASING",
      });
      expect(await db.browserRuntimeSlot.count()).toBe(1);

      await cleanup.tick();
      expect(commands.execute).toHaveBeenCalledOnce();
      expect(await db.browserRuntimeSlot.count()).toBe(0);
      expect(await db.browserExecution.findFirstOrThrow()).toMatchObject({
        status: "RELEASED",
      });
      expect(
        await db.agentRuntimeTask.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({
        recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
      });
      expect(await db.executionResourceLease.findFirstOrThrow()).toMatchObject({
        quarantined: true,
      });
    } finally {
      transactions.mockRestore();
    }
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

      // The real cleanup worker performs the terminal transition and consumes the
      // mocked browser's verified close ACK through BrowserExecutionRunner.
      await cleanup.tick();
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

      await expect(
        sessions.resolveWriteOutcome(
          current,
          session.id,
          "Operator checked the model record and reconciled the pending write.",
        ),
      ).resolves.toEqual({ released: 1 });
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
