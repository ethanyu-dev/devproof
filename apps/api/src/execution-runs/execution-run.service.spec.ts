import { describe, expect, it, vi } from "vitest";

import {
  ExecutionRunService,
  projectRunTrajectory,
} from "./execution-run.service.js";

const runId = "285146a8-5230-4b02-832a-5eef19e8dc8a";
const attemptId = "cc61de8d-cf29-4561-b2cd-c67c304668a5";
const taskId = "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0";
const interventionId = "d63bd843-b89d-48ea-90c9-caad5b51d526";

const snapshot = {
  attemptId,
  attemptNumber: 1,
  criteria: [
    { description: "The page is visible.", id: "visible", required: true },
  ],
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  environment: { targetUrl: "https://example.com" },
  executionPolicy: {
    browser: { availabilityPolicy: "WAIT" },
    hitl: {
      enabled: true,
      notificationChannels: [],
      onTimeout: "INCONCLUSIVE",
      timeoutSeconds: 3600,
    },
    retryPolicy: { maxAttempts: 1, retryOn: [] },
  },
  goal: "Verify the page.",
  runId,
  teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
  traceId: "1234567890abcdef1234567890abcdef",
};

const current = {
  credential: {
    id: "188ea17e-cac6-42a5-ab62-535ee4b6112d",
    name: "Console user",
    scopes: ["run:read", "run:write", "run:cancel"],
  },
  team: { id: snapshot.teamId, name: "DevProof Team" },
} as never;

