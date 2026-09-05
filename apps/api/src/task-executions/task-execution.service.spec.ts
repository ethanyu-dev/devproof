import { describe, expect, it, vi } from "vitest";

import {
  executionCounts,
  taskDeadlineElapsed,
  TaskExecutionService,
  validateCaseDependencyGraph,
} from "./task-execution.service.js";
import { resetEnvForTests } from "../config/env.js";

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
      queued: 1,
      running: 1,
      recovering: 0,
      waitingHuman: 0,
      terminal: 1,
      timedOut: 0,
      cancelled: 0,
      dispatchFailed: 0,
      total: 3,
      waiting: 1,
    });
  });
});

describe("TaskExecutionService post-run analysis enqueue", () => {
  it("enqueues analysis in the same transaction that cancels an Issue task", async () => {
    const previousEnabled = process.env.POST_RUN_ANALYSIS_ENABLED;
    process.env.POST_RUN_ANALYSIS_ENABLED = "true";
    resetEnvForTests();
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const transactionClient = {
      postRunAnalysisJob: { createMany },
      taskCaseExecution: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue({
          kind: "ISSUE_SPEC",
          postRunAnalysisGeneration: 1,
          teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      taskExecutionEvent: { create: vi.fn().mockResolvedValue({}) },
      taskExecutionStage: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      taskStageAttempt: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const task = {
      executionRuns: [],
      id: "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0",
      kind: "ISSUE_SPEC",
      lifecycle: "RUNNING",
      postRunAnalysisGeneration: 1,
      teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
    };
    const releasePendingRequests = vi.fn().mockResolvedValue(1);
    const service = new TaskExecutionService(
      {
        $transaction: vi
          .fn()
          .mockImplementation(
            (operation: (tx: typeof transactionClient) => unknown) =>
              operation(transactionClient),
          ),
        taskExecution: { findFirst: vi.fn().mockResolvedValue(task) },
      } as never,
      {} as never,
      {} as never,
      { releasePendingRequests } as never,
      { releaseTask: vi.fn().mockResolvedValue(undefined) } as never,
      {} as never,
    );
    vi.spyOn(service, "detail").mockResolvedValue({ id: task.id } as never);

    try {
      await service.cancel(
        {
          credential: { id: "credential-1" },
          team: { id: task.teamId },
        } as never,
        task.id,
      );

      expect(createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            generation: task.postRunAnalysisGeneration,
            taskExecutionId: task.id,
            teamId: task.teamId,
          }),
        ],
        skipDuplicates: true,
      });
      expect(releasePendingRequests).toHaveBeenCalledWith(
        task.id,
        transactionClient,
      );
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.POST_RUN_ANALYSIS_ENABLED;
      } else {
        process.env.POST_RUN_ANALYSIS_ENABLED = previousEnabled;
      }
      resetEnvForTests();
    }
  });
});

