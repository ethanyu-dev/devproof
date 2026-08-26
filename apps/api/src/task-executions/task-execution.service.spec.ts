import { describe, expect, it, vi } from "vitest";

import {
  executionCounts,
  TaskExecutionService,
} from "./task-execution.service.js";

describe("executionCounts", () => {
  it("keeps queued, running and blocked counts mutually meaningful", () => {
    expect(
      executionCounts(
        [
          {
            dispatchStatus: "LINKED",
            run: {
              executionDisposition: null,
              lifecycle: "QUEUED",
              verdict: null,
            },
          },
          {
            dispatchStatus: "LINKED",
            run: {
              executionDisposition: null,
              lifecycle: "RUNNING",
              verdict: null,
            },
          },
          {
            dispatchStatus: "LINKED",
            run: {
              executionDisposition: "AGENT_ERROR",
              lifecycle: "COMPLETED",
              verdict: null,
            },
          },
        ],
        3,
      ),
    ).toEqual({
      blocked: 1,
      failed: 0,
      inconclusive: 0,
      passed: 0,
      running: 1,
      total: 3,
      waiting: 1,
    });
  });
});

describe("TaskExecutionService compatibility entry points", () => {
  it("wraps a legacy create_run request in a DIRECT_RUN task", async () => {
    const runId = "285146a8-5230-4b02-832a-5eef19e8dc8a";
    const taskId = "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0";
    const runs = {
      detail: vi.fn().mockResolvedValue({ id: runId }),
    };
    const service = new TaskExecutionService(
      {
        executionRun: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      {} as never,
      runs as never,
    );
    const createParsed = vi
      .spyOn(
        service as unknown as {
          createParsed: (...arguments_: unknown[]) => Promise<unknown>;
        },
        "createParsed",
      )
      .mockResolvedValue({ id: taskId, runs: [{ runId }] });
    const current = {
      credential: { id: "credential-1", name: "Legacy client", scopes: [] },
      team: { id: "6f090d88-8987-487f-8338-1a734beab6a6", name: "Team" },
    } as never;
    const input = {
      businessReferences: [],
      browserPolicy: {
        availabilityPolicy: "WAIT",
        profile: { mode: "EPHEMERAL" },
        requiredCapabilities: ["browser"],
      },
      criteria: [
        {
          description: "The page is visible.",
          id: "visible",
          required: true,
          requiredEvidenceKinds: [],
        },
      ],
      deadlineSeconds: 600,
      environment: { targetUrl: "https://example.com" },
      goal: "Verify the page.",
      hitlPolicy: {
        enabled: false,
        notificationChannels: [],
        onTimeout: "INCONCLUSIVE",
        timeoutSeconds: 3600,
      },
      idempotencyKey: "legacy-run-request",
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      source: { kind: "API" },
    } as const;

    await expect(
      service.createCompatibilityRun(current, input as never),
    ).resolves.toEqual({ id: runId });
    expect(createParsed).toHaveBeenCalledWith(
      current,
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^compat-run:[a-f0-9]{64}$/u),
        kind: "DIRECT_RUN",
        run: {
          ...input,
          deadlinePolicy: { mode: "FIXED" },
        },
      }),
      true,
    );
    expect(runs.detail).toHaveBeenCalledWith(current, runId);
  });

  it("preserves create_run idempotency for a Run already linked by migration", async () => {
    const runId = "285146a8-5230-4b02-832a-5eef19e8dc8a";
    const input = {
      idempotencyKey: "legacy-run-request",
    };
    const runs = {
      create: vi.fn().mockResolvedValue({ id: runId }),
    };
    const service = new TaskExecutionService(
      {
        executionRun: {
          findUnique: vi.fn().mockResolvedValue({
            id: runId,
            taskExecutionId: runId,
          }),
        },
      } as never,
      {} as never,
      runs as never,
    );
    const create = vi.spyOn(service, "create");
    const current = {
      credential: { id: "credential-1", name: "Legacy client", scopes: [] },
      team: { id: "6f090d88-8987-487f-8338-1a734beab6a6", name: "Team" },
    } as never;

    await expect(
      service.createCompatibilityRun(current, input as never),
    ).resolves.toEqual({ id: runId });
    expect(runs.create).toHaveBeenCalledWith(current, input);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("TaskExecutionService profile ownership", () => {
  const profileId = "285146a8-5230-4b02-832a-5eef19e8dc8a";
  const input = {
    idempotencyKey: "explicit-profile-task",
    issueRef: "ENG-123",
    kind: "ISSUE_SPEC",
    profilePolicy: {
      onUnavailable: "WAIT_FOR_PROFILE",
      profileId,
      scope: { authRole: "default", environmentKey: "default" },
      strategy: "EXPLICIT_PROFILE",
    },
    targetUrl: "https://preview.example.com",
  } as const;
  const current = {
    credential: { id: "credential-1", name: "Client", scopes: [] },
    team: { id: "6f090d88-8987-487f-8338-1a734beab6a6", name: "Team" },
  } as never;

  it("rejects explicit user profiles from machine credentials", async () => {
    const service = new TaskExecutionService(
      {
        taskExecution: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.create(current, input)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects a signed-in user selecting another user's profile", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new TaskExecutionService(
      {
        taskExecution: { findUnique: vi.fn().mockResolvedValue(null) },
        userBrowserProfile: { findFirst },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.create(current, input, {
        kind: "USER",
        triggerSource: "CONSOLE",
        userId: "fa078e55-f887-4f67-b8ef-229b976ee56f",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        id: profileId,
        ownerUserId: "fa078e55-f887-4f67-b8ef-229b976ee56f",
        teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
      },
    });
  });
});

describe("TaskExecutionService Spec Runtime rerun", () => {
  const taskId = "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0";
  const caseId = "285146a8-5230-4b02-832a-5eef19e8dc8a";
  const previousExecutionId = "fa078e55-f887-4f67-b8ef-229b976ee56f";
  const nextExecutionId = "0da63e02-7680-4a93-9721-6af09e6a4f04";
  const current = {
    credential: { id: "credential-1", name: "Console user", scopes: [] },
    team: { id: "6f090d88-8987-487f-8338-1a734beab6a6", name: "Team" },
  } as never;

  it("queues the next execution ordinal while preserving the completed Runtime", async () => {
    const taskExecutionFindFirst = vi.fn().mockResolvedValue({
      cancelRequestedAt: null,
      caseExecutions: [
        {
          caseId,
          executionOrdinal: 1,
          id: previousExecutionId,
          run: { lifecycle: "COMPLETED" },
        },
      ],
      deadlineAt: new Date(Date.now() + 60 * 60 * 1_000),
      id: taskId,
      kind: "ISSUE_SPEC",
      stages: [{ id: "execution-stage-1", type: "SPEC_EXECUTION" }],
    });
    const taskCaseExecutionCreate = vi.fn().mockResolvedValue({
      executionOrdinal: 2,
      id: nextExecutionId,
    });
    const taskExecutionStageUpdate = vi.fn().mockResolvedValue({});
    const taskExecutionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const taskExecutionEventCreate = vi.fn().mockResolvedValue({});
    const tx = {
      taskCaseExecution: { create: taskCaseExecutionCreate },
      taskExecution: {
        findFirst: taskExecutionFindFirst,
        updateMany: taskExecutionUpdateMany,
      },
      taskExecutionEvent: { create: taskExecutionEventCreate },
      taskExecutionStage: { update: taskExecutionStageUpdate },
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const service = new TaskExecutionService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const dispatch = vi
      .spyOn(
        service as unknown as {
          dispatchPendingForTask: (id: string) => Promise<void>;
        },
        "dispatchPendingForTask",
      )
      .mockResolvedValue(undefined);
    vi.spyOn(service, "detail").mockResolvedValue({ id: taskId } as never);

    await expect(service.rerunCase(current, taskId, caseId)).resolves.toEqual({
      id: taskId,
    });

    expect(taskCaseExecutionCreate).toHaveBeenCalledWith({
      data: {
        caseId,
        executionOrdinal: 2,
        taskExecutionId: taskId,
      },
      select: { executionOrdinal: true, id: true },
    });
    expect(taskExecutionStageUpdate).toHaveBeenCalledWith({
      data: {
        finishedAt: null,
        lastError: expect.anything(),
        status: "RUNNING",
        waitingReason: null,
      },
      where: { id: "execution-stage-1" },
    });
    expect(taskExecutionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentStage: "SPEC_EXECUTION",
          lifecycle: "RUNNING",
          verdict: null,
        }),
      }),
    );
    expect(taskExecutionEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "task.case.rerun_queued",
        payload: expect.objectContaining({
          caseExecutionId: nextExecutionId,
          caseId,
          executionOrdinal: 2,
          previousCaseExecutionId: previousExecutionId,
        }),
        taskExecutionId: taskId,
      }),
    });
    expect(dispatch).toHaveBeenCalledWith(taskId);
  });

  it("rejects a rerun while the latest Runtime is still active", async () => {
    const tx = {
      taskExecution: {
        findFirst: vi.fn().mockResolvedValue({
          cancelRequestedAt: null,
          caseExecutions: [
            {
              caseId,
              executionOrdinal: 1,
              id: previousExecutionId,
              run: { lifecycle: "RUNNING" },
            },
          ],
          deadlineAt: new Date(Date.now() + 60 * 60 * 1_000),
          id: taskId,
          kind: "ISSUE_SPEC",
          stages: [{ id: "execution-stage-1", type: "SPEC_EXECUTION" }],
        }),
      },
    };
    const service = new TaskExecutionService(
      {
        $transaction: vi.fn(
          async (operation: (client: typeof tx) => Promise<unknown>) =>
            operation(tx),
        ),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.rerunCase(current, taskId, caseId),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("TaskExecutionService rerun", () => {
  it("creates a fresh Issue task from the original immutable input", async () => {
    const sourceTaskId = "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0";
    const rerunTaskId = "285146a8-5230-4b02-832a-5eef19e8dc8a";
    const inputSnapshot = {
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
      idempotencyKey: "original-issue-task",
      issueRef: "ENG-123",
      kind: "ISSUE_SPEC",
      retryPolicy: { maxAttempts: 3, retryOn: ["PROVIDER"] },
      targetUrl: "https://preview.example.com",
    };
    const prisma = {
      taskExecution: {
        findFirst: vi.fn().mockResolvedValue({
          id: sourceTaskId,
          inputSnapshot,
          kind: "ISSUE_SPEC",
          notificationContext: {
            feishu: { replyToMessageId: "message-1" },
          },
        }),
      },
      taskExecutionEvent: {
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const service = new TaskExecutionService(
      prisma as never,
      {} as never,
      {} as never,
    );
    const createParsed = vi
      .spyOn(
        service as unknown as {
          createParsed: (...arguments_: unknown[]) => Promise<unknown>;
        },
        "createParsed",
      )
      .mockResolvedValue({ id: rerunTaskId });
    vi.spyOn(service, "detail").mockResolvedValue({ id: rerunTaskId } as never);
    const current = {
      credential: { id: "credential-1", name: "Console user", scopes: [] },
      team: { id: "6f090d88-8987-487f-8338-1a734beab6a6", name: "Team" },
    } as never;

    const actor = {
      kind: "USER" as const,
      triggerSource: "CONSOLE" as const,
      userId: "fa078e55-f887-4f67-b8ef-229b976ee56f",
    };
    await expect(service.rerun(current, sourceTaskId, actor)).resolves.toEqual({
      id: rerunTaskId,
    });
    expect(createParsed).toHaveBeenCalledWith(
      current,
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          new RegExp(`^rerun:${sourceTaskId}:[0-9a-f-]{36}$`, "u"),
        ),
        issueRef: "ENG-123",
        kind: "ISSUE_SPEC",
        targetUrl: "https://preview.example.com",
      }),
      false,
      {
        ...actor,
        notificationContext: {
          feishu: { replyToMessageId: "message-1" },
        },
      },
    );
    expect(prisma.taskExecutionEvent.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          kind: "task.rerun.created",
          taskExecutionId: sourceTaskId,
        }),
        expect.objectContaining({
          kind: "task.rerun.linked",
          taskExecutionId: rerunTaskId,
        }),
      ]),
    });
  });

  it("returns stable console pagination metadata", async () => {
    const row = {
      caseExecutions: [],
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
      currentStage: "SPEC_ANALYSIS",
      executionDisposition: null,
      executionRuns: [],
      id: "task-11",
      kind: "ISSUE_SPEC",
      lifecycle: "QUEUED",
      sourceKind: "LINEAR_ISSUE",
      sourceRef: "ENG-11",
      specificationSnapshots: [],
      title: "ENG-11",
      updatedAt: new Date("2026-08-20T00:00:01.000Z"),
      verdict: null,
      waitingReason: null,
    };
    const findMany = vi.fn().mockReturnValue("rows-query");
    const count = vi.fn().mockReturnValue("count-query");
    const transaction = vi.fn().mockResolvedValue([[row], 21]);
    const service = new TaskExecutionService(
      {
        $transaction: transaction,
        taskExecution: { count, findMany },
      } as never,
      {} as never,
      {} as never,
    );
    const current = {
      credential: { id: "credential-1", name: "Console user", scopes: [] },
      team: { id: "team-1", name: "Team" },
    } as never;

    await expect(service.listPage(current, 2, 10)).resolves.toMatchObject({
      items: [{ id: "task-11", title: "ENG-11" }],
      page: 2,
      pageSize: 10,
      total: 21,
      totalPages: 3,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
    expect(transaction).toHaveBeenCalledWith(["rows-query", "count-query"]);
  });

  it("applies task search, type, status and time filters to list queries", async () => {
    const findMany = vi.fn().mockReturnValue("rows-query");
    const count = vi.fn().mockReturnValue("count-query");
    const transaction = vi.fn().mockResolvedValue([[], 0]);
    const service = new TaskExecutionService(
      {
        $transaction: transaction,
        taskExecution: { count, findMany },
      } as never,
      {} as never,
      {} as never,
    );
    const current = {
      credential: { id: "credential-1", name: "Console user", scopes: [] },
      team: { id: "team-1", name: "Team" },
    } as never;
    const createdAfter = new Date("2026-08-21T00:00:00.000Z");
    const where = {
      OR: [
        { title: { contains: "ENG-42", mode: "insensitive" } },
        { sourceRef: { contains: "ENG-42", mode: "insensitive" } },
        { sourceKind: { contains: "ENG-42", mode: "insensitive" } },
      ],
      createdAt: { gte: createdAfter },
      kind: "LEGACY_RUN",
      lifecycle: { in: ["QUEUED", "RUNNING", "WAITING_INPUT"] },
      teamId: "team-1",
    };

    await service.listPage(current, 1, 10, {
      createdAfter,
      kind: "LEGACY_RUN",
      query: "ENG-42",
      status: "ACTIVE",
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 10, where }),
    );
    expect(count).toHaveBeenCalledWith({ where });
  });
});

