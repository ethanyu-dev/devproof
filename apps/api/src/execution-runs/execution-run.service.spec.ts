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

describe("ExecutionRunService events", () => {
  it("includes team-scoped recovery links in execution details without exposing recovery credentials", async () => {
    const recovery = {
      id: "recovery",
      closureState: "VERIFIED",
      writeOutcomeState: "UNKNOWN",
    };
    const prisma = {
      executionRun: {
        findFirst: vi.fn().mockResolvedValue({
          id: runId,
          executionPolicy: snapshot.executionPolicy,
          browserProfileId: null,
          browserExecutions: [
            { runtimeSessionId: "session", runtimeSession: null },
          ],
          evidences: [],
        }),
      },
      runtimeSessionRecovery: {
        findMany: vi.fn().mockResolvedValue([recovery]),
      },
    };
    const detail = await new ExecutionRunService(
      prisma as never,
      {} as never,
    ).consoleDetail(current, runId);
    expect(detail.recoveries).toEqual([recovery]);
    expect(prisma.runtimeSessionRecovery.findMany).toHaveBeenCalledWith({
      where: { teamId: snapshot.teamId, sessionId: { in: ["session"] } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        closureState: true,
        writeOutcomeState: true,
        sessionId: true,
        lastErrorCode: true,
        resolvedAt: true,
      },
    });
  });

  it("serializes event cursors without losing precision and scopes pagination to the team", async () => {
    const sequence = 9007199254740993n;
    const prisma = {
      executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
      runEvent: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "event", sequence, payload: { step: 1 } }]),
      },
    };
    const service = new ExecutionRunService(prisma as never, {} as never);
    const events = await service.events(current, runId, sequence - 1n);
    expect(JSON.parse(JSON.stringify(events))[0].sequence).toBe(
      "9007199254740993",
    );
    expect(prisma.runEvent.findMany).toHaveBeenCalledWith({
      orderBy: { sequence: "asc" },
      take: 500,
      where: {
        runId,
        teamId: snapshot.teamId,
        sequence: { gt: sequence - 1n },
      },
    });
  });
});

