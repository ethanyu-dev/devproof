import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteTask } from "./task-delete.js";
import type { PrismaService } from "../database/prisma.service.js";

const connectionString = process.env.DEVPROOF_CONCURRENCY_TEST_DATABASE_URL;
if (
  !connectionString ||
  !/^postgresql:\/\/devproof_test:[^@]+@127\.0\.0\.1:\d+\/devproof_concurrency_test_[a-f\d]{8}$/u.test(
    connectionString,
  )
)
  throw new Error("Use the disposable PostgreSQL concurrency test launcher.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const serviceDb = db as PrismaService;
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "teams", "users", "object_storage_deletion_tasks" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function fixture() {
  const team = await db.team.create({
    data: {
      name: "Delete test",
      slug: randomUUID(),
      feishuTenantKey: randomUUID(),
    },
  });
  const task = await db.taskExecution.create({
    data: {
      teamId: team.id,
      kind: "ISSUE_SPEC",
      sourceKind: "API",
      idempotencyKey: randomUUID(),
      title: "Disposable task",
      lifecycle: "COMPLETED",
      inputSnapshot: {},
      traceId: "a".repeat(32),
      deadlineAt: new Date(),
    },
  });
  const stage = await db.taskExecutionStage.create({
    data: {
      taskExecutionId: task.id,
      type: "SPEC_ANALYSIS",
      status: "SUCCEEDED",
    },
  });
  const stageAttempt = await db.taskStageAttempt.create({
    data: {
      stageId: stage.id,
      number: 1,
      status: "SUCCEEDED",
      inputSnapshot: {},
    },
  });
  const spec = await db.taskSpecificationSnapshot.create({
    data: {
      taskExecutionId: task.id,
      stageAttemptId: stageAttempt.id,
      sourceHash: "b".repeat(64),
      context: {},
      completeness: "COMPLETE",
      generatorKind: "AGENT",
      generatorVersion: "test",
      summary: "Test",
    },
  });
  const testCase = await db.taskGeneratedTestCase.create({
    data: {
      snapshotId: spec.id,
      name: "Case",
      position: 1,
      definition: {},
      definitionHash: "c".repeat(64),
    },
  });
  const deployment = await db.taskDeployment.create({
    data: {
      taskExecutionId: task.id,
      key: "test",
      name: "Test",
      targetUrl: "https://test.example",
    },
  });
  const run = await db.executionRun.create({
    data: {
      taskExecutionId: task.id,
      teamId: team.id,
      idempotencyKey: randomUUID(),
      goal: "Case",
      criteriaSnapshot: [],
      traceId: "a".repeat(32),
      lifecycle: "COMPLETED",
      initialDeadlineAt: new Date(),
      deadlineAt: new Date(),
      hardDeadlineAt: new Date(),
    },
  });
  await db.taskCaseExecution.create({
    data: {
      taskExecutionId: task.id,
      caseId: testCase.id,
      deploymentId: deployment.id,
      runId: run.id,
      dispatchStatus: "LINKED",
    },
  });
  const attempt = await db.runAttempt.create({
    data: { runId: run.id, number: 1, status: "SUCCEEDED", inputSnapshot: {} },
  });
  const agent = await db.agentRuntimeTask.create({
    data: {
      runId: run.id,
      attemptId: attempt.id,
      capability: "browser_verification",
      status: "SUCCEEDED",
      snapshot: {},
      deadlineAt: new Date(),
    },
  });
  await db.runEvent.create({
    data: {
      teamId: team.id,
      runId: run.id,
      attemptId: attempt.id,
      taskId: agent.id,
      kind: "test",
      actor: "TEST",
      payload: {},
      occurredAt: new Date(),
    },
  });
  await db.taskExecutionEvent.create({
    data: {
      teamId: team.id,
      taskExecutionId: task.id,
      kind: "test",
      actor: "TEST",
      payload: {},
      occurredAt: new Date(),
    },
  });
  return { team, task, stageAttempt, run, attempt, agent };
}
async function withEvidence(f: Awaited<ReturnType<typeof fixture>>) {
  const runtime = await db.browserRuntime.create({
    data: {
      teamId: f.team.id,
      name: "Test",
      instanceKey: randomUUID(),
      tokenHash: randomUUID(),
      tokenHint: "test",
    },
  });
  const session = await db.browserRuntimeSession.create({
    data: {
      teamId: f.team.id,
      runtimeId: runtime.id,
      profileMode: "EPHEMERAL",
      profileKey: randomUUID(),
      slotNumber: 1,
      leaseToken: randomUUID(),
      fencingToken: 1n,
      leaseExpiresAt: new Date(),
      protocolMajor: 1,
      protocolMinor: 0,
      status: "CLOSED",
      closedAt: new Date(),
      closureVerifiedAt: new Date(),
      closureEvidenceId: randomUUID(),
      ownerTaskId: f.agent.id,
    },
  });
  const artifact = await db.browserRuntimeArtifact.create({
    data: {
      sessionId: session.id,
      kind: "SCREENSHOT",
      storageKey: `deletion-test/${randomUUID()}`,
      contentType: "image/png",
      byteSize: 1,
      sha256: "a".repeat(64),
    },
  });
  await db.runEvidence.create({
    data: {
      teamId: f.team.id,
      runId: f.run.id,
      attemptId: f.attempt.id,
      externalId: randomUUID(),
      kind: "SCREENSHOT",
      runtimeArtifactId: artifact.id,
      label: "Evidence",
    },
  });
  return { session, artifact };
}

describe("task hard deletion", () => {
  it.each(["QUEUED", "RUNNING", "WAITING_HUMAN", "WAITING_INPUT"] as const)(
    "rejects %s tasks without deleting children",
    async (lifecycle) => {
      const f = await fixture();
      await db.taskExecution.update({
        where: { id: f.task.id },
        data: { lifecycle },
      });
      await expect(deleteTask(serviceDb, f.team.id, f.task.id)).rejects.toThrow(
        "任务尚未结束",
      );
      expect(await db.executionRun.count()).toBe(1);
    },
  );
  it("enforces team ownership and returns not found on repeat deletion", async () => {
    const f = await fixture();
    await expect(
      deleteTask(serviceDb, randomUUID(), f.task.id),
    ).rejects.toThrow("任务不存在");
    await deleteTask(serviceDb, f.team.id, f.task.id);
    await expect(deleteTask(serviceDb, f.team.id, f.task.id)).rejects.toThrow(
      "任务不存在",
    );
  });
  it("deletes all aggregate descendants and exclusively owned evidence, queuing storage deletion", async () => {
    const f = await fixture();
    const { session, artifact } = await withEvidence(f);
    await deleteTask(serviceDb, f.team.id, f.task.id);
    for (const count of [
      () => db.taskExecution.count(),
      () => db.taskExecutionStage.count(),
      () => db.taskStageAttempt.count(),
      () => db.taskSpecificationSnapshot.count(),
      () => db.taskGeneratedTestCase.count(),
      () => db.taskCaseExecution.count(),
      () => db.taskDeployment.count(),
      () => db.executionRun.count(),
      () => db.runAttempt.count(),
      () => db.agentRuntimeTask.count(),
      () => db.runEvent.count(),
      () => db.taskExecutionEvent.count(),
      () => db.runEvidence.count(),
    ])
      expect(await count()).toBe(0);
    expect(
      await db.browserRuntimeSession.findUnique({ where: { id: session.id } }),
    ).toBeNull();
    expect(
      await db.browserRuntimeArtifact.findUnique({
        where: { id: artifact.id },
      }),
    ).toBeNull();
    expect(
      await db.objectStorageDeletionTask.findUnique({
        where: { storageKey: artifact.storageKey },
      }),
    ).not.toBeNull();
    expect(await db.browserRuntime.count()).toBe(1);
  });
  it("rejects a running child even when the parent is terminal", async () => {
    const f = await fixture();
    await db.agentRuntimeTask.update({
      where: { id: f.agent.id },
      data: { status: "RUNNING" },
    });
    await expect(deleteTask(serviceDb, f.team.id, f.task.id)).rejects.toThrow(
      "子执行",
    );
    expect(await db.taskExecution.count()).toBe(1);
  });
  it("does not bypass browser closure or resource release", async () => {
    const f = await fixture();
    const { session } = await withEvidence(f);
    await db.browserRuntimeSession.update({
      where: { id: session.id },
      data: { closureVerifiedAt: null },
    });
    await expect(deleteTask(serviceDb, f.team.id, f.task.id)).rejects.toThrow(
      "浏览器尚未完成关闭",
    );
    expect(await db.runEvidence.count()).toBe(1);
    expect(await db.objectStorageDeletionTask.count()).toBe(0);
  });
  it("preserves evidence and sessions also referenced by another task", async () => {
    const f = await fixture();
    const { artifact, session } = await withEvidence(f);
    const other = await db.executionRun.create({
      data: {
        teamId: f.team.id,
        goal: "Shared evidence owner",
        criteriaSnapshot: [],
        traceId: "b".repeat(32),
        lifecycle: "COMPLETED",
        initialDeadlineAt: new Date(),
        deadlineAt: new Date(),
        hardDeadlineAt: new Date(),
        idempotencyKey: randomUUID(),
      },
    });
    const attempt = await db.runAttempt.create({
      data: {
        runId: other.id,
        number: 1,
        status: "SUCCEEDED",
        inputSnapshot: {},
      },
    });
    await db.runEvidence.create({
      data: {
        teamId: f.team.id,
        runId: other.id,
        attemptId: attempt.id,
        externalId: randomUUID(),
        kind: "SCREENSHOT",
        runtimeArtifactId: artifact.id,
        label: "Shared",
      },
    });
    await deleteTask(serviceDb, f.team.id, f.task.id);
    expect(await db.executionRun.count()).toBe(1);
    expect(await db.runEvidence.count()).toBe(1);
    expect(
      await db.browserRuntimeArtifact.findUnique({
        where: { id: artifact.id },
      }),
    ).not.toBeNull();
    expect(
      await db.browserRuntimeSession.findUnique({ where: { id: session.id } }),
    ).not.toBeNull();
    expect(await db.objectStorageDeletionTask.count()).toBe(0);
  });
  it("also removes a legacy case-linked run whose parent FK was not populated", async () => {
    const f = await fixture();
    await db.executionRun.update({
      where: { id: f.run.id },
      data: { taskExecutionId: null },
    });
    await deleteTask(serviceDb, f.team.id, f.task.id);
    expect(await db.executionRun.count()).toBe(0);
  });
  it("retains closed browser records while resources remain reserved", async () => {
    const f = await fixture();
    const { session } = await withEvidence(f);
    await db.browserRuntimeSession.update({
      where: { id: session.id },
      data: { identityPermit: 1 },
    });
    await expect(deleteTask(serviceDb, f.team.id, f.task.id)).rejects.toThrow(
      "浏览器尚未完成关闭",
    );
    expect(await db.runEvidence.count()).toBe(1);
  });
  it("rechecks after a concurrent retry takes the task row lock", async () => {
    const f = await fixture();
    let unlock!: () => void;
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const retry = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM task_executions WHERE id = ${f.task.id}::uuid FOR UPDATE`;
      ready();
      await gate;
      await tx.taskExecution.update({
        where: { id: f.task.id },
        data: { lifecycle: "RUNNING" },
      });
    });
    await locked;
    const deletion = deleteTask(serviceDb, f.team.id, f.task.id);
    unlock();
    await retry;
    await expect(deletion).rejects.toThrow(/任务尚未结束|状态刚刚发生变化/u);
    expect(await db.taskExecution.count()).toBe(1);
  });
});