describe("ExecutionRunService HITL resume", () => {
  it("copies the Run HITL policy into the immutable Runtime task snapshot", async () => {
    const tx = {
      agentRuntimeTask: { create: vi.fn() },
      browserExecution: { create: vi.fn() },
      executionRun: { create: vi.fn() },
      runAttempt: { create: vi.fn() },
      runEvent: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      executionRun: {
        findFirst: vi.fn().mockResolvedValue({ id: runId }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    const service = new ExecutionRunService(prisma as never, {} as never);

    await service.create(current, {
      businessReferences: [
        {
          externalId: "reference://spec/spec-1/issue",
          kind: "BUSINESS_REFERENCE",
          label: "ENG-1",
          metadata: { source: "LINEAR" },
        },
      ],
      browserPolicy: {
        availabilityPolicy: "WAIT",
        profile: { mode: "EPHEMERAL" },
        requiredCapabilities: ["browser"],
      },
      criteria: snapshot.criteria,
      deadlineSeconds: 600,
      environment: snapshot.environment,
      goal: snapshot.goal,
      hitlPolicy: snapshot.executionPolicy.hitl,
      idempotencyKey: "hitl-policy-snapshot",
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      source: { kind: "API" },
    } as never);

    expect(tx.agentRuntimeTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          snapshot: expect.objectContaining({
            businessReferences: [
              expect.objectContaining({
                externalId: "reference://spec/spec-1/issue",
                kind: "BUSINESS_REFERENCE",
              }),
            ],
            executionPolicy: expect.objectContaining({
              hitl: snapshot.executionPolicy.hitl,
            }),
          }),
        }),
      }),
    );
    expect(tx.browserExecution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          input: expect.objectContaining({
            targetUrl: "https://example.com",
          }),
          status: "REQUESTED",
        }),
      }),
    );
  });

  it("idempotently binds an existing compatible Run to its parent task", async () => {
    const input = {
      businessReferences: [],
      browserPolicy: {
        availabilityPolicy: "WAIT",
        profile: { mode: "EPHEMERAL" },
        requiredCapabilities: ["browser"],
      },
      criteria: snapshot.criteria,
      deadlineSeconds: 600,
      environment: snapshot.environment,
      goal: snapshot.goal,
      hitlPolicy: snapshot.executionPolicy.hitl,
      idempotencyKey: "task-run-binding",
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      source: { kind: "TASK_CASE" },
    };
    const existing = {
      criteriaSnapshot: input.criteria,
      environmentSnapshot: input.environment,
      executionPolicy: {
        browser: input.browserPolicy,
        businessReferences: input.businessReferences,
        hitl: input.hitlPolicy,
        retryPolicy: input.retryPolicy,
      },
      goal: input.goal,
      id: runId,
      taskExecutionId: null,
    };
    const tx = {
      executionRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      taskExecution: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      executionRun: {
        findFirst: vi.fn().mockResolvedValue(existing),
        findUnique: vi.fn().mockResolvedValue(existing),
      },
    };
    const service = new ExecutionRunService(prisma as never, {} as never);

    await expect(
      service.createForTask(current, input as never, taskId),
    ).resolves.toMatchObject({ id: runId });
    expect(tx.executionRun.updateMany).toHaveBeenCalledWith({
      data: { taskExecutionId: taskId },
      where: { id: runId, taskExecutionId: null },
    });
    expect(tx.taskExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: taskId } }),
    );
  });

  it("injects the human response and requeues the same task", async () => {
    const tx = transactionClient();
    tx.humanIntervention.findFirst.mockResolvedValue(
      intervention({ browserControlLease: null }),
    );
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      executionRun: {
        findFirst: vi.fn().mockResolvedValue({ id: runId }),
      },
    };
    const service = new ExecutionRunService(prisma as never, {} as never);

    await service.resolveIntervention(current, runId, interventionId, {
      response: { approved: true, note: "MFA completed." },
    });

    expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          snapshot: expect.objectContaining({
            executionPolicy: expect.objectContaining({
              resume: expect.objectContaining({
                interventionId,
                response: { approved: true, note: "MFA completed." },
              }),
            }),
          }),
          status: "PENDING",
        }),
        where: { id: taskId },
      }),
    );
    expect(tx.executionRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lifecycle: "QUEUED" }),
        where: expect.objectContaining({
          id: runId,
          lifecycle: "WAITING_HUMAN",
        }),
      }),
    );
    expect(tx.runEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actor: "HUMAN",
          kind: "human.intervention.resolved",
        }),
      }),
    );
  });

  it("refunds paused execution time without crossing the hard deadline", async () => {
    const tx = transactionClient();
    const beforeResolve = Date.now();
    const hardDeadlineAt = new Date(beforeResolve + 120_000);
    tx.humanIntervention.findFirst.mockResolvedValue(
      intervention({
        pausedExecutionRemainingMs: 45_000,
        run: {
          deadlineAt: new Date(beforeResolve + 90_000),
          executionPolicy: {
            ...snapshot.executionPolicy,
            deadline: {
              extensionStepSeconds: 180,
              finalizationReserveSeconds: 60,
              maxExtensionSeconds: 900,
              maxModelCallSeconds: 300,
              mode: "ADAPTIVE",
              refundHumanWait: true,
              slowModelThresholdSeconds: 60,
            },
          },
          hardDeadlineAt,
          lifecycle: "WAITING_HUMAN",
        },
      }),
    );
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
    };
    const service = new ExecutionRunService(prisma as never, {} as never);

    await service.resolveIntervention(current, runId, interventionId, {
      response: { approved: true },
    });

    const resumedDeadlineAt = tx.executionRun.updateMany.mock.calls[0]?.[0].data
      .deadlineAt as Date;
    expect(resumedDeadlineAt.getTime()).toBeGreaterThanOrEqual(
      beforeResolve + 45_000,
    );
    expect(resumedDeadlineAt.getTime()).toBeLessThanOrEqual(
      hardDeadlineAt.getTime(),
    );
    expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deadlineAt: resumedDeadlineAt }),
      }),
    );
  });

  it("refreshes the parent task window and excludes human wait from the Run hard deadline", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-28T02:00:00.000Z");
    vi.setSystemTime(now);
    try {
      const tx = transactionClient();
      const parentTaskId = "d4076202-4620-4d34-accc-0a553acaf426";
      const requestedAt = new Date(now.getTime() - 10 * 60_000);
      const originalHardDeadlineAt = new Date(now.getTime() + 2 * 60_000);
      tx.humanIntervention.findFirst.mockResolvedValue(
        intervention({
          pausedExecutionRemainingMs: 45_000,
          requestedAt,
          run: {
            deadlineAt: new Date(now.getTime() + 60 * 60_000),
            executionPolicy: {
              ...snapshot.executionPolicy,
              deadline: {
                extensionStepSeconds: 180,
                finalizationReserveSeconds: 60,
                maxExtensionSeconds: 900,
                maxModelCallSeconds: 300,
                mode: "ADAPTIVE",
                refundHumanWait: true,
                slowModelThresholdSeconds: 60,
              },
            },
            hardDeadlineAt: originalHardDeadlineAt,
            lifecycle: "WAITING_HUMAN",
            taskExecution: {
              id: parentTaskId,
              inputSnapshot: {
                idempotencyKey: "issue-hitl-resume",
                issueRef: "PROD-6781",
                kind: "ISSUE_SPEC",
              },
              lifecycle: "WAITING_HUMAN",
            },
          },
        }),
      );
      const prisma = {
        $transaction: vi.fn((callback) => callback(tx)),
        executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
      };
      const service = new ExecutionRunService(prisma as never, {} as never);

      await service.resolveIntervention(current, runId, interventionId, {
        response: { approved: true },
      });

      expect(tx.executionRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deadlineAt: new Date(now.getTime() + 45_000),
            hardDeadlineAt: new Date(
              originalHardDeadlineAt.getTime() + 10 * 60_000,
            ),
          }),
        }),
      );
      expect(tx.taskExecution.updateMany).toHaveBeenCalledWith({
        data: {
          deadlineAt: new Date(now.getTime() + 7_200_000),
          projectionNeededAt: now,
        },
        where: {
          cancelRequestedAt: null,
          id: parentTaskId,
          lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the full remaining window for a fixed Run after HITL", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-28T02:00:00.000Z");
    vi.setSystemTime(now);
    try {
      const tx = transactionClient();
      const requestedAt = new Date(now.getTime() - 10 * 60_000);
      const originalDeadlineAt = new Date(requestedAt.getTime() + 60_000);
      tx.humanIntervention.findFirst.mockResolvedValue(
        intervention({
          pausedExecutionRemainingMs: 60_000,
          requestedAt,
          run: {
            deadlineAt: new Date(now.getTime() + 30 * 60_000),
            executionPolicy: {
              ...snapshot.executionPolicy,
              deadline: { mode: "FIXED" },
            },
            hardDeadlineAt: originalDeadlineAt,
            lifecycle: "WAITING_HUMAN",
            taskExecution: null,
          },
        }),
      );
      const prisma = {
        $transaction: vi.fn((callback) => callback(tx)),
        executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
      };
      const service = new ExecutionRunService(prisma as never, {} as never);

      await service.resolveIntervention(current, runId, interventionId, {
        response: { approved: true },
      });

      expect(tx.executionRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deadlineAt: new Date(now.getTime() + 60_000),
            hardDeadlineAt: new Date(now.getTime() + 60_000),
            lifecycle: "QUEUED",
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not requeue a Run that was cancelled after it was read", async () => {
    const tx = transactionClient();
    tx.executionRun.updateMany.mockResolvedValue({ count: 0 });
    tx.humanIntervention.findFirst.mockResolvedValue(
      intervention({ browserControlLease: null }),
    );
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
    };
    const service = new ExecutionRunService(prisma as never, {} as never);

    await expect(
      service.resolveIntervention(current, runId, interventionId, {
        response: { approved: true },
      }),
    ).rejects.toThrow("can no longer accept human input");
    expect(tx.humanIntervention.updateMany).not.toHaveBeenCalled();
    expect(tx.agentRuntimeTask.update).not.toHaveBeenCalled();
  });

  it("does not resume a Run when its parent becomes terminal after the read", async () => {
    const tx = transactionClient();
    tx.taskExecution.updateMany.mockResolvedValue({ count: 0 });
    tx.humanIntervention.findFirst.mockResolvedValue(
      intervention({
        run: {
          deadlineAt: new Date(snapshot.deadlineAt),
          executionPolicy: snapshot.executionPolicy,
          hardDeadlineAt: new Date(snapshot.deadlineAt),
          lifecycle: "WAITING_HUMAN",
          taskExecution: {
            cancelRequestedAt: null,
            id: "d4076202-4620-4d34-accc-0a553acaf426",
            inputSnapshot: {
              idempotencyKey: "parent-terminal-race",
              issueRef: "PROD-6781",
              kind: "ISSUE_SPEC",
            },
            lifecycle: "WAITING_HUMAN",
          },
        },
      }),
    );
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
    };
    const service = new ExecutionRunService(prisma as never, {} as never);

    await expect(
      service.resolveIntervention(current, runId, interventionId, {
        response: { approved: true },
      }),
    ).rejects.toThrow("parent task is already terminal");
    expect(tx.executionRun.updateMany).not.toHaveBeenCalled();
    expect(tx.humanIntervention.updateMany).not.toHaveBeenCalled();
  });

  it("rejects resolution while the browser is still controlled", async () => {
    const tx = transactionClient();
    tx.humanIntervention.findFirst.mockResolvedValue(
      intervention({
        browserControlLease: {
          expiresAt: new Date(Date.now() + 30_000),
        },
      }),
    );
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      executionRun: { findFirst: vi.fn() },
    };
    const service = new ExecutionRunService(prisma as never, {} as never);

    await expect(
      service.resolveIntervention(current, runId, interventionId, {
        response: {},
      }),
    ).rejects.toThrow("Release browser human control");
    expect(tx.agentRuntimeTask.update).not.toHaveBeenCalled();
  });
});

