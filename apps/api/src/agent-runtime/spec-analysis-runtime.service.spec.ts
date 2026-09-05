import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvForTests } from "../config/env.js";

import { SpecAnalysisRuntimeService } from "./spec-analysis-runtime.service.js";

const teamId = "6f090d88-8987-487f-8338-1a734beab6a6";
const attemptId = "cc61de8d-cf29-4561-b2cd-c67c304668a5";
const taskExecutionId = "9be3dc23-9a52-4a97-b6ca-6df0af16d815";
const leaseToken = "70844616-602c-475b-95f6-393015b82ed1";
const nextAttemptId = "cc61de8d-cf29-4561-b2cd-c67c304668a6";
const now = new Date("2026-09-04T10:00:00.000Z");
const identity = { fencingToken: "4", leaseToken, workerId: "worker-1" };
const claimInput = { protocol: { minor: 3 }, workerId: "worker-2" };

function analysisAttempt(
  options: {
    deadlineAt?: Date;
    leaseExpiresAt?: Date | null;
    maxAttempts?: number;
    number?: number;
    status?: "PENDING" | "RUNNING";
  } = {},
) {
  const number = options.number ?? 1;
  return {
    analysisSources: [],
    fencingToken: 4n,
    id: attemptId,
    inputSnapshot: { issueRef: "ENG-123" },
    leaseExpiresAt:
      options.leaseExpiresAt === undefined
        ? new Date(now.getTime() + 60_000)
        : options.leaseExpiresAt,
    leaseOwner: identity.workerId,
    leaseToken,
    number,
    result: null,
    stageId: "spec-stage",
    startedAt: new Date(now.getTime() - 60_000),
    status: options.status ?? "RUNNING",
    stage: {
      currentAttemptNumber: number,
      id: "spec-stage",
      maxAttempts: options.maxAttempts ?? 3,
      startedAt: new Date(now.getTime() - 60_000),
      status: options.status ?? "RUNNING",
      taskExecution: {
        cancelRequestedAt: null,
        deadlineAt: options.deadlineAt ?? new Date(now.getTime() + 600_000),
        id: taskExecutionId,
        inputSnapshot: issueTaskInput(),
        lifecycle: "RUNNING",
        startedAt: new Date(now.getTime() - 60_000),
        teamId,
        traceId: "trace-id",
      },
      taskExecutionId,
    },
  };
}

function recoveryHarness(attempt = analysisAttempt()) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ now }]),
    taskExecution: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    taskExecutionEvent: { create: vi.fn().mockResolvedValue({}) },
    taskExecutionStage: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    taskStageAttempt: {
      create: vi.fn().mockResolvedValue({ id: nextAttemptId }),
      findFirst: vi.fn().mockResolvedValueOnce(attempt).mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(attempt),
      findUniqueOrThrow: vi.fn().mockResolvedValue(attempt),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(
      async (operation: (transaction: typeof tx) => unknown) => operation(tx),
    ),
  };
  const service = new SpecAnalysisRuntimeService(
    prisma as never,
    {
      candidatesForPool: vi.fn().mockResolvedValue([{ modelId: "test-model" }]),
    } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, tx };
}

function issueTaskInput() {
  return {
    analysisMaxAttempts: 3,
    browserPolicy: {
      availabilityPolicy: "WAIT",
      profile: { mode: "EPHEMERAL" },
      requiredCapabilities: ["browser"],
    },
    deadlineSeconds: 7_200,
    hitlPolicy: {
      enabled: false,
      notificationChannels: [],
      onTimeout: "INCONCLUSIVE",
      timeoutSeconds: 3_600,
    },
    idempotencyKey: "spec-agent-test",
    issueRef: "ENG-123",
    kind: "ISSUE_SPEC",
    retryPolicy: { maxAttempts: 3, retryOn: ["PROVIDER"] },
  };
}