describe("TaskExecutionService Spec completion before profile resolution", () => {
  function setup(
    options: {
      analysisStatus?: string;
      cancelRequested?: boolean;
      expired?: boolean;
    } = {},
  ) {
    const task = {
      cancelRequestedAt: options.cancelRequested ? new Date() : null,
      caseExecutions: [],
      deadlineAt: new Date(Date.now() + (options.expired ? -60_000 : 60_000)),
      deployments: [],
      environmentSnapshot: {},
      executionRuns: [],
      finishedAt: null,
      id: "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0",
      kind: "ISSUE_SPEC",
      lifecycle: "RUNNING",
      notificationContext: {},
      postRunAnalysisGeneration: 1,
      profileBinding: { status: "PENDING" },
      sourceRef: "ENG-123",
      specificationSnapshots: [],
      stages: [
        {
          id: "analysis-stage",
          type: "SPEC_ANALYSIS",
          status: options.analysisStatus ?? "FAILED",
        },
        { id: "execution-stage", type: "SPEC_EXECUTION", status: "CANCELLED" },
      ],
      startedAt: new Date(),
      team: { id: "team-1", name: "Team", slug: "team" },
      teamId: "team-1",
      title: "ENG-123",
      updatedAt: new Date(),
    };
    const tx = {
      notificationOutbox: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      postRunAnalysisJob: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      taskCaseExecution: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue(task),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      taskExecutionEvent: { create: vi.fn().mockResolvedValue({}) },
      taskExecutionStage: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      taskStageAttempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const releasePendingRequests = vi.fn().mockResolvedValue(1);
    const releaseTask = vi.fn().mockResolvedValue(undefined);
    const service = new TaskExecutionService(
      {
        taskExecution: { findUnique: vi.fn().mockResolvedValue(task) },
        $transaction: vi
          .fn()
          .mockImplementation((operation: (client: typeof tx) => unknown) =>
            operation(tx),
          ),
      } as never,
      {} as never,
      {} as never,
      { releasePendingRequests } as never,
      { releaseTask } as never,
      {} as never,
    );
    return { service, task, tx, releasePendingRequests, releaseTask };
  }

  it("completes an exhausted Spec while its profile binding is still pending", async () => {
    const state = setup();
    await expect(
      state.service.projectTask(state.task.id),
    ).resolves.toMatchObject({
      executionDisposition: "NOT_RUN",
      lifecycle: "COMPLETED",
    });
    expect(state.tx.taskExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycle: "COMPLETED",
          projectionNeededAt: null,
        }),
        where: { id: state.task.id, updatedAt: state.task.updatedAt },
      }),
    );
    expect(state.tx.taskExecutionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "task.completed" }),
      }),
    );
    expect(state.releasePendingRequests).toHaveBeenCalledWith(
      state.task.id,
      state.tx,
    );
    expect(state.releaseTask).toHaveBeenCalledWith(state.task.id);
  });

  it.each(["FAILED", "SUCCEEDED"])(
    "projects a parent deadline while Spec is %s and the profile remains pending",
    async (analysisStatus) => {
      const state = setup({ analysisStatus, expired: true });
      await expect(
        state.service.projectTask(state.task.id),
      ).resolves.toMatchObject({ lifecycle: "TIMED_OUT" });
      expect(state.tx.taskStageAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            leaseToken: null,
            status: "TIMED_OUT",
          }),
        }),
      );
      expect(state.releaseTask).toHaveBeenCalledWith(state.task.id);
    },
  );

  it("projects cancellation even after Spec succeeds while profile resolution waits", async () => {
    const state = setup({ analysisStatus: "SUCCEEDED", cancelRequested: true });
    await expect(
      state.service.projectTask(state.task.id),
    ).resolves.toMatchObject({ lifecycle: "CANCELLED" });
    expect(state.releaseTask).toHaveBeenCalledWith(state.task.id);
  });

  it("preserves an active profile wait after Spec succeeds", async () => {
    const state = setup({ analysisStatus: "SUCCEEDED" });
    await expect(state.service.projectTask(state.task.id)).resolves.toBeNull();
    expect(state.tx.taskExecution.updateMany).not.toHaveBeenCalled();
    expect(state.releasePendingRequests).not.toHaveBeenCalled();
  });
});