describe("ExecutionRunService HITL resume", () => {
  it("replaces one requested role and retains other accounts, writes and cleanup evidence", async () => {
    const tx = transactionClient();
    const bindings = ["first", "second"].map((role) => ({
      slotId: `${role}:1`,
      label: role,
      account: role,
      aliases: [],
      usage: "CREATE_OR_MODIFY",
      requiredTypes: [],
    }));
    const writes = [
      {
        key: "write",
        method: "POST",
        url: "https://example.com/items",
        status: 200,
        confirmed: true,
        request: "{}",
        evidenceRefs: ["proof"],
      },
    ];
    const evidence = [{ externalId: "proof", kind: "NETWORK", metadata: {} }];
    const policy = {
      ...snapshot.executionPolicy,
      testAccounts: bindings,
      executionState: { accounts: bindings, writes },
      verificationCheckpoint: { criteria: [], evidence },
    };
    const original = intervention({ kind: "TEST_ACCOUNT" });
    tx.humanIntervention.findFirst.mockResolvedValue({
      ...original,
      context: {
        accountSlots: [
          {
            slotId: "second:1",
            label: "第二个用途",
            usage: "CREATE_OR_MODIFY",
            requiredTypes: [],
          },
        ],
      },
      run: { ...original.run, executionPolicy: policy },
      task: { snapshot: { ...snapshot, executionPolicy: policy } },
    });
    const service = new ExecutionRunService(
      {
        $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
        executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
      } as never,
      {} as never,
    );
    await service.resolveIntervention(current, runId, interventionId, {
      response: { accounts: { "second:1": "replacement" } },
    });
    expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          snapshot: expect.objectContaining({
            executionPolicy: expect.objectContaining({
              testAccounts: [
                bindings[0],
                expect.objectContaining({
                  slotId: "second:1",
                  account: "replacement",
                }),
              ],
              executionState: expect.objectContaining({ writes }),
              verificationCheckpoint: {
                criteria: [],
                observations: [],
                evidence,
              },
            }),
          }),
        }),
      }),
    );
  });

  it("rejects prose in the account field but preserves the account when instructions are submitted separately", async () => {
    const tx = transactionClient();
    tx.humanIntervention.findFirst.mockResolvedValue(
      intervention({
        kind: "TEST_ACCOUNT",
        task: {
          snapshot: {
            ...snapshot,
            executionPolicy: {
              ...snapshot.executionPolicy,
              executionState: { account: "13962083614" },
            },
          },
        },
      }),
    );
    const service = new ExecutionRunService(
      {
        $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
        executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
      } as never,
      {} as never,
    );
    await expect(
      service.resolveIntervention(current, runId, interventionId, {
        response: { account: "允许你删除再重新创建" },
      }),
    ).rejects.toThrow("处置意见");
    expect(tx.humanIntervention.updateMany).not.toHaveBeenCalled();
    await service.resolveIntervention(current, runId, interventionId, {
      response: { instructions: "核对本次创建记录后进行清理" },
    });
    expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          snapshot: expect.objectContaining({
            executionPolicy: expect.objectContaining({
              resume: expect.objectContaining({
                response: {
                  account: "13962083614",
                  instructions: "核对本次创建记录后进行清理",
                },
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("accepts a supplied account without consulting other cases or historical cleanup", async () => {
    const tx = transactionClient();
    const original = intervention({
      kind: "TEST_ACCOUNT",
      context: { usage: "CREATE_OR_MODIFY" },
    });
    tx.humanIntervention.findFirst.mockResolvedValue(original);
    tx.humanIntervention.findMany.mockRejectedValue(
      new Error("historical account scan must not run"),
    );
    tx.executionRun.findMany.mockRejectedValue(
      new Error("account reservation scan must not run"),
    );
    const service = new ExecutionRunService(
      {
        $transaction: (callback: (tx: unknown) => unknown) => callback(tx),
      } as never,
      {} as never,
    );
    vi.spyOn(service, "detail").mockResolvedValue({} as never);
    await service.resolveIntervention(current, runId, interventionId, {
      response: { account: "shared-user" },
    });
    expect(tx.humanIntervention.findMany).not.toHaveBeenCalled();
    expect(tx.executionRun.findMany).not.toHaveBeenCalled();
    expect(tx.humanIntervention.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          response: { account: "shared-user" },
          status: "RESOLVED",
        }),
      }),
    );
    expect(tx.executionRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lifecycle: "QUEUED" }),
      }),
    );
  });

  it("keeps HITL and browser checks in the Runtime snapshot while storing provenance only on the Run", async () => {
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
      criteria: snapshot.criteria.map((criterion) => ({
        ...criterion,
        basis: {
          quote: "source-only-details",
          sourceRefs: ["reference://spec/spec-1/issue"],
        },
        requiredEvidenceKinds: ["DOM", "SCREENSHOT", "BUSINESS_REFERENCE"],
      })),
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
            businessReferences: [],
            criteria: expect.arrayContaining([
              expect.objectContaining({
                requiredEvidenceKinds: ["DOM", "SCREENSHOT"],
              }),
            ]),
            executionPolicy: expect.objectContaining({
              hitl: snapshot.executionPolicy.hitl,
            }),
          }),
        }),
      }),
    );
    const runtimeSnapshot =
      tx.agentRuntimeTask.create.mock.calls[0]![0].data.snapshot;
    expect(JSON.stringify(runtimeSnapshot)).not.toContain(
      "source-only-details",
    );
    expect(JSON.stringify(runtimeSnapshot)).not.toContain("reference://");
    expect(tx.runAttempt.create.mock.calls[0]![0].data.inputSnapshot).toEqual(
      runtimeSnapshot,
    );
    expect(
      tx.executionRun.create.mock.calls[0]![0].data.criteriaSnapshot[0].basis
        .quote,
    ).toBe("source-only-details");
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
    Object.assign(existing.executionPolicy, {
      accountRequirements: { version: 2, requirements: [] },
      initialTestAccounts: [],
      testAccounts: [
        {
          slotId: "discovered:1",
          account: "provided-after-creation",
          usage: "READ_EXISTING",
        },
      ],
    });
    await expect(
      service.createForTask(current, input as never, taskId),
    ).resolves.toMatchObject({ id: runId });
    await expect(
      service.createForTask(
        current,
        {
          ...input,
          accountRequirements: {
            version: 2,
            requirements: [],
            definitionHash: "a".repeat(64),
          },
        } as never,
        taskId,
      ),
    ).rejects.toThrow("different run request");
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

  it.each([null, 123, "   ", "a".repeat(201)])(
    "rejects invalid test accounts without requeuing (%s)",
    async (account) => {
      const tx = transactionClient();
      tx.humanIntervention.findFirst.mockResolvedValue(
        intervention({ kind: "TEST_ACCOUNT", browserControlLease: null }),
      );
      const service = new ExecutionRunService(
        {
          $transaction: (callback: (tx: unknown) => unknown) => callback(tx),
        } as never,
        {} as never,
      );
      await expect(
        service.resolveIntervention(current, runId, interventionId, {
          response: { account },
        }),
      ).rejects.toThrow("请填写手机号");
      expect(tx.agentRuntimeTask.update).not.toHaveBeenCalled();
    },
  );

  it("resumes TEST_ACCOUNT from a text answer without browser human control", async () => {
    const tx = transactionClient();
    tx.humanIntervention.findFirst.mockResolvedValue(
      intervention({ kind: "TEST_ACCOUNT", browserControlLease: null }),
    );
    const prisma = {
      $transaction: (callback: (tx: unknown) => unknown) => callback(tx),
      executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
    };
    const service = new ExecutionRunService(prisma as never, {} as never);
    await service.resolveIntervention(current, runId, interventionId, {
      response: { account: "  test-user-uuid  " },
    });
    expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PENDING",
          snapshot: expect.objectContaining({
            executionPolicy: expect.objectContaining({
              resume: expect.objectContaining({
                kind: "TEST_ACCOUNT",
                response: { account: "test-user-uuid" },
              }),
            }),
          }),
        }),
        where: { id: taskId },
      }),
    );
  });

  it("queues an update for the original Feishu card after human completion", async () => {
    const tx = transactionClient();
    tx.humanIntervention.findFirst.mockResolvedValue(
      intervention({
        run: {
          deadlineAt: new Date(snapshot.deadlineAt),
          executionPolicy: {
            ...snapshot.executionPolicy,
            hitl: {
              ...snapshot.executionPolicy.hitl,
              notificationChannels: ["FEISHU"],
            },
          },
          hardDeadlineAt: new Date(snapshot.deadlineAt),
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

    expect(tx.notificationOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        channel: "FEISHU",
        dedupeKey: `run:${runId}:intervention:${interventionId}:resolved:feishu`,
        eventType: "hitl.resolved",
        executionRunId: runId,
        interventionId,
        payload: expect.objectContaining({
          notificationKind: "HITL_RESOLVED",
          resumeStatus: "QUEUED",
        }),
      }),
    });
  });

  it("restarts the configured execution budget instead of only refunding remaining time", async () => {
    const tx = transactionClient();
    const beforeResolve = Date.now();
    const hardDeadlineAt = new Date(beforeResolve + 120_000);
    tx.humanIntervention.findFirst.mockResolvedValue(
      intervention({
        pausedExecutionRemainingMs: 45_000,
        run: {
          executionBudgetSeconds: 600,
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
      beforeResolve + 600_000,
    );
    expect(resumedDeadlineAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 600_000,
    );
    expect(tx.executionRun.updateMany.mock.calls[0]?.[0].data).toMatchObject({
      initialDeadlineAt: resumedDeadlineAt,
      executionBudgetSeconds: 600,
      deadlineExtensionCount: 0,
      deadlineExtendedMs: 0,
      hardDeadlineAt: new Date(resumedDeadlineAt.getTime() + 900_000),
    });
    expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deadlineAt: resumedDeadlineAt }),
      }),
    );
  });

  it("refreshes both the parent window and the full generated-case budget after HITL", async () => {
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
            sourceKind: "TASK_CASE",
            executionBudgetSeconds: 900,
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
            deadlineAt: new Date(now.getTime() + 30 * 60_000),
            hardDeadlineAt: new Date(now.getTime() + 45 * 60_000),
            executionBudgetSeconds: 1800,
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

  it("refreshes the entire configured fixed budget after each distinct intervention", async () => {
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
            executionBudgetSeconds: 600,
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
            deadlineAt: new Date(now.getTime() + 600_000),
            hardDeadlineAt: new Date(now.getTime() + 600_000),
            lifecycle: "QUEUED",
          }),
        }),
      );
      vi.setSystemTime(new Date(now.getTime() + 5 * 60_000));
      const previous = await tx.humanIntervention.findFirst();
      tx.humanIntervention.findFirst.mockResolvedValue({
        ...previous,
        id: "second-intervention",
        expiresAt: new Date(Date.now() + 60_000),
      });
      await service.resolveIntervention(current, runId, "second-intervention", {
        response: { approved: true },
      });
      expect(tx.executionRun.updateMany.mock.calls[1]?.[0].data).toMatchObject({
        deadlineAt: new Date(now.getTime() + 15 * 60_000),
        hardDeadlineAt: new Date(now.getTime() + 15 * 60_000),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps a refreshed budget at the refreshed parent deadline even when refundHumanWait was disabled", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-15T02:00:00.000Z");
    vi.setSystemTime(now);
    try {
      const tx = transactionClient();
      const base = intervention({});
      tx.humanIntervention.findFirst.mockResolvedValue({
        ...base,
        run: {
          ...base.run,
          executionBudgetSeconds: 1800,
          executionPolicy: {
            ...snapshot.executionPolicy,
            deadline: { mode: "ADAPTIVE", refundHumanWait: false },
          },
          taskExecution: {
            id: "parent",
            lifecycle: "WAITING_HUMAN",
            inputSnapshot: {
              idempotencyKey: "short-parent-budget",
              kind: "ISSUE_SPEC",
              issueRef: "ENG-1",
              deadlineSeconds: 120,
            },
          },
        },
      });
      const service = new ExecutionRunService(
        {
          $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
          executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
        } as never,
        {} as never,
      );
      await service.resolveIntervention(current, runId, interventionId, {
        response: {},
      });
      expect(tx.executionRun.updateMany.mock.calls[0]?.[0].data).toMatchObject({
        deadlineAt: new Date(now.getTime() + 120_000),
        hardDeadlineAt: new Date(now.getTime() + 120_000),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([true, false])(
    "handles preserved-session renewal (usable=%s)",
    async (usable) => {
      const tx = transactionClient();
      tx.humanIntervention.findFirst.mockResolvedValue(
        intervention({
          task: { snapshot, fencingToken: 7n },
        }),
      );
      tx.browserExecution.findUnique.mockResolvedValue({
        runtimeSessionId: "old-session",
      } as never);
      tx.browserRuntimeSession.updateMany.mockResolvedValue({
        count: usable ? 1 : 0,
      });
      const service = new ExecutionRunService(
        {
          $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
          executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
        } as never,
        {} as never,
      );
      await service.resolveIntervention(current, runId, interventionId, {
        response: { approved: true },
      });
      expect(tx.browserRuntimeSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "ACTIVE",
            ownerTaskId: taskId,
            ownerFencingToken: 7n,
            quarantinedAt: null,
            closureVerifiedAt: null,
            closedAt: null,
            leaseExpiresAt: { gt: expect.any(Date) },
          }),
        }),
      );
      expect(tx.browserRuntimeSlot.updateMany).toHaveBeenCalledTimes(
        usable ? 1 : 0,
      );
      expect(tx.browserRuntimeProfileLease.updateMany).toHaveBeenCalledTimes(
        usable ? 1 : 0,
      );
      expect(tx.taskCaseExecution.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            scheduling: expect.objectContaining({
              state: usable ? "READY" : "RECOVERING",
              reason: usable ? null : "LEASE_RECOVERY",
            }),
          },
        }),
      );
    },
  );

  it("does not refresh the budget twice for a duplicate human response", async () => {
    const tx = transactionClient();
    tx.humanIntervention.findFirst.mockResolvedValue(
      intervention({ status: "RESOLVED" }),
    );
    const service = new ExecutionRunService(
      {
        $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
        executionRun: { findFirst: vi.fn().mockResolvedValue({ id: runId }) },
      } as never,
      {} as never,
    );
    await service.resolveIntervention(current, runId, interventionId, {
      response: {},
    });
    expect(tx.executionRun.updateMany).not.toHaveBeenCalled();
    expect(tx.agentRuntimeTask.update).not.toHaveBeenCalled();
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
    $queryRaw: vi.fn().mockResolvedValue([]),
    agentRuntimeTask: { update: vi.fn() },
    browserExecution: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    browserRuntimeProfileLease: { updateMany: vi.fn() },
    browserRuntimeSession: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    browserRuntimeSlot: { updateMany: vi.fn() },
    executionRun: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ executionPolicy: {} }),
      update: vi.fn(),
    },
    humanIntervention: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    notificationOutbox: { create: vi.fn() },
    runAttempt: { update: vi.fn() },
    runEvent: { create: vi.fn() },
    taskCaseExecution: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
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

