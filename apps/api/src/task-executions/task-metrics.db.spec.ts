import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { TaskMetricsService } from "./task-metrics.service.js";
const url = process.env.DEVPROOF_METRICS_TEST_DATABASE_URL;
if (url && !/^\/devproof_metrics_test_[a-f0-9]{8}$/.test(new URL(url).pathname))
  throw new Error("Metrics tests require a disposable database.");
describe.skipIf(!url)("task metrics persistence", () => {
  let db: PrismaClient, service: TaskMetricsService;
  beforeAll(() => {
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url! }),
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
    expect(result.totals.total.known).toBe("1100");
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
});