describe("TaskExecutionService human resume deadlines", () => {
  it("pauses parent task timeout projection while a child Run waits for HITL", () => {
    const now = new Date("2026-08-28T02:00:00.000Z");

    expect(
      taskDeadlineElapsed({
        deadlineAt: new Date(now.getTime() - 60_000),
        lifecycle: "WAITING_HUMAN",
        now,
        waitingForHuman: true,
      }),
    ).toBe(false);
    expect(
      taskDeadlineElapsed({
        deadlineAt: new Date(now.getTime() - 60_000),
        lifecycle: "RUNNING",
        now,
        waitingForHuman: false,
      }),
    ).toBe(true);
  });

  it("accepts an expired waiting task and restarts its full window when deployments are provided", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-28T02:00:00.000Z");
    vi.setSystemTime(now);
    try {
      const taskId = "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0";
      const tx = {
        taskCaseExecution: { createMany: vi.fn(), deleteMany: vi.fn() },
        taskDeployment: {
          create: vi.fn().mockResolvedValue({ id: "deployment-1" }),
          deleteMany: vi.fn(),
        },
        taskExecution: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        taskExecutionEvent: { create: vi.fn() },
        taskExecutionStage: { updateMany: vi.fn() },
      };
      const prisma = {
        $transaction: vi.fn((callback) => callback(tx)),
        taskExecution: {
          findFirst: vi.fn().mockResolvedValue({
            deadlineAt: new Date(now.getTime() - 60_000),
            environmentSnapshot: {},
            executionRuns: [],
            id: taskId,
            inputSnapshot: {
              idempotencyKey: "expired-issue-resume",
              issueRef: "PROD-6781",
              kind: "ISSUE_SPEC",
            },
            kind: "ISSUE_SPEC",
            lifecycle: "WAITING_INPUT",
            specificationSnapshots: [{ cases: [] }],
            stages: [{ status: "SUCCEEDED", type: "SPEC_ANALYSIS" }],
          }),
        },
      };
      const profileResolver = {
        resolve: vi.fn().mockResolvedValue({ status: "WAITING_INPUT" }),
      };
      const service = new TaskExecutionService(
        prisma as never,
        {} as never,
        {} as never,
        profileResolver as never,
        {} as never,
        {} as never,
      );
      vi.spyOn(service, "detail").mockResolvedValue({ id: taskId } as never);

      await service.setDeployments(
        {
          credential: { id: "credential-1", name: "Console", scopes: [] },
          team: { id: "team-1", name: "Team" },
        } as never,
        taskId,
        {
          deployments: [
            {
              environment: {},
              key: "preview",
              name: "Preview",
              targetUrl: "https://preview.example.com",
            },
          ],
        },
      );

      expect(tx.taskExecution.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deadlineAt: new Date(now.getTime() + 7_200_000),
            lifecycle: "RUNNING",
          }),
          where: {
            cancelRequestedAt: null,
            id: taskId,
            lifecycle: "WAITING_INPUT",
          },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TaskExecutionService dispatch fairness", () => {
  it("keeps opted-in policy review ahead of Run creation without consuming dispatch attempts", async () => {
    const candidate = {
      id: "review-case",
      taskExecutionId: "task-1",
      deploymentId: "deployment-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      dispatchStatus: "PENDING",
      dispatchAttempts: 0,
      scheduling: null,
      taskExecution: { inputSnapshot: { casePolicyReviewRequired: true } },
      executionPolicy: { accessMode: "READ_ONLY", provenance: "GENERATED" },
    };
    const prisma = {
      taskCaseExecution: {
        findMany: vi.fn().mockResolvedValue([{ taskExecutionId: "task-1" }]),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(candidate)
          .mockResolvedValue(null),
        updateMany: vi.fn(),
      },
    };
    const reservations = { acquire: vi.fn() };
    const service = new TaskExecutionService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      reservations as never,
      {} as never,
    );
    const internals = service as unknown as {
      recordScheduling: (...args: unknown[]) => Promise<void>;
      dispatchPending: (limit: number) => Promise<number>;
    };
    const record = vi
      .spyOn(internals, "recordScheduling")
      .mockResolvedValue(undefined);
    await internals.dispatchPending(4);
    expect(record).toHaveBeenCalledWith(
      candidate,
      "WAITING",
      "POLICY_REVIEW",
      null,
    );
    expect(prisma.taskCaseExecution.updateMany).not.toHaveBeenCalled();
    expect(reservations.acquire).not.toHaveBeenCalled();
  });

  it("scans past a blocked dependency and does not serialize an isolated identity", async () => {
    const dependencyId = "285146a8-5230-4b02-832a-5eef19e8dc8a";
    const now = new Date();
    const base = {
      taskExecutionId: "task-1",
      taskExecution: { inputSnapshot: {} },
      deploymentId: "deployment-1",
      createdAt: now,
      updatedAt: now,
      dispatchAttempts: 0,
      dispatchStatus: "PENDING",
      scheduling: null,
    };
    const blocked = {
      ...base,
      id: "blocked",
      executionPolicy: {
        accessMode: "READ_ONLY",
        dependsOnCaseIds: [dependencyId],
      },
    };
    const ready = {
      ...base,
      id: "ready",
      executionPolicy: { accessMode: "READ_ONLY" },
    };
    const prisma = {
      taskCaseExecution: {
        findMany: vi.fn(async (input) =>
          input.distinct
            ? [{ taskExecutionId: "task-1" }]
            : [
                {
                  id: "dependency",
                  taskExecutionId: "task-1",
                  caseId: dependencyId,
                  deploymentId: "deployment-1",
                  executionOrdinal: 1,
                  runId: "dependency-run",
                  dispatchStatus: "LINKED",
                  run: {
                    lifecycle: "RUNNING",
                    verdict: null,
                    executionDisposition: null,
                  },
                },
              ],
        ),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(blocked)
          .mockResolvedValueOnce(ready)
          .mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      executionRun: { findFirst: vi.fn() },
    };
    const reservations = {
      acquire: vi.fn().mockResolvedValue({
        acquired: true,
        profile: { id: "profile-1", executionMode: "ISOLATED_AUTH" },
      }),
    };
    const service = new TaskExecutionService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      reservations as never,
      {} as never,
    );
    const internals = service as unknown as {
      recordScheduling: (...args: unknown[]) => Promise<void>;
      dispatchPending: (limit: number) => Promise<number>;
    };
    const record = vi
      .spyOn(internals, "recordScheduling")
      .mockResolvedValue(undefined);
    await internals.dispatchPending(4);
    expect(record).toHaveBeenCalledWith(
      blocked,
      "WAITING",
      "CASE_DEPENDENCY",
      expect.objectContaining({ runId: "dependency-run" }),
    );
    expect(prisma.taskCaseExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "ready", updatedAt: now }),
      }),
    );
    expect(prisma.executionRun.findFirst).not.toHaveBeenCalled();
    expect(reservations.acquire).toHaveBeenCalledOnce();
  });

  it("preserves waiting age when the blocking resource changes", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      taskCaseExecution: { updateMany },
      taskExecution: { update: vi.fn() },
    };
    const service = new TaskExecutionService(
      { $transaction: vi.fn((callback) => callback(tx)) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const since = "2026-09-04T01:00:00.000Z";
    await (
      service as unknown as {
        recordScheduling: (...args: unknown[]) => Promise<void>;
      }
    ).recordScheduling(
      {
        id: "case-1",
        taskExecutionId: "task-1",
        updatedAt: new Date(),
        createdAt: new Date(since),
        scheduling: {
          state: "WAITING",
          reason: "PROFILE_RESERVED",
          waitingSince: since,
        },
      },
      "WAITING",
      "DATA_LOCK",
      null,
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduling: expect.objectContaining({
            reason: "DATA_LOCK",
            waitingSince: since,
          }),
        }),
      }),
    );
  });

  it("selects Issues distinctly before loading execution candidates", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new TaskExecutionService(
      { taskCaseExecution: { findMany } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await (
      service as unknown as {
        dispatchPending(limit: number): Promise<number>;
      }
    ).dispatchPending(100);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ["taskExecutionId"],
        select: { createdAt: true, taskExecutionId: true },
      }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ take: expect.anything() }),
    );
  });
});

