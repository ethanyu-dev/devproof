import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: () => ({
    SPEC_ANALYSIS_MODE: "AGENT",
    AGENT_RUNTIME_TASK_LEASE_SECONDS: 60,
  }),
}));

import { SpecAnalysisRuntimeService } from "./spec-analysis-runtime.service.js";
import { TaskExecutionService } from "../task-executions/task-execution.service.js";

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
    "Refusing to test Spec leases against a non-disposable database.",
  );

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString, max: 12 }),
});
const service = new SpecAnalysisRuntimeService(
  db as never,
  {
    candidatesForPool: async () => [{ model: "fixture", provider: "OPENAI" }],
  } as never,
  {} as never,
  {} as never,
  {} as never,
);
const releasePendingRequests = vi.fn().mockResolvedValue(0);
const releaseTask = vi.fn().mockResolvedValue(0);
const coordinator = new TaskExecutionService(
  db as never,
  {} as never,
  {} as never,
  { releasePendingRequests } as never,
  { releaseTask } as never,
  {} as never,
);

beforeEach(async () => {
  vi.clearAllMocks();
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "teams", "users" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => db.$disconnect());

async function fixture(
  options: {
    maxAttempts?: number;
    expired?: boolean;
    deadlineElapsed?: boolean;
  } = {},
) {
  const team = await db.team.create({
    data: {
      slug: randomUUID(),
      name: "Spec lease recovery",
      feishuTenantKey: randomUUID(),
    },
  });
  const leaseToken = randomUUID();
  const task = await db.taskExecution.create({
    data: {
      teamId: team.id,
      kind: "ISSUE_SPEC",
      sourceKind: "TEST",
      idempotencyKey: randomUUID(),
      title: "Spec lease fixture",
      lifecycle: "RUNNING",
      inputSnapshot: {
        analysisMaxAttempts: options.maxAttempts ?? 2,
        browserPolicy: {
          availabilityPolicy: "WAIT",
          profile: { mode: "EPHEMERAL" },
          requiredCapabilities: ["browser"],
        },
        idempotencyKey: "spec-lease-fixture",
        issueRef: "TEST-1",
        kind: "ISSUE_SPEC",
      },
      traceId: randomUUID().replaceAll("-", ""),
      deadlineAt: new Date(
        Date.now() + (options.deadlineElapsed ? -1_000 : 600_000),
      ),
      stages: {
        create: {
          type: "SPEC_ANALYSIS",
          status: "RUNNING",
          currentAttemptNumber: 1,
          maxAttempts: options.maxAttempts ?? 2,
          attempts: {
            create: {
              number: 1,
              status: "RUNNING",
              inputSnapshot: {},
              leaseOwner: "old-worker",
              leaseToken,
              leaseExpiresAt: new Date(
                Date.now() + (options.expired === false ? 60_000 : -1_000),
              ),
              fencingToken: 1n,
              startedAt: new Date(Date.now() - 120_000),
            },
          },
        },
      },
    },
    include: { stages: { include: { attempts: true } } },
  });
  await db.taskExecutionStage.createMany({
    data: ["PROFILE_RESOLUTION", "SPEC_EXECUTION"].map((type) => ({
      taskExecutionId: task.id,
      type: type as "PROFILE_RESOLUTION" | "SPEC_EXECUTION",
    })),
  });
  await db.taskProfileBinding.create({
    data: {
      taskExecutionId: task.id,
      strategy: "EPHEMERAL",
      triggerSource: "CONSOLE",
      unavailablePolicy: "WAIT_FOR_PROFILE",
    },
  });
  const stage = task.stages[0]!;
  return {
    teamId: team.id,
    taskId: task.id,
    stageId: stage.id,
    attempt: stage.attempts[0]!,
    lease: { fencingToken: "1", leaseToken, workerId: "old-worker" },
  };
}

describe("Spec leases on PostgreSQL", () => {
  it("allows competing workers to recover an expired lease into exactly one new Attempt", async () => {
    const original = await fixture();
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        service.claim(original.teamId, {
          protocol: { minor: 11 },
          workerId: `new-worker-${index}`,
        }),
      ),
    );
    const claimed = claims.flatMap((result) =>
      result.task ? [result.task] : [],
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.taskId).not.toBe(original.attempt.id);
    expect(claimed[0]!.snapshot.attemptNumber).toBe(2);
    const attempts = await db.taskStageAttempt.findMany({
      where: { stageId: original.stageId },
      orderBy: { number: "asc" },
    });
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "FAILED",
      "RUNNING",
    ]);
    expect(attempts[0]).toMatchObject({
      fencingToken: 2n,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    await expect(
      service.heartbeat(original.teamId, original.attempt.id, original.lease),
    ).rejects.toThrow();
    await expect(
      service.appendEvent(original.teamId, original.attempt.id, {
        ...original.lease,
        event: {
          eventId: randomUUID(),
          kind: "agent.segment.completed",
          occurredAt: new Date().toISOString(),
          payload: {
            attemptNumber: 1,
            segmentId: "old-segment",
            durationMs: 100,
            status: "SUCCEEDED",
          },
        },
      }),
    ).rejects.toThrow();
    expect(
      await db.taskExecutionEvent.count({
        where: {
          taskExecutionId: original.taskId,
          kind: "agent.segment.completed",
        },
      }),
    ).toBe(0);
  });

  it("preserves a live lease while renewal and competing claims execute concurrently", async () => {
    const original = await fixture({ expired: false });
    const [renewed, ...claims] = await Promise.all([
      service.heartbeat(original.teamId, original.attempt.id, original.lease),
      ...Array.from({ length: 4 }, (_, index) =>
        service.claim(original.teamId, {
          protocol: { minor: 11 },
          workerId: `competitor-${index}`,
        }),
      ),
    ]);
    expect(renewed).toMatchObject({ directive: "CONTINUE" });
    expect(claims).toEqual(Array.from({ length: 4 }, () => ({ task: null })));
    expect(
      await db.taskStageAttempt.count({ where: { stageId: original.stageId } }),
    ).toBe(1);
  });

  it.each([
    {
      name: "exhausted analysis budget",
      maxAttempts: 1,
      deadlineElapsed: false,
    },
    { name: "elapsed parent deadline", maxAttempts: 2, deadlineElapsed: true },
  ])("does not restart after $name", async (options) => {
    const original = await fixture(options);
    const claims = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        service.claim(original.teamId, {
          protocol: { minor: 11 },
          workerId: `competitor-${index}`,
        }),
      ),
    );
    expect(claims).toEqual(Array.from({ length: 4 }, () => ({ task: null })));
    expect(
      await db.taskStageAttempt.count({ where: { stageId: original.stageId } }),
    ).toBe(1);
    const stage = await db.taskExecutionStage.findUniqueOrThrow({
      where: { id: original.stageId },
    });
    expect(["FAILED", "TIMED_OUT"]).toContain(stage.status);
    expect(stage.finishedAt).not.toBeNull();
    const attempt = await db.taskStageAttempt.findUniqueOrThrow({
      where: { id: original.attempt.id },
    });
    expect(attempt.leaseToken).toBeNull();
    expect(attempt.fencingToken).toBe(2n);
    await coordinator.projectTask(original.taskId);
    const parent = await db.taskExecution.findUniqueOrThrow({
      where: { id: original.taskId },
    });
    expect(parent.lifecycle).toBe(
      options.deadlineElapsed ? "TIMED_OUT" : "COMPLETED",
    );
    expect(parent.finishedAt).not.toBeNull();
    expect(parent.projectionNeededAt).toBeNull();
    expect(releasePendingRequests).toHaveBeenCalledOnce();
    expect(releaseTask).toHaveBeenCalledWith(original.taskId);
    expect(
      await db.taskExecutionEvent.count({
        where: { taskExecutionId: original.taskId, kind: "task.completed" },
      }),
    ).toBe(1);
  });

  it("does not renew a lease that expires while the heartbeat waits for its row lock", async () => {
    const original = await fixture({ expired: false });
    await db.taskStageAttempt.update({
      where: { id: original.attempt.id },
      data: { leaseExpiresAt: new Date(Date.now() + 800) },
    });
    let unlock!: () => void;
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM task_stage_attempts WHERE id = ${original.attempt.id}::uuid FOR UPDATE`;
      locked();
      await release;
    });
    await acquired;
    const heartbeat = service.heartbeat(
      original.teamId,
      original.attempt.id,
      original.lease,
    );
    // Observe the actual PostgreSQL wait instead of assuming that the RPC has
    // reached its ownership check before the lease expires.
    const rejected = expect(heartbeat).rejects.toThrow(/lease/u);
    try {
      let waiting = false;
      for (let poll = 0; poll < 40 && !waiting; poll++) {
        const rows = await db.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%task_stage_attempts%'`;
        waiting = Number(rows[0]!.count) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await db.$queryRaw`SELECT pg_sleep(0.9)::text`;
    } finally {
      unlock();
      await holder;
    }
    await rejected;
    const attempt = await db.taskStageAttempt.findUniqueOrThrow({
      where: { id: original.attempt.id },
    });
    expect(attempt.leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
    expect(attempt.fencingToken).toBe(1n);
  });
});