function intervention(overrides: Record<string, unknown>) {
  return {
    attemptId,
    browserControlLease: null,
    expiresAt: new Date(Date.now() + 60_000),
    id: interventionId,
    requestedAt: new Date(),
    run: {
      deadlineAt: new Date(snapshot.deadlineAt),
      executionPolicy: snapshot.executionPolicy,
      hardDeadlineAt: new Date(snapshot.deadlineAt),
      lifecycle: "WAITING_HUMAN",
    },
    runId,
    pausedExecutionRemainingMs: null,
    status: "PENDING",
    task: { snapshot },
    taskId,
    teamId: snapshot.teamId,
    ...overrides,
  };
}

function transactionClient() {
  return {
    agentRuntimeTask: { update: vi.fn() },
    browserExecution: { findUnique: vi.fn().mockResolvedValue(null) },
    browserRuntimeProfileLease: { updateMany: vi.fn() },
    browserRuntimeSession: { updateMany: vi.fn() },
    browserRuntimeSlot: { updateMany: vi.fn() },
    executionRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    humanIntervention: {
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    notificationOutbox: { create: vi.fn() },
    runAttempt: { update: vi.fn() },
    runEvent: { create: vi.fn() },
    taskExecution: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

describe("Run trajectory projection", () => {
  it("pairs lifecycle starts with settled model and tool records", () => {
    const rows = [
      {
        actor: "AGENT_RUNTIME",
        attempt: { number: 1 },
        id: "segment-start",
        kind: "agent.segment.started",
        occurredAt: new Date("2026-08-20T01:00:00.000Z"),
        payload: {
          attemptNumber: 1,
          inputPreview: { goal: "Verify" },
          model: "gpt-test",
          provider: "CODEX",
          segmentId: "task-1:1",
        },
        sequence: 10n,
      },
      {
        actor: "AGENT_RUNTIME",
        attempt: { number: 1 },
        id: "model-start",
        kind: "agent.model.started",
        occurredAt: new Date("2026-08-20T01:00:00.010Z"),
        payload: {
          attemptNumber: 1,
          inputPreview: [{ role: "user", content: "Verify" }],
          model: "gpt-test",
          provider: "CODEX",
          segmentId: "task-1:1",
          step: 1,
        },
        sequence: 11n,
      },
      {
        actor: "AGENT_RUNTIME",
        attempt: { number: 1 },
        id: "model-complete",
        kind: "agent.model.completed",
        occurredAt: new Date("2026-08-20T01:00:00.060Z"),
        payload: {
          attemptNumber: 1,
          durationMs: 50,
          inputPreview: [{ role: "user", content: "Verify" }],
          model: "gpt-test",
          outputPreview: [{ type: "function_call", name: "browser_command" }],
          provider: "CODEX",
          responseId: "response-1",
          segmentId: "task-1:1",
          step: 1,
        },
        sequence: 12n,
      },
      {
        actor: "AGENT_RUNTIME",
        attempt: { number: 1 },
        id: "tool-start",
        kind: "agent.tool.started",
        occurredAt: new Date("2026-08-20T01:00:00.061Z"),
        payload: {
          attemptNumber: 1,
          callId: "call-1",
          inputPreview: { commandType: "page.snapshot" },
          name: "browser_command",
          segmentId: "task-1:1",
          step: 1,
        },
        sequence: 13n,
      },
      {
        actor: "AGENT_RUNTIME",
        attempt: { number: 1 },
        id: "tool-complete",
        kind: "agent.tool.completed",
        occurredAt: new Date("2026-08-20T01:00:00.081Z"),
        payload: {
          attemptNumber: 1,
          callId: "call-1",
          durationMs: 20,
          inputPreview: { commandType: "page.snapshot" },
          name: "browser_command",
          outputPreview: { status: "SUCCEEDED" },
          segmentId: "task-1:1",
          status: "SUCCEEDED",
          step: 1,
        },
        sequence: 14n,
      },
    ];

    const records = projectRunTrajectory(rows);

    expect(records.map((record) => record.kind)).toEqual([
      "INPUT",
      "MODEL",
      "TOOL",
    ]);
    expect(records[1]).toMatchObject({
      durationMs: 50,
      input: [{ role: "user", content: "Verify" }],
      status: "SUCCEEDED",
      step: 1,
    });
    expect(records[2]).toMatchObject({
      callId: "call-1",
      durationMs: 20,
      title: "browser_command",
    });
  });
});