describe("Case execution dependency policy", () => {
  const first = "285146a8-5230-4b02-832a-5eef19e8dc8a";
  const second = "385146a8-5230-4b02-832a-5eef19e8dc8a";
  it("rejects cycles and references outside the deployment", () => {
    expect(() =>
      validateCaseDependencyGraph([
        {
          caseId: first,
          executionPolicy: {
            accessMode: "READ_ONLY",
            dependsOnCaseIds: [second],
          },
        },
        {
          caseId: second,
          executionPolicy: {
            accessMode: "READ_ONLY",
            dependsOnCaseIds: [first],
          },
        },
      ]),
    ).toThrow("cycle");
    expect(() =>
      validateCaseDependencyGraph([
        {
          caseId: first,
          executionPolicy: {
            accessMode: "READ_ONLY",
            dependsOnCaseIds: [second],
          },
        },
      ]),
    ).toThrow("belong");
  });

  it("refuses policy changes once a Run exists", async () => {
    const tx = {
      taskCaseExecution: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ runId: "run-1", taskExecution: {} }),
        updateMany: vi.fn(),
      },
    };
    const service = new TaskExecutionService(
      { $transaction: vi.fn((callback) => callback(tx)) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.setCaseExecutionPolicy(
        { team: { id: "team-1" } } as never,
        "task-1",
        first,
        { accessMode: "READ_ONLY" },
      ),
    ).rejects.toThrow("unstarted");
    expect(tx.taskCaseExecution.updateMany).not.toHaveBeenCalled();
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
  const deploymentId = "764146a8-5230-4b02-832a-5eef19e8dc8a";
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
          deploymentId,
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
      deploymentId,
      executionOrdinal: 2,
      id: nextExecutionId,
    });
    const taskExecutionStageUpdate = vi.fn().mockResolvedValue({});
    const taskExecutionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const taskExecutionEventCreate = vi.fn().mockResolvedValue({});
    const tx = {
      postRunAnalysisJob: { findMany: vi.fn().mockResolvedValue([]) },
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
        deploymentId,
        executionOrdinal: 2,
        executionPolicy: expect.anything(),
        taskExecutionId: taskId,
      },
      select: { deploymentId: true, executionOrdinal: true, id: true },
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
          postRunAnalysisGeneration: { increment: 1 },
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
      deployments: [],
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

    await service.listPage(current, 1, 10, {
      status: "VERIFICATION_FAILED",
    });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { teamId: "team-1", verdict: "FAILED" },
      }),
    );

    await service.listPage(current, 1, 10, { status: "EXECUTION_FAILED" });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { lifecycle: "TIMED_OUT" },
            {
              executionDisposition: {
                in: [
                  "NOT_RUN",
                  "BLOCKED",
                  "AGENT_ERROR",
                  "PROVIDER_ERROR",
                  "BROWSER_UNAVAILABLE",
                  "RUNTIME_LOST",
                ],
              },
              lifecycle: "COMPLETED",
            },
          ],
          teamId: "team-1",
          verdict: null,
        },
      }),
    );
  });
});