describe("SpecAnalysisRuntimeService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv("SPEC_ANALYSIS_MODE", "AGENT");
    vi.stubEnv("AGENT_RUNTIME_TASK_LEASE_SECONDS", "60");
    resetEnvForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("retires an expired lease and claims a new numbered Attempt with server timing", async () => {
    const expired = analysisAttempt({
      leaseExpiresAt: new Date(now.getTime() - 1),
    });
    const pending = {
      ...analysisAttempt({
        number: 2,
        status: "PENDING",
        leaseExpiresAt: null,
      }),
      id: nextAttemptId,
    };
    const running = {
      ...pending,
      fencingToken: 1n,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      leaseOwner: claimInput.workerId,
      leaseToken: "new-token",
      status: "RUNNING",
    };
    const { service, tx } = recoveryHarness(expired);
    tx.taskStageAttempt.findFirst
      .mockReset()
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(pending);
    tx.taskStageAttempt.findUniqueOrThrow
      .mockReset()
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(running);

    const result = await service.claim(teamId, claimInput);

    expect(result.task).toMatchObject({
      fencingToken: "1",
      leaseDurationMs: 60_000,
      serverTime: now.toISOString(),
      snapshot: { attemptNumber: 2 },
      taskId: nextAttemptId,
    });
    expect(tx.taskStageAttempt.updateMany).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        error: expect.objectContaining({ code: "RUNTIME_LEASE_LOST" }),
        fencingToken: { increment: 1 },
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
        status: "FAILED",
      }),
      where: {
        fencingToken: 4n,
        id: attemptId,
        leaseExpiresAt: { lte: now },
        leaseOwner: identity.workerId,
        leaseToken,
        status: "RUNNING",
      },
    });
    expect(tx.taskStageAttempt.create).toHaveBeenCalledWith({
      data: {
        inputSnapshot: expired.inputSnapshot,
        number: 2,
        stageId: "spec-stage",
      },
    });
    expect(tx.taskStageAttempt.updateMany).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ status: "RUNNING" }),
      where: { id: nextAttemptId, status: "PENDING" },
    });
    expect(tx.taskExecutionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "task.stage.lease_lost",
        payload: expect.objectContaining({
          attemptNumber: 1,
          nextAttemptScheduled: true,
        }),
      }),
    });
  });

  it("exhausts the configured Attempt budget and requests parent completion through projection", async () => {
    const { service, tx } = recoveryHarness(
      analysisAttempt({
        leaseExpiresAt: new Date(now.getTime() - 1),
        number: 3,
        maxAttempts: 3,
      }),
    );

    expect(await service.claim(teamId, claimInput)).toEqual({ task: null });

    expect(tx.taskStageAttempt.create).not.toHaveBeenCalled();
    expect(tx.taskExecutionStage.update).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "FAILED" }),
      where: { id: "spec-stage" },
    });
    expect(tx.taskExecution.update).toHaveBeenCalledWith({
      data: { projectionNeededAt: now },
      where: { id: taskExecutionId },
    });
    expect(tx.taskExecutionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "task.stage.lease_lost",
        payload: expect.objectContaining({
          attemptNumber: 3,
          maxAttempts: 3,
          nextAttemptScheduled: false,
        }),
      }),
    });
  });

  it.each(["PENDING", "RUNNING"] as const)(
    "times out an expired parent without retrying its %s Attempt",
    async (status) => {
      const { service, tx } = recoveryHarness(
        analysisAttempt({
          deadlineAt: now,
          leaseExpiresAt: new Date(now.getTime() - 1),
          status,
        }),
      );

      expect(await service.claim(teamId, claimInput)).toEqual({ task: null });

      expect(tx.taskStageAttempt.create).not.toHaveBeenCalled();
      expect(tx.taskStageAttempt.updateMany).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fencingToken: { increment: 1 },
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          status: "TIMED_OUT",
        }),
        where: expect.objectContaining({ id: attemptId }),
      });
      expect(tx.taskExecutionEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: "task.stage.timed_out" }),
      });
    },
  );

  it("does not retire an Attempt renewed while a recovery claimant was waiting", async () => {
    const { service, tx } = recoveryHarness(
      analysisAttempt({ leaseExpiresAt: new Date(now.getTime() - 1) }),
    );
    tx.taskStageAttempt.findUniqueOrThrow.mockResolvedValue(analysisAttempt());

    expect(await service.claim(teamId, claimInput)).toEqual({ task: null });

    expect(tx.taskStageAttempt.updateMany).not.toHaveBeenCalled();
    expect(tx.taskStageAttempt.create).not.toHaveBeenCalled();
  });

  it("does not revive a parent cancelled after the claim candidate was read", async () => {
    const { service, tx } = recoveryHarness(
      analysisAttempt({ leaseExpiresAt: new Date(now.getTime() - 1) }),
    );
    tx.taskExecution.updateMany.mockResolvedValue({ count: 0 });

    expect(await service.claim(teamId, claimInput)).toEqual({ task: null });

    expect(tx.taskStageAttempt.updateMany).not.toHaveBeenCalled();
    expect(tx.taskStageAttempt.create).not.toHaveBeenCalled();
    expect(tx.taskExecution.update).not.toHaveBeenCalled();
  });

  it("does not schedule recovery when another lease transition already won", async () => {
    const { service, tx } = recoveryHarness(
      analysisAttempt({ leaseExpiresAt: new Date(now.getTime() - 1) }),
    );
    tx.taskStageAttempt.updateMany.mockResolvedValue({ count: 0 });

    expect(await service.claim(teamId, claimInput)).toEqual({ task: null });

    expect(tx.taskStageAttempt.create).not.toHaveBeenCalled();
    expect(tx.taskExecutionEvent.create).not.toHaveBeenCalled();
  });

  it("renews only a still-owned live lease and returns database-clock lease duration", async () => {
    const { service, tx } = recoveryHarness();

    expect(await service.heartbeat(teamId, attemptId, identity)).toMatchObject({
      directive: "CONTINUE",
      leaseDurationMs: 60_000,
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      serverTime: now.toISOString(),
    });
    expect(tx.taskStageAttempt.updateMany).toHaveBeenCalledWith({
      data: { leaseExpiresAt: new Date(now.getTime() + 60_000) },
      where: expect.objectContaining({
        fencingToken: 4n,
        id: attemptId,
        leaseExpiresAt: { gt: now },
        leaseOwner: identity.workerId,
        leaseToken,
        status: "RUNNING",
      }),
    });
  });

  it("rejects renewal when recovery changed ownership after the lease read", async () => {
    const { service, tx } = recoveryHarness();
    tx.taskStageAttempt.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.heartbeat(teamId, attemptId, identity),
    ).rejects.toThrow(/lease is stale/u);
  });

  it("rejects a lease already expired at database time without writing", async () => {
    const { service, tx } = recoveryHarness(
      analysisAttempt({ leaseExpiresAt: now }),
    );

    await expect(
      service.heartbeat(teamId, attemptId, identity),
    ).rejects.toThrow(/lease is stale/u);

    expect(tx.taskStageAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("checks lease expiry after waiting for the Attempt row lock", async () => {
    const { service, tx } = recoveryHarness();
    let releaseLock!: (rows: Array<{ id: string }>) => void;
    const rowLock = new Promise<Array<{ id: string }>>((resolve) => {
      releaseLock = resolve;
    });
    tx.$queryRaw
      .mockReset()
      .mockReturnValueOnce(rowLock)
      .mockResolvedValueOnce([{ now: new Date(now.getTime() + 60_001) }]);

    const heartbeat = service.heartbeat(teamId, attemptId, identity);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.taskStageAttempt.findUniqueOrThrow).not.toHaveBeenCalled();
    releaseLock([{ id: attemptId }]);

    await expect(heartbeat).rejects.toThrow(/lease is stale/u);
    expect(tx.taskStageAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a late trace event if recovery wins after the ownership read", async () => {
    const { service, tx } = recoveryHarness();
    tx.taskStageAttempt.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.appendEvent(teamId, attemptId, {
        ...identity,
        event: {
          eventId: "late-event",
          kind: "agent.segment.completed",
          occurredAt: now.toISOString(),
          payload: {
            attemptNumber: 1,
            durationMs: 30_000,
            segmentId: "segment-1",
            status: "FAILED",
          },
        },
      }),
    ).rejects.toThrow(/lease is stale/u);

    expect(tx.taskStageAttempt.updateMany).toHaveBeenCalledWith({
      data: { updatedAt: now },
      where: expect.objectContaining({
        fencingToken: 4n,
        leaseExpiresAt: { gt: now },
      }),
    });
    expect(tx.taskExecutionEvent.create).not.toHaveBeenCalled();
  });

  it("counts a cooperative runtime-loss outcome against the same Attempt budget", async () => {
    const { service, tx } = recoveryHarness();
    const result = await service.submitOutcome(teamId, attemptId, {
      ...identity,
      completedAt: now.toISOString(),
      completionId: "49b87f4b-f9c6-4d2f-9bc8-dccbe7672140",
      outcome: {
        error: {
          code: "RUNTIME_LEASE_LOST",
          details: {},
          failureClass: "RUNTIME_LOST",
          message: "Heartbeat safety deadline reached.",
          phase: "spec_analysis",
        },
        executionDisposition: "RUNTIME_LOST",
        kind: "RETRYABLE_FAILURE",
        summary: "Runtime relinquished the lease before expiry.",
      },
    });

    expect(result).toMatchObject({
      nextAttemptScheduled: true,
      stageStatus: "PENDING",
    });
    expect(tx.taskStageAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ number: 2 }),
    });
    expect(tx.taskStageAttempt.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "FAILED", leaseToken: null }),
      where: expect.objectContaining({
        fencingToken: 4n,
        leaseExpiresAt: { gt: now },
      }),
    });
  });

  it("serves page 16 with the pinned revision and accurate completeness", async () => {
    const pullRequestUrl = "https://github.com/acme/web/pull/42";
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      taskStageAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          ...analysisAttempt(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      },
      taskAnalysisSource: {
        findFirst: vi.fn().mockResolvedValue({ revision: "head-a" }),
        findFirstOrThrow: vi.fn().mockResolvedValue({
          content: {
            issue: {
              id: "issue-1",
              identifier: "ENG-123",
              title: "Test",
              description: "Test",
              url: "https://linear.app/acme/issue/ENG-123",
            },
            pullRequestUrls: [pullRequestUrl],
          },
        }),
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 301 },
          _sum: { byteSize: 10000 },
        }),
        create: vi.fn(),
      },
    };
    Object.assign(prisma, {
      $transaction: async (operation: (tx: unknown) => unknown) =>
        operation(prisma),
    });
    const github = {
      changedFiles: vi.fn().mockResolvedValue({
        files: [{ path: "file-301", patch: "change", patchTruncated: false }],
        revision: "head-a",
        total: 301,
        truncated: false,
      }),
    };
    const service = new SpecAnalysisRuntimeService(
      prisma as never,
      {} as never,
      {} as never,
      github as never,
      {} as never,
    );
    const result = await service.executeTool(teamId, attemptId, {
      ...identity,
      callId: "page-16",
      name: "github_list_changed_files",
      arguments: {
        analysisSummary: "Read final page",
        pullRequestUrl,
        page: 16,
      },
    });
    expect(github.changedFiles).toHaveBeenCalledWith(
      teamId,
      pullRequestUrl,
      "head-a",
      { page: 16, perPage: 20 },
    );
    expect(result.result).toMatchObject({
      hasMore: false,
      page: 16,
      total: 301,
      truncated: false,
      files: [{ path: "file-301" }],
    });
    expect(result.sourceRefs).toHaveLength(1);
  });

  it("executes Linear through the control plane and persists an immutable source", async () => {
    const sourceCreate = vi.fn().mockResolvedValue({ id: "source-1" });
    const prisma = {
      taskAnalysisSource: {
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 0 },
          _sum: { byteSize: null },
        }),
        create: sourceCreate,
      },
      taskStageAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          fencingToken: 4n,
          id: attemptId,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseOwner: "worker-1",
          leaseToken,
          stage: {
            taskExecution: {
              id: taskExecutionId,
              inputSnapshot: issueTaskInput(),
              teamId,
            },
          },
          status: "RUNNING",
        }),
      },
    };
    Object.assign(prisma, {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: async (operation: (tx: unknown) => unknown) =>
        operation(prisma),
    });
    const linearResult = {
      issue: {
        assignee: null,
        description: "Users must be able to request a refund.",
        id: "linear-issue-1",
        identifier: "ENG-123",
        labels: ["payments"],
        priority: 2,
        state: "In Review",
        title: "Refund flow",
        url: "https://linear.app/acme/issue/ENG-123/refund-flow",
      },
      pullRequestUrls: ["https://github.com/acme/web/pull/42"],
    };
    const service = new SpecAnalysisRuntimeService(
      prisma as never,
      {} as never,
      { getIssue: vi.fn().mockResolvedValue(linearResult) } as never,
      {} as never,
      {} as never,
    );

    const output = await service.executeTool(teamId, attemptId, {
      arguments: { analysisSummary: "Read the authoritative Issue." },
      callId: "call-1",
      fencingToken: "4",
      leaseToken,
      name: "linear_get_issue",
      workerId: "worker-1",
    });

    expect(output.sourceRefs).toHaveLength(1);
    expect(output.sourceRefs[0]).toMatchObject({
      kind: "LINEAR_ISSUE",
      label: "ENG-123 · Refund flow",
    });
    expect(sourceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: linearResult,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        kind: "LINEAR_ISSUE",
        stageAttemptId: attemptId,
        taskExecutionId,
        teamId,
      }),
    });
  });
});