describe("evidence downloads", () => {
  it("opens fresh storage streams for later video ranges and scopes the lookup to the team and run", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValue({ runtimeArtifact: { storageKey: "evidence-key" } });
    const downloadStream = vi.fn().mockResolvedValue({
      body: "stream",
      contentRange: "bytes 100-199/1000",
    });
    const service = new ExecutionRunService(
      { runEvidence: { findFirst } } as never,
      { downloadStream } as never,
    );
    await service.downloadEvidence(current, runId, "evidence-1");
    await service.downloadEvidence(
      current,
      runId,
      "evidence-1",
      "bytes=100-199",
    );
    expect(downloadStream).toHaveBeenLastCalledWith(
      "evidence-key",
      "bytes=100-199",
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "evidence-1", runId, teamId: snapshot.teamId },
      include: { runtimeArtifact: true },
    });
    findFirst.mockResolvedValueOnce(null);
    await expect(
      service.downloadEvidence(current, runId, "other-evidence"),
    ).rejects.toThrow("Evidence not found");
    expect(downloadStream).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported ranges and preserves storage range errors", async () => {
    const service = new ExecutionRunService(
      {
        runEvidence: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ runtimeArtifact: { storageKey: "key" } }),
        },
      } as never,
      {
        downloadStream: vi
          .fn()
          .mockRejectedValue({ $metadata: { httpStatusCode: 416 } }),
      } as never,
    );
    await expect(
      service.downloadEvidence(current, runId, "evidence", "bytes=0-1,4-5"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.downloadEvidence(current, runId, "evidence", "bytes=1000-"),
    ).rejects.toMatchObject({ status: 416 });
  });
});