describe("TaskExecutionService log export", () => {
  it("exports the immutable v2 task log bundle", async () => {
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
    const deployment = {
      id: "deployment-1",
      key: "staging",
      name: "Staging",
      targetUrl: "https://example.com",
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
          deployment,
          deploymentId: deployment.id,
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
      deployments: [
        {
          ...deployment,
          createdAt: occurredAt,
          enabled: true,
          environmentSnapshot: {},
          taskExecutionId: taskId,
          updatedAt: occurredAt,
        },
      ],
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
    const bundle = {
      runEvents: [
        { evidenceRef: "run-event://run-event-1", sequence: "1" },
        { evidenceRef: "run-event://run-event-501", sequence: "501" },
      ],
      schemaVersion: "devproof.task-logs.v2",
    };
    const build = vi.fn().mockResolvedValue({ bundle });
    const service = new TaskExecutionService(
      {
        runEvent: { findMany: runEventFindMany },
        taskExecution: { findFirst: vi.fn().mockResolvedValue(task) },
        taskExecutionEvent: { findMany: taskEventFindMany },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { build } as never,
    );
    const current = {
      credential: { id: "credential-1", name: "Console user", scopes: [] },
      team: { id: "team-1", name: "Team" },
    } as never;

    const exported = await service.exportLogs(current, taskId);

    expect(exported).toEqual(bundle);
    expect(build).toHaveBeenCalledWith("team-1", taskId);
  });
});