describe("TaskExecutionService log export", () => {
  it("exports analysis attempts and every Runtime event without a page limit", async () => {
    const taskId = "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0";
    const runId = "285146a8-5230-4b02-832a-5eef19e8dc8a";
    const occurredAt = new Date("2026-08-20T08:00:00.000Z");
    const testCase = {
      createdAt: occurredAt,
      definition: { expected: ["Dashboard is visible"] },
      definitionHash: "case-hash",
      generatedAt: occurredAt,
      id: "case-1",
      name: "Open dashboard",
      position: 0,
    };
    const run = {
      _count: { evidences: 2, interventions: 1 },
      cancelRequestedAt: null,
      createdAt: occurredAt,
      criteriaSnapshot: [{ id: "dashboard" }],
      currentAttemptNumber: 1,
      deadlineAt: new Date("2026-08-20T09:00:00.000Z"),
      environmentSnapshot: { targetUrl: "https://example.com" },
      executionDisposition: "EXECUTED",
      executionPolicy: { browser: true },
      finishedAt: occurredAt,
      goal: "Open dashboard",
      id: runId,
      lifecycle: "COMPLETED",
      maxAttempts: 3,
      queuedAt: occurredAt,
      sourceId: "case-1",
      sourceKind: "SPEC_CASE",
      startedAt: occurredAt,
      traceId: "12345678901234567890123456789012",
      updatedAt: occurredAt,
      verdict: "PASSED",
    };
    const task = {
      analysisSources: [
        {
          byteSize: 42,
          content: "Issue description",
          contentHash: "analysis-source-hash",
          createdAt: occurredAt,
          externalId: "ENG-124",
          id: "analysis-source-1",
          kind: "LINEAR_ISSUE",
          label: "ENG-124",
          locator: null,
          revision: "updated-at-1",
          stageAttemptId: "attempt-1",
          uri: "https://linear.app/acme/issue/ENG-124",
        },
      ],
      cancelRequestedAt: null,
      caseExecutions: [
        {
          caseId: testCase.id,
          createdAt: occurredAt,
          dispatchAttempts: 1,
          dispatchLastError: null,
          dispatchRequestedAt: occurredAt,
          dispatchStatus: "LINKED",
          executionOrdinal: 1,
          id: "execution-1",
          run,
          runId,
          testCase,
          updatedAt: occurredAt,
        },
      ],
      createdAt: occurredAt,
      currentStage: "SPEC_EXECUTION",
      deadlineAt: new Date("2026-08-20T09:00:00.000Z"),
      environmentSnapshot: { targetUrl: "https://example.com" },
      executionDisposition: "EXECUTED",
      executionRuns: [run],
      finishedAt: occurredAt,
      id: taskId,
      inputSnapshot: { issueRef: "ENG-124" },
      kind: "ISSUE_SPEC",
      lifecycle: "COMPLETED",
      migrationSource: "NATIVE",
      projectedAt: occurredAt,
      queuedAt: occurredAt,
      sourceKind: "LINEAR_ISSUE",
      sourceRef: "ENG-124",
      sourceSnapshotComplete: true,
      specificationSnapshots: [
        {
          cases: [testCase],
          completeness: "COMPLETE",
          context: { issue: "ENG-124" },
          createdAt: occurredAt,
          diagnostics: [],
          generatedAt: occurredAt,
          generatorKind: "DETERMINISTIC",
          generatorVersion: "issue-spec-v1",
          id: "snapshot-1",
          primaryPullRequestUrl: null,
          sourceHash: "source-hash",
          stageAttemptId: "attempt-1",
          summary: "Verify dashboard",
        },
      ],
      stages: [
        {
          attempts: [
            {
              createdAt: occurredAt,
              error: null,
              finishedAt: occurredAt,
              id: "attempt-1",
              inputSnapshot: { issueRef: "ENG-124" },
              number: 1,
              result: { caseCount: 1 },
              startedAt: occurredAt,
              status: "SUCCEEDED",
              updatedAt: occurredAt,
            },
          ],
          createdAt: occurredAt,
          currentAttemptNumber: 1,
          finishedAt: occurredAt,
          id: "stage-1",
          lastError: null,
          maxAttempts: 3,
          startedAt: occurredAt,
          status: "SUCCEEDED",
          type: "SPEC_ANALYSIS",
          updatedAt: occurredAt,
          waitingReason: null,
        },
      ],
      startedAt: occurredAt,
      title: "ENG-124",
      traceId: "12345678901234567890123456789012",
      updatedAt: occurredAt,
      verdict: "PASSED",
      waitingReason: null,
    };
    const taskEventFindMany = vi.fn().mockResolvedValue([
      {
        actor: "SPEC_ANALYSIS_WORKER",
        createdAt: occurredAt,
        id: "task-event-1",
        kind: "task.stage.succeeded",
        occurredAt,
        payload: { stage: "SPEC_ANALYSIS" },
        sequence: 1n,
      },
    ]);
    const runEventFindMany = vi.fn().mockResolvedValue([
      {
        actor: "AGENT_RUNTIME",
        attempt: { number: 1 },
        attemptId: "run-attempt-1",
        createdAt: occurredAt,
        id: "run-event-1",
        kind: "runtime.started",
        occurredAt,
        payload: { step: 1 },
        runId,
        sequence: 1n,
        taskId: "runtime-task-1",
      },
      {
        actor: "AGENT_RUNTIME",
        attempt: { number: 1 },
        attemptId: "run-attempt-1",
        createdAt: occurredAt,
        id: "run-event-501",
        kind: "runtime.completed",
        occurredAt,
        payload: { step: 501 },
        runId,
        sequence: 501n,
        taskId: "runtime-task-1",
      },
    ]);
    const service = new TaskExecutionService(
      {
        runEvent: { findMany: runEventFindMany },
        taskExecution: { findFirst: vi.fn().mockResolvedValue(task) },
        taskExecutionEvent: { findMany: taskEventFindMany },
      } as never,
      {} as never,
      {} as never,
    );
    const current = {
      credential: { id: "credential-1", name: "Console user", scopes: [] },
      team: { id: "team-1", name: "Team" },
    } as never;

    const exported = await service.exportLogs(current, taskId);

    expect(exported.schemaVersion).toBe("devproof.task-logs.v1");
    expect(exported.specAnalysis.stage?.attempts[0]?.input).toEqual({
      issueRef: "ENG-124",
    });
    expect(exported.specAnalysis.events).toEqual([
      expect.objectContaining({ kind: "task.stage.succeeded" }),
    ]);
    expect(exported.specAnalysis.sources).toEqual([
      expect.objectContaining({
        content: "Issue description",
        contentHash: "analysis-source-hash",
        id: "analysis-source-1",
      }),
    ]);
    expect(exported.specRuns[0]).toMatchObject({
      case: { id: "case-1", name: "Open dashboard" },
      logs: [{ sequence: "1" }, { sequence: "501" }],
      run: { id: runId },
    });
    expect(exported.taskEvents).toHaveLength(1);
    expect(runEventFindMany.mock.calls[0]?.[0]).not.toHaveProperty("take");
    expect(taskEventFindMany.mock.calls[0]?.[0]).not.toHaveProperty("take");
  });
});