describe("fallback trajectory identity", () => {
  function event(
    id: string,
    kind: string,
    sequence: number,
    payload: Record<string, unknown> = {},
  ) {
    return {
      actor: "AGENT_RUNTIME",
      id,
      kind,
      sequence: BigInt(sequence),
      occurredAt: new Date(sequence * 1_000),
      payload: {
        segmentId: "segment",
        step: 1,
        model: "primary",
        provider: "OPENAI_COMPATIBLE",
        ...payload,
      },
    };
  }

  it("retains the running fallback after earlier providers fail in the same step, including legacy events", () => {
    const rows = [
      event("a", "agent.model.started", 1),
      event("b", "agent.model.failed", 2, { durationMs: 1_000 }),
      event("c", "agent.model.started", 3, { model: "second" }),
      event("d", "agent.model.failed", 4, {
        model: "second",
        durationMs: 1_000,
      }),
      event("e", "agent.model.started", 5, { model: "third" }),
    ];
    const records = projectRunTrajectory(rows);
    expect(records.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "a", status: "FAILED" },
      { id: "c", status: "FAILED" },
      { id: "e", status: "RUNNING" },
    ]);
  });

  it("does not consume a later legacy candidate with the same model and provider", () => {
    const records = projectRunTrajectory([
      event("a", "agent.model.started", 1),
      event("b", "agent.model.failed", 2),
      event("c", "agent.model.started", 3),
    ]);
    expect(records.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "a", status: "FAILED" },
      { id: "c", status: "RUNNING" },
    ]);
  });

  it("keeps a stable ID when a completion replaces a running call or its start leaves the event page", () => {
    const modelCallId = "4aee646d-2f02-4ec0-8123-a76c09298a79";
    const start = event("a", "agent.model.started", 1, { modelCallId });
    const end = event("b", "agent.model.completed", 2, {
      modelCallId,
      durationMs: 1_000,
    });
    expect(projectRunTrajectory([start])[0]?.id).toBe(modelCallId);
    expect(projectRunTrajectory([start, end])[0]).toMatchObject({
      id: modelCallId,
      status: "SUCCEEDED",
    });
    expect(projectRunTrajectory([end], false)[0]?.id).toBe(modelCallId);
  });

  it("preserves segment errors and settles its interrupted model call", () => {
    const records = projectRunTrajectory([
      event("segment-start", "agent.segment.started", 1),
      event("model-start", "agent.model.started", 2),
      event("segment-end", "agent.segment.completed", 4, {
        status: "FAILED",
        durationMs: 3_000,
        errorMessage: "Deployment interrupted execution",
      }),
    ]);
    expect(records.find((r) => r.id === "model-start")).toMatchObject({
      status: "FAILED",
      durationMs: 2_000,
      completedAt: new Date(4_000).toISOString(),
      error: "Deployment interrupted execution",
    });
    expect(records.find((r) => r.id === "segment-end")).toMatchObject({
      kind: "RUNTIME",
      status: "FAILED",
      error: "Deployment interrupted execution",
    });
  });
});
