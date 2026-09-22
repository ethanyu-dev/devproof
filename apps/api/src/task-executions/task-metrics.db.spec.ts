import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { projectRuntimeTiming } from "./task-metrics.js";
import { TaskMetricsService } from "./task-metrics.service.js";
const url = process.env.DEVPROOF_METRICS_TEST_DATABASE_URL;
if (url && !/^\/devproof_metrics_test_[a-f0-9]{8}$/.test(new URL(url).pathname))
  throw new Error("Metrics tests require a disposable database.");
describe.skipIf(!url)("task metrics persistence", () => {
  let db: PrismaClient, service: TaskMetricsService;
  beforeAll(() => {
    db = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url!,
        // Same UTC session as PrismaService. Otherwise trigger timestamptz
        // values are read several hours away from task.createdAt.
        options: "-c TimeZone=UTC",
      }),
    });
    service = new TaskMetricsService(db as never);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  it("records durable waits, settles usage after lease expiry once, isolates teams, and freezes elapsed time", async () => {
    const team = await db.team.create({
      data: {
        slug: randomUUID(),
        feishuTenantKey: randomUUID(),
        name: "Metrics test",
      },
    });
    const task = await db.taskExecution.create({
      data: {
        teamId: team.id,
        idempotencyKey: randomUUID(),
        kind: "ISSUE_SPEC",
        title: "Metrics fixture",
        inputSnapshot: {},
        sourceKind: "API",
        traceId: "a".repeat(32),
        deadlineAt: new Date(Date.now() + 60000),
      },
    });
    const stage = await db.taskExecutionStage.create({
      data: {
        taskExecutionId: task.id,
        type: "SPEC_ANALYSIS",
        status: "RUNNING",
      },
    });
    const leaseToken = randomUUID(),
      workerId = "metrics-test-worker";
    const attempt = await db.taskStageAttempt.create({
      data: {
        stageId: stage.id,
        number: 1,
        status: "RUNNING",
        inputSnapshot: {},
        leaseToken,
        leaseOwner: workerId,
        leaseExpiresAt: new Date(Date.now() + 60000),
      },
    });
    await db.taskExecution.update({
      where: { id: task.id },
      data: { lifecycle: "RUNNING", startedAt: new Date() },
    });
    const id = randomUUID(),
      config = randomUUID();
    await service.register(team.id, {
      modelCallId: id,
      ownerKind: "SPEC_ANALYSIS",
      ownerId: attempt.id,
      workerId,
      leaseToken,
      requestedModel: "model-alias",
      configurationId: config,
      configurationName: "gateway",
    });
    const startedAt = new Date().toISOString();
    await db.taskStageAttempt.update({
      where: { id: attempt.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const input = {
      workerId,
      leaseToken,
      telemetry: {
        modelCallId: id,
        requestedModel: "model-alias",
        configurationId: config,
        responseModel: "actual-model",
        startedAt,
        durationMs: 10,
        outcome: "SUCCEEDED" as const,
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 600 },
        },
      },
    };
    await Promise.all([
      service.settle(team.id, input),
      service.settle(team.id, input),
    ]);
    await expect(service.settle(randomUUID(), input)).rejects.toThrow(
      "not found",
    );
    await expect(
      service.settle(team.id, {
        ...input,
        telemetry: { ...input.telemetry, durationMs: 20 },
      }),
    ).rejects.toThrow("Conflicting");
    await db.taskExecution.update({
      where: { id: task.id },
      data: { lifecycle: "WAITING_INPUT" },
    });
    await db.taskExecution.update({
      where: { id: task.id },
      data: { lifecycle: "RUNNING" },
    });
    const finishedAt = new Date();
    await db.taskExecution.update({
      where: { id: task.id },
      data: { lifecycle: "COMPLETED", finishedAt },
    });
    // Backfill sees the executor event too; it must not duplicate or replace client usage.
    await db.taskExecutionEvent.create({
      data: {
        teamId: team.id,
        taskExecutionId: task.id,
        actor: "AGENT_RUNTIME",
        kind: "agent.model.completed",
        payload: {
          stageAttemptId: attempt.id,
          attemptNumber: 1,
          modelCallId: id,
          model: "model-alias",
          durationMs: 9999,
          usage: { prompt_tokens: 1000, completion_tokens: 100 },
        },
      },
    });
    const result = await service.summary(team.id, task.id);
    expect(result.version).toBe(2);
    expect(result.totals.total.known).toBe("1100");
    expect(
      (result.runtimes ?? []).reduce((sum, item) => sum + item.occupiedMs, 0) +
        (result.unassigned?.occupiedMs ?? 0) +
        (result.overlap?.occupiedMs ?? 0),
    ).toBe(result.elapsedMs);
    expect(
      await db.taskExecutionSpan.findFirst({
        where: { id: `model:${id}` },
        select: { runtime: true },
      }),
    ).toMatchObject({ runtime: "SPEC_ANALYSIS" });
    expect(
      await db.taskExecutionSpan.findFirst({
        where: {
          taskExecutionId: task.id,
          id: { startsWith: "state:task_executions:" },
        },
        select: { runtime: true },
      }),
    ).toMatchObject({ runtime: null });
    expect(result.models[0]?.model).toBe("actual-model");
    expect(result.buckets.reduce((s, b) => s + b.durationMs, 0)).toBe(
      result.elapsedMs,
    );
    expect(
      await db.taskExecutionSpan.count({
        where: {
          taskExecutionId: task.id,
          activity: "HUMAN",
          finishedAt: { not: null },
        },
      }),
    ).toBe(1);
    expect(
      await db.taskModelCallUsage.count({
        where: { taskExecutionId: task.id },
      }),
    ).toBe(1);
    const later = await service.rebuild(team.id, task.id);
    expect(later.elapsedMs).toBe(result.elapsedMs);
    expect(later.totals.total.known).toBe("1100");
    expect(later.models[0]?.requestDurationMs).toBe(10);
    const review = await db.taskAcceptanceReview.create({
      data: {
        taskExecutionId: task.id,
        revision: "test",
        status: "RUNNING",
        attempts: 1,
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60000),
      },
    });
    const reviewCall = randomUUID();
    await service.register(team.id, {
      modelCallId: reviewCall,
      ownerKind: "ACCEPTANCE_REVIEW",
      ownerId: review.id,
      workerId,
      leaseToken,
      requestedModel: "review",
      configurationName: "review",
    });
    await service.settle(team.id, {
      workerId,
      leaseToken,
      telemetry: {
        modelCallId: reviewCall,
        requestedModel: "review",
        startedAt: new Date().toISOString(),
        durationMs: 50,
        outcome: "FAILED",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    });
    const reviewed = await service.summary(team.id, task.id);
    expect(reviewed.totals.total.known).toBe("1115");
    expect(reviewed.elapsedMs).toBe(result.elapsedMs);
    expect(reviewed.reviewDurationMs).toBe(50);
    expect(reviewed.version).toBe(2);
    expect(
      reviewed.runtimes?.reduce((sum, item) => sum + item.occupiedMs, 0),
    ).toBe(result.runtimes?.reduce((sum, item) => sum + item.occupiedMs, 0));
    await expect(service.calls(randomUUID(), task.id)).rejects.toThrow(
      "not found",
    );
    await db.taskExecution.delete({ where: { id: task.id } });
    expect(
      await db.taskModelCallUsage.count({
        where: { taskExecutionId: task.id },
      }),
    ).toBe(0);
    expect(
      await db.taskExecutionSpan.count({ where: { taskExecutionId: task.id } }),
    ).toBe(0);
  });

  it("inserts in-run recovery queues and skips a failed revision", async () => {
    const team = await db.team.create({
      data: {
        slug: randomUUID(),
        feishuTenantKey: randomUUID(),
        name: "Metrics recovery",
      },
    });
    const task = await db.taskExecution.create({
      data: {
        teamId: team.id,
        idempotencyKey: randomUUID(),
        kind: "ISSUE_SPEC",
        title: "Recovery fixture",
        inputSnapshot: {},
        sourceKind: "API",
        traceId: "b".repeat(32),
        deadlineAt: new Date(Date.now() + 60000),
        lifecycle: "RUNNING",
        currentStage: "SPEC_EXECUTION",
      },
    });
    const stage = await db.taskExecutionStage.create({
      data: {
        taskExecutionId: task.id,
        type: "SPEC_ANALYSIS",
        status: "SUCCEEDED",
      },
    });
    const attempt = await db.taskStageAttempt.create({
      data: {
        stageId: stage.id,
        number: 1,
        status: "SUCCEEDED",
        executor: "AGENT_RUNTIME",
        inputSnapshot: {},
        finishedAt: new Date(0),
      },
    });
    const snapshot = await db.taskSpecificationSnapshot.create({
      data: {
        taskExecutionId: task.id,
        stageAttemptId: attempt.id,
        sourceHash: "c".repeat(64),
        generatorKind: "AGENT",
        generatorVersion: "1",
        context: {},
        completeness: "COMPLETE",
        summary: "Recovery",
        cases: {
          create: {
            position: 0,
            name: "Case",
            definition: {},
            definitionHash: "d".repeat(64),
          },
        },
      },
      include: { cases: true },
    });
    const deployment = await db.taskDeployment.create({
      data: {
        taskExecutionId: task.id,
        key: "preview",
        name: "preview",
        targetUrl: "https://preview.example.com",
      },
    });
    const deadline = new Date(Date.now() + 60000);
    const run = await db.executionRun.create({
      data: {
        teamId: team.id,
        taskExecutionId: task.id,
        idempotencyKey: randomUUID(),
        goal: "Case",
        lifecycle: "RUNNING",
        criteriaSnapshot: [],
        initialDeadlineAt: deadline,
        deadlineAt: deadline,
        hardDeadlineAt: deadline,
        traceId: "e".repeat(32),
      },
    });
    const linked = await db.taskCaseExecution.create({
      data: {
        taskExecutionId: task.id,
        caseId: snapshot.cases[0]!.id,
        deploymentId: deployment.id,
        runId: run.id,
        dispatchStatus: "LINKED",
        scheduling: { state: "RUNNING" },
      },
    });
    expect(
      await db.taskExecutionSpan.count({
        where: {
          taskExecutionId: task.id,
          id: { startsWith: `state:task_case_executions:${linked.id}:` },
        },
      }),
    ).toBe(0);
    await db.taskCaseExecution.update({
      where: { id: linked.id },
      data: { scheduling: { state: "RECOVERING", reason: "LEASE_RECOVERY" } },
    });
    const recovering = await db.taskExecutionSpan.findFirstOrThrow({
      where: {
        taskExecutionId: task.id,
        id: { startsWith: `state:task_case_executions:${linked.id}:` },
        finishedAt: null,
      },
    });
    expect(recovering).toMatchObject({
      activity: "QUEUE",
      label: "LEASE_RECOVERY",
      runtime: "BROWSER",
      lane: run.id,
    });
    const created = await db.taskExecution.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(
      Math.abs(recovering.startedAt.getTime() - created.createdAt.getTime()),
    ).toBeLessThan(60_000);
    const during = projectRuntimeTiming({
      taskId: task.id,
      start: created.createdAt.getTime(),
      end: recovering.startedAt.getTime() + 5_000,
      analysisStageStatus: "SUCCEEDED",
      attempts: [
        {
          id: attempt.id,
          stageType: "SPEC_ANALYSIS",
          executor: "AGENT_RUNTIME",
          createdAt: attempt.createdAt.getTime(),
          finishedAt: attempt.finishedAt?.getTime() ?? null,
        },
      ],
      runs: [
        {
          id: run.id,
          createdAt: run.createdAt.getTime(),
          finishedAt: null,
        },
      ],
      spans: (
        await db.taskExecutionSpan.findMany({
          where: { taskExecutionId: task.id },
        })
      ).map((span) => ({
        id: span.id,
        lane: span.lane,
        label: span.label,
        activity: span.activity,
        scope: span.scope,
        startedAt: span.startedAt.getTime(),
        finishedAt: span.finishedAt?.getTime() ?? null,
      })),
      usages: [],
    });
    expect(
      during.segments.some(
        (segment) =>
          segment.activity === "QUEUE" &&
          segment.runtime === "BROWSER" &&
          segment.start <= recovering.startedAt.getTime() &&
          segment.end > recovering.startedAt.getTime(),
      ),
    ).toBe(true);
    await db.taskCaseExecution.update({
      where: { id: linked.id },
      data: { scheduling: { state: "RUNNING", reason: "DATA_LOCK" } },
    });
    const locked = await db.taskExecutionSpan.findFirstOrThrow({
      where: {
        taskExecutionId: task.id,
        label: "DATA_LOCK",
        finishedAt: null,
      },
    });
    expect(locked).toMatchObject({ activity: "QUEUE", runtime: "BROWSER" });
    await db.taskCaseExecution.update({
      where: { id: linked.id },
      data: { scheduling: { state: "RUNNING", reason: null } },
    });
    expect(
      await db.taskExecutionSpan.count({
        where: {
          id: { startsWith: `state:task_case_executions:${linked.id}:` },
          finishedAt: null,
        },
      }),
    ).toBe(0);
    const waiting = await db.taskCaseExecution.create({
      data: {
        taskExecutionId: task.id,
        caseId: snapshot.cases[0]!.id,
        deploymentId: deployment.id,
        executionOrdinal: 2,
        scheduling: { state: "WAITING", reason: "AUTH_REQUIRED" },
      },
    });
    expect(
      await db.taskExecutionSpan.findFirst({
        where: {
          id: { startsWith: `state:task_case_executions:${waiting.id}:` },
          finishedAt: null,
        },
      }),
    ).toMatchObject({
      activity: "QUEUE",
      label: "AUTH_REQUIRED",
      runtime: "BROWSER",
    });
    await db.taskCaseExecution.update({
      where: { id: waiting.id },
      data: { scheduling: { state: "WAITING", reason: "PROFILE_RESERVED" } },
    });
    expect(
      await db.taskExecutionSpan.findFirst({
        where: {
          id: { startsWith: `state:task_case_executions:${waiting.id}:` },
          label: "PROFILE_RESERVED",
        },
      }),
    ).toMatchObject({ activity: "QUEUE", runtime: "BROWSER" });
    await db.taskCaseExecution.update({
      where: { id: waiting.id },
      data: { scheduling: { state: "TERMINAL", reason: null } },
    });
    await db.taskCaseExecution.update({
      where: { id: linked.id },
      data: { scheduling: { state: "RECOVERING", reason: "LEASE_RECOVERY" } },
    });
    const openRecovery = await db.taskExecutionSpan.findFirstOrThrow({
      where: {
        taskExecutionId: task.id,
        id: { startsWith: `state:task_case_executions:${linked.id}:` },
        finishedAt: null,
      },
    });
    const runFinished = new Date(openRecovery.startedAt.getTime() + 60_000);
    await db.executionRun.update({
      where: { id: run.id },
      data: { lifecycle: "COMPLETED", finishedAt: runFinished },
    });
    await db.taskCaseExecution.update({
      where: { id: linked.id },
      data: { scheduling: { state: "TERMINAL", reason: "LEASE_RECOVERY" } },
    });
    expect(
      await db.taskExecutionSpan.count({
        where: {
          id: { startsWith: `state:task_case_executions:${linked.id}:` },
          finishedAt: null,
        },
      }),
    ).toBe(0);
    const closedRecovery = await db.taskExecutionSpan.findFirstOrThrow({
      where: {
        taskExecutionId: task.id,
        id: { startsWith: `state:task_case_executions:${linked.id}:` },
        label: "LEASE_RECOVERY",
      },
      orderBy: { startedAt: "desc" },
    });
    expect(closedRecovery.finishedAt).not.toBeNull();
    const taskFinished = new Date(runFinished.getTime() + 30_000);
    await db.taskExecution.update({
      where: { id: task.id },
      data: { lifecycle: "COMPLETED", finishedAt: taskFinished },
    });
    const after = projectRuntimeTiming({
      taskId: task.id,
      start: created.createdAt.getTime(),
      end: taskFinished.getTime(),
      analysisStageStatus: "SUCCEEDED",
      attempts: [
        {
          id: attempt.id,
          stageType: "SPEC_ANALYSIS",
          executor: "AGENT_RUNTIME",
          createdAt: attempt.createdAt.getTime(),
          finishedAt: attempt.finishedAt?.getTime() ?? null,
        },
      ],
      runs: [
        {
          id: run.id,
          createdAt: run.createdAt.getTime(),
          finishedAt: runFinished.getTime(),
        },
      ],
      spans: (
        await db.taskExecutionSpan.findMany({
          where: { taskExecutionId: task.id },
        })
      ).map((span) => ({
        id: span.id,
        lane: span.lane,
        label: span.label,
        activity: span.activity,
        scope: span.scope,
        startedAt: span.startedAt.getTime(),
        finishedAt: span.finishedAt?.getTime() ?? null,
      })),
      usages: [],
    });
    const postRun = after.segments.filter(
      (segment) => segment.start >= runFinished.getTime(),
    );
    expect(postRun.length).toBeGreaterThan(0);
    expect(
      postRun.every(
        (segment) =>
          segment.runtime === "UNASSIGNED" && segment.activity !== "QUEUE",
      ),
    ).toBe(true);
    const projected = await service.rebuild(team.id, task.id);
    expect(projected.version).toBe(2);
    expect(
      projected.runtimes?.find((item) => item.runtime === "BROWSER")?.buckets,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ activity: "QUEUE" })]),
    );
    const stored = await db.taskExecutionMetrics.findUniqueOrThrow({
      where: { taskExecutionId: task.id },
    });
    const stale = new Date(Date.now() - 3_600_000);
    const failedSummary = {
      ...(stored.summary as object),
      version: 1,
      runtimeAttribution: "FAILED",
      runtimeAttributionRevision: stored.revision.toString(),
      computedAt: stale.toISOString(),
    } as Record<string, unknown>;
    delete failedSummary.runtimes;
    delete failedSummary.unassigned;
    delete failedSummary.overlap;
    await db.taskExecutionMetrics.update({
      where: { taskExecutionId: task.id },
      data: { summary: failedSummary, dirty: false, computedAt: stale },
    });
    const failed = await service.summary(team.id, task.id);
    const again = await service.summary(team.id, task.id);
    expect(failed.version).toBe(1);
    expect(failed.runtimes).toBeUndefined();
    expect(failed.computedAt).toBe(stale.toISOString());
    expect(again.computedAt).toBe(stale.toISOString());
    await db.taskExecutionMetrics.update({
      where: { taskExecutionId: task.id },
      data: {
        summary: { ...failedSummary, runtimeAttributionRevision: "0" },
        dirty: false,
        computedAt: stale,
      },
    });
    const upgraded = await service.summary(team.id, task.id);
    expect(upgraded.version).toBe(2);
    expect(upgraded.computedAt).not.toBe(stale.toISOString());
  });
});
