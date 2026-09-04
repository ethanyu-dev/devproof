import { describe, expect, it, vi } from "vitest";

import { runtimeTaskSnapshotSchema } from "@devproof/agent-runtime-protocol";

import {
  AgentRuntimeTaskService,
  completedOutcomeEvidenceError,
  deadlinePolicyPausesHumanWait,
  decideAdaptiveDeadlineExtension,
  hitlWaitDeadline,
  initializeExecutionBudget,
  leaseRecoveryDecision,
} from "./agent-runtime-task.service.js";

const snapshot = runtimeTaskSnapshotSchema.parse({
  attemptId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
  attemptNumber: 1,
  businessReferences: [
    {
      externalId: "reference://spec/spec-1/issue",
      kind: "BUSINESS_REFERENCE",
      label: "ENG-1",
      metadata: {},
    },
  ],
  criteria: [
    {
      description: "The page matches the source requirement.",
      id: "expected-1",
      required: true,
      requiredEvidenceKinds: ["SCREENSHOT", "BUSINESS_REFERENCE"],
    },
  ],
  deadlineAt: new Date().toISOString(),
  environment: {},
  executionPolicy: {},
  goal: "Verify ENG-1.",
  runId: "285146a8-5230-4b02-832a-5eef19e8dc8a",
  teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
  traceId: "1234567890abcdef1234567890abcdef",
});

describe("Agent Runtime ownership and recovery", () => {
  it.each([
    { potentialWrites: 0, casCount: 1, expected: "RETRY_SCHEDULED" },
    { potentialWrites: 1, casCount: 1, expected: "WRITE_OUTCOME_UNKNOWN" },
    { potentialWrites: 0, casCount: 0, expected: "RACE_LOST" },
  ])(
    "recovers a reserved writer without trapping its new Attempt behind old data locks: $expected",
    async ({ potentialWrites, casCount, expected }) => {
      const deadlineAt = new Date(Date.now() + 120_000);
      const task = {
        id: "task-1",
        status: "FAILED",
        recoveryStatus: "CLOSING",
        attemptId: snapshot.attemptId,
        runId: snapshot.runId,
        capability: "browser.verification",
        provider: "GENERIC",
        snapshot: {
          ...snapshot,
          deadlineAt: deadlineAt.toISOString(),
          executionPolicy: {
            retryPolicy: { maxAttempts: 3, retryOn: ["RUNTIME_LOST"] },
            browser: {
              availabilityPolicy: "WAIT",
              profile: { mode: "EPHEMERAL" },
              requiredCapabilities: ["browser"],
            },
          },
        },
        attempt: {
          number: 1,
          browserExecution: {
            id: "execution-1",
            runtimeSessionId: "session-1",
          },
        },
        run: {
          teamId: snapshot.teamId,
          lifecycle: "RUNNING",
          deadlineAt,
          hardDeadlineAt: deadlineAt,
          cancelRequestedAt: null,
          infrastructureRecoveryCount: 0,
          maxAttempts: 3,
          concurrencyPolicy: { accessMode: "MUTATING" },
        },
      };
      const session = { status: "CLOSED", closureVerifiedAt: new Date() };
      const tx = {
        agentRuntimeTask: {
          findFirst: vi.fn().mockResolvedValue(task),
          updateMany: vi.fn().mockResolvedValue({ count: casCount }),
          create: vi.fn().mockResolvedValue({}),
        },
        browserRuntimeSession: {
          findUnique: vi.fn().mockResolvedValue(session),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        browserRuntimeCommand: {
          count: vi.fn().mockResolvedValue(potentialWrites),
        },
        executionResourceLease: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        executionRun: { update: vi.fn().mockResolvedValue({}) },
        runAttempt: { create: vi.fn().mockResolvedValue({}) },
        browserExecution: { create: vi.fn().mockResolvedValue({}) },
        runEvent: { create: vi.fn().mockResolvedValue({}) },
        taskCaseExecution: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const prisma = {
        agentRuntimeTask: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([task]),
        },
        browserRuntimeCommand: {
          count: vi.fn().mockResolvedValue(potentialWrites),
        },
        browserRuntimeSession: {
          findUnique: vi.fn().mockResolvedValue(session),
        },
        executionResourceLease: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
      };
      const browser = {
        releaseForExecutionRun: vi.fn().mockResolvedValue(undefined),
      };
      const service = new AgentRuntimeTaskService(
        prisma as never,
        {} as never,
        browser as never,
      );
      await service.recoverExpiredLeases();
      expect(
        tx.browserRuntimeCommand.count.mock.calls[0]![0].where,
      ).not.toHaveProperty("source");
      if (expected === "RETRY_SCHEDULED") {
        expect(tx.executionResourceLease.deleteMany).toHaveBeenCalledWith({
          where: { sessionId: "session-1" },
        });
        expect(tx.agentRuntimeTask.create).toHaveBeenCalledOnce();
        expect(tx.browserExecution.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: "REQUESTED" }),
          }),
        );
        expect(
          tx.executionResourceLease.deleteMany.mock.invocationCallOrder[0],
        ).toBeGreaterThan(
          tx.agentRuntimeTask.updateMany.mock.invocationCallOrder[0]!,
        );
        expect(
          tx.executionResourceLease.deleteMany.mock.invocationCallOrder[0],
        ).toBeLessThan(tx.agentRuntimeTask.create.mock.invocationCallOrder[0]!);
      } else {
        expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
        expect(tx.agentRuntimeTask.create).not.toHaveBeenCalled();
      }
      if (expected === "WRITE_OUTCOME_UNKNOWN")
        expect(tx.agentRuntimeTask.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ recoveryStatus: expected }),
          }),
        );
    },
  );

  it("does not retry a failed write whose browser response may have been lost", async () => {
    const now = new Date();
    const task = {
      id: "task-1",
      attemptId: snapshot.attemptId,
      runId: snapshot.runId,
      snapshot,
      status: "RUNNING",
      completionId: null,
      leaseOwner: "worker-1",
      leaseToken: "token-1",
      fencingToken: 2n,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      attempt: { number: 1 },
      run: {
        lifecycle: "RUNNING",
        cancelRequestedAt: null,
        taskExecutionId: null,
        currentAttemptNumber: 1,
        concurrencyPolicy: { accessMode: "MUTATING" },
        executionPolicy: {
          retryPolicy: { maxAttempts: 3, retryOn: ["PROVIDER"] },
          deadline: { mode: "FIXED" },
        },
      },
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ now }]),
      agentRuntimeTask: {
        findFirst: vi.fn().mockResolvedValue(task),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue({
          completionId: "completion-1",
          recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
        }),
        create: vi.fn(),
      },
      browserRuntimeCommand: { count: vi.fn().mockResolvedValue(1) },
      executionResourceLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn(),
      },
      runAttempt: { update: vi.fn().mockResolvedValue({}) },
      executionRun: { update: vi.fn().mockResolvedValue({}) },
      runEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const service = new AgentRuntimeTaskService(prisma as never, {} as never);
    const result = await service.submitOutcome(snapshot.teamId, task.id, {
      workerId: "worker-1",
      leaseToken: "token-1",
      fencingToken: "2",
      completionId: "completion-1",
      completedAt: now.toISOString(),
      outcome: {
        kind: "RETRYABLE_FAILURE",
        executionDisposition: "PROVIDER_ERROR",
        error: {
          code: "PROVIDER_DISCONNECTED",
          failureClass: "PROVIDER",
          message: "response lost",
          phase: "browser_verification",
          details: {},
        },
        summary: "execution interrupted",
      },
    });
    expect(result.nextAttemptScheduled).toBe(false);
    expect(tx.agentRuntimeTask.create).not.toHaveBeenCalled();
    expect(tx.executionRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycle: "COMPLETED",
          verdict: null,
          executionDisposition: "BLOCKED",
        }),
      }),
    );
    expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
        }),
      }),
    );
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
  });

  it("does not acknowledge renewal when another owner wins after the lease read", async () => {
    const now = new Date();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ now }]),
      agentRuntimeTask: {
        findFirst: vi.fn().mockResolvedValue({
          id: "task-1",
          status: "RUNNING",
          leaseOwner: "worker-1",
          leaseToken: "token-1",
          fencingToken: 2n,
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          cancelRequestedAt: null,
          run: {
            cancelRequestedAt: null,
            deadlineAt: new Date(now.getTime() + 60_000),
            hardDeadlineAt: new Date(now.getTime() + 60_000),
            lifecycle: "RUNNING",
          },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      browserRuntimeSession: { updateMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const service = new AgentRuntimeTaskService(prisma as never, {} as never);
    await expect(
      service.heartbeat("team-1", "task-1", {
        workerId: "worker-1",
        leaseToken: "token-1",
        fencingToken: "2",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.agentRuntimeTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fencingToken: 2n,
          leaseToken: "token-1",
          leaseOwner: "worker-1",
          leaseExpiresAt: { gt: now },
        }),
      }),
    );
    expect(tx.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
  });

  it("uses a new bounded Attempt only after closure and never replays uncertain writes", () => {
    const base = {
      closed: true,
      unknownWrite: false,
      expired: false,
      infrastructureRecoveries: 0,
      attemptNumber: 1,
      maxAttempts: 3,
    };
    expect(leaseRecoveryDecision(base)).toBe("RETRY_SCHEDULED");
    expect(
      leaseRecoveryDecision({ ...base, infrastructureRecoveries: 1 }),
    ).toBe("EXHAUSTED");
    expect(leaseRecoveryDecision({ ...base, attemptNumber: 3 })).toBe(
      "EXHAUSTED",
    );
    expect(leaseRecoveryDecision({ ...base, closed: false })).toBe("EXHAUSTED");
    expect(leaseRecoveryDecision({ ...base, unknownWrite: true })).toBe(
      "WRITE_OUTCOME_UNKNOWN",
    );
  });

  it("starts execution time at first claim while preserving the parent deadline", () => {
    const now = new Date("2026-09-04T08:00:00Z");
    expect(
      initializeExecutionBudget({
        now,
        seconds: 60,
        extensionSeconds: 30,
        parentDeadlineAt: null,
      }),
    ).toEqual({
      deadlineAt: new Date("2026-09-04T08:01:00Z"),
      hardDeadlineAt: new Date("2026-09-04T08:01:30Z"),
    });
    expect(
      initializeExecutionBudget({
        now,
        seconds: 60,
        extensionSeconds: 30,
        parentDeadlineAt: new Date("2026-09-04T08:00:45Z"),
      }),
    ).toEqual({
      deadlineAt: new Date("2026-09-04T08:00:45Z"),
      hardDeadlineAt: new Date("2026-09-04T08:00:45Z"),
    });
  });
});

function outcome(evidenceRefs: string[]) {
  return {
    criteria: [
      {
        criterionId: "expected-1",
        evidenceRefs,
        status: "PASSED" as const,
        summary: "Verified.",
      },
    ],
    evidence: snapshot.businessReferences,
    executionDisposition: "EXECUTED" as const,
    kind: "VERIFICATION_COMPLETED" as const,
    summary: "Verified.",
    verdict: "PASSED" as const,
  };
}

describe("AgentRuntimeTaskService completed evidence validation", () => {
  it("accepts explicit inconclusive criteria when no acceptance evidence was obtained", () => {
    const unfinished = {
      ...outcome([]),
      criteria: [
        {
          criterionId: "expected-1",
          evidenceRefs: [],
          status: "INCONCLUSIVE" as const,
          summary: "验证停滞，尚未取得足以判断此验收项的证据。",
        },
      ],
      verdict: "INCONCLUSIVE" as const,
    };
    expect(completedOutcomeEvidenceError(snapshot, unfinished, [])).toBeNull();
    expect(
      completedOutcomeEvidenceError(
        snapshot,
        { ...unfinished, criteria: [] },
        [],
      ),
    ).toContain("missing required criterion");
    expect(completedOutcomeEvidenceError(snapshot, outcome([]), [])).toContain(
      "missing required evidence kinds",
    );
  });

  it("rejects a passing result missing a required evidence kind", () => {
    expect(
      completedOutcomeEvidenceError(
        snapshot,
        outcome(["artifact://11111111-1111-4111-8111-111111111111"]),
        [
          {
            externalId: "artifact://11111111-1111-4111-8111-111111111111",
            kind: "SCREENSHOT",
            label: "",
            metadata: {},
          },
        ],
      ),
    ).toContain("BUSINESS_REFERENCE");
  });

  it("accepts a passing result with every required evidence kind", () => {
    expect(
      completedOutcomeEvidenceError(
        snapshot,
        outcome([
          "artifact://11111111-1111-4111-8111-111111111111",
          "reference://spec/spec-1/issue",
        ]),
        [
          {
            externalId: "artifact://11111111-1111-4111-8111-111111111111",
            kind: "SCREENSHOT",
            label: "",
            metadata: {},
          },
        ],
      ),
    ).toBeNull();
  });

  it("rejects evidence whose kind was invented by the Agent", () => {
    const fabricated = {
      ...outcome(["artifact://fake"]),
      evidence: [
        ...outcome([]).evidence,
        {
          externalId: "artifact://fake",
          kind: "SCREENSHOT" as const,
          label: "Fabricated",
          metadata: {},
        },
      ],
    };
    expect(completedOutcomeEvidenceError(snapshot, fabricated, [])).toContain(
      "untrusted evidence",
    );
  });
});

describe("AgentRuntimeTaskService Runtime model configuration", () => {
  it("rejects workers that cannot consume Console-managed model credentials", async () => {
    const agentModels = { candidatesForPool: vi.fn() };
    const service = new AgentRuntimeTaskService(
      {} as never,
      agentModels as never,
    );

    await expect(
      service.claim(snapshot.teamId, {
        capabilities: ["BROWSER_VERIFICATION"],
        protocol: {
          major: 2,
          minor: 1,
          name: "devproof-agent-runtime",
        },
        workerId: "legacy-worker",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(agentModels.candidatesForPool).not.toHaveBeenCalled();
  });

  it("injects the team's ordered encrypted model configuration", async () => {
    const leaseToken = "70844616-602c-475b-95f6-393015b82ed1";
    const task = {
      attemptId: snapshot.attemptId,
      fencingToken: 4n,
      id: "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken,
      run: { startedAt: null, deadlineAt: new Date(Date.now() + 60_000) },
      runId: snapshot.runId,
      snapshot,
    };
    const tx = {
      browserExecution: {
        findUnique: vi.fn().mockResolvedValue({
          runtimeSessionId: "session-1",
          status: "ACTIVE",
        }),
      },
      browserRuntimeSession: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ now: new Date() }]),
      agentRuntimeTask: {
        findFirst: vi.fn().mockResolvedValue({
          id: task.id,
          startedAt: null,
        }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(task),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      executionRun: { update: vi.fn().mockResolvedValue({}) },
      runAttempt: { update: vi.fn().mockResolvedValue({}) },
      runEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const modelCandidates = [
      {
        apiKey: "sk-primary",
        baseUrl: "https://primary.example.com/v1",
        displayName: "Primary",
        modelId: "gpt-primary",
      },
      {
        apiKey: "sk-fallback",
        baseUrl: "https://fallback.example.com/v1",
        displayName: "Fallback",
        modelId: "gpt-fallback",
      },
    ];
    const agentModels = {
      candidatesForPool: vi.fn().mockResolvedValue(modelCandidates),
    };
    const service = new AgentRuntimeTaskService(
      prisma as never,
      agentModels as never,
    );

    const result = await service.claim(snapshot.teamId, {
      capabilities: ["BROWSER_VERIFICATION"],
      protocol: {
        major: 2,
        minor: 2,
        name: "devproof-agent-runtime",
      },
      workerId: "worker-1",
    });

    expect(agentModels.candidatesForPool).toHaveBeenCalledWith(
      snapshot.teamId,
      "BROWSER_EXECUTION",
    );
    expect(result.task?.snapshot.modelCandidates).toEqual(modelCandidates);
  });
});

const adaptivePolicy = {
  extensionStepSeconds: 180,
  finalizationReserveSeconds: 60,
  maxExtensionSeconds: 900,
  maxModelCallSeconds: 300,
  mode: "ADAPTIVE" as const,
  refundHumanWait: true,
  slowModelThresholdSeconds: 60,
};

describe("HITL wait deadline", () => {
  const requestedAtMs = Date.parse("2026-08-28T02:00:00.000Z");

  it("pauses execution for fixed deadlines and refundable adaptive deadlines", () => {
    expect(deadlinePolicyPausesHumanWait({ mode: "FIXED" })).toBe(true);
    expect(
      deadlinePolicyPausesHumanWait({
        ...adaptivePolicy,
        refundHumanWait: true,
      }),
    ).toBe(true);
    expect(
      deadlinePolicyPausesHumanWait({
        ...adaptivePolicy,
        refundHumanWait: false,
      }),
    ).toBe(false);
  });

  it("uses the independent HITL timeout when human wait is refundable", () => {
    expect(
      hitlWaitDeadline({
        currentDeadlineAtMs: requestedAtMs + 60_000,
        pauseHumanWait: true,
        policyTimeoutSeconds: 3_600,
        requestedAtMs,
      }).toISOString(),
    ).toBe("2026-08-28T03:00:00.000Z");
  });

  it("keeps the execution deadline as the cap when pausing is disabled", () => {
    expect(
      hitlWaitDeadline({
        currentDeadlineAtMs: requestedAtMs + 60_000,
        pauseHumanWait: false,
        policyTimeoutSeconds: 3_600,
        requestedAtMs,
      }).toISOString(),
    ).toBe("2026-08-28T02:01:00.000Z");
  });

  it("honors an earlier Runtime-requested intervention expiry", () => {
    expect(
      hitlWaitDeadline({
        currentDeadlineAtMs: requestedAtMs + 60_000,
        pauseHumanWait: true,
        policyTimeoutSeconds: 3_600,
        requestedAtMs,
        requestedExpiresAtMs: requestedAtMs + 30_000,
      }).toISOString(),
    ).toBe("2026-08-28T02:00:30.000Z");
  });
});

function adaptiveState(
  overrides: Partial<
    Parameters<typeof decideAdaptiveDeadlineExtension>[0]
  > = {},
) {
  const nowMs = Date.parse("2026-08-24T01:00:00.000Z");
  return {
    activeOperation: "MODEL",
    activeOperationKey: "segment-1:4",
    activeOperationStartedAtMs: nowMs - 75_000,
    deadlineAtMs: nowMs + 45_000,
    hardDeadlineAtMs: nowMs + 900_000,
    lastDeadlineExtensionOperationKey: null,
    lastModelCompletedAtMs: null,
    lastModelLatencyMs: null,
    lastModelOperationKey: null,
    modelLatencyEwmaMs: null,
    nowMs,
    policy: adaptivePolicy,
    ...overrides,
  };
}

describe("adaptive Runtime deadline decisions", () => {
  it("does not treat a failed model response as recent progress for a deadline extension", async () => {
    const now = new Date("2026-08-24T01:00:00.000Z");
    const task = {
      id: "task-1",
      attemptId: snapshot.attemptId,
      runId: snapshot.runId,
      status: "RUNNING",
      fencingToken: 1n,
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      modelLatencyEwmaMs: 40_000,
      modelLatencyMaxMs: 50_000,
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ now }]),
      agentRuntimeTask: {
        findFirst: vi.fn().mockResolvedValue(task),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      runEvent: {
        create: vi.fn().mockResolvedValue({ createdAt: now, sequence: 1n }),
      },
    };
    const service = new AgentRuntimeTaskService(
      {
        $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
      } as never,
      {} as never,
      {} as never,
    );
    await service.appendEvent(snapshot.teamId, task.id, {
      fencingToken: "1",
      leaseToken: "lease-1",
      workerId: "worker-1",
      event: {
        eventId: "model-failure",
        occurredAt: now.toISOString(),
        kind: "agent.model.failed",
        payload: {
          attemptNumber: 1,
          segmentId: "segment-1",
          step: 5,
          durationMs: 42_000,
          errorMessage: "Model request timed out.",
          inputPreview: {},
          model: "test-model",
          provider: "test-provider",
        },
      },
    });
    const progress = tx.agentRuntimeTask.update.mock.calls[0]![0].data;
    expect(progress.lastModelLatencyMs).toBe(42_000);
    expect(progress.lastModelCompletedAt).toBeNull();
    expect(progress.lastModelOperationKey).toBeNull();
    expect(
      decideAdaptiveDeadlineExtension(
        adaptiveState({
          activeOperation: progress.activeOperation,
          activeOperationKey: progress.activeOperationKey,
          activeOperationStartedAtMs: null,
          lastModelCompletedAtMs: progress.lastModelCompletedAt,
          lastModelLatencyMs: progress.lastModelLatencyMs,
          lastModelOperationKey: progress.lastModelOperationKey,
        }),
      ),
    ).toBeNull();
  });

  it("extends a near deadline while a model call is observably slow", () => {
    const extension = decideAdaptiveDeadlineExtension(adaptiveState());

    expect(extension).toMatchObject({
      activeModelElapsedMs: 75_000,
      extendedByMs: 180_000,
      operationKey: "segment-1:4",
      trigger: "ACTIVE_SLOW_MODEL",
    });
  });

  it("extends a near deadline after recent model progress below the slow threshold", () => {
    const state = adaptiveState({
      activeOperation: null,
      activeOperationKey: null,
      activeOperationStartedAtMs: null,
      deadlineAtMs: Date.parse("2026-08-24T01:02:00.000Z"),
      lastModelCompletedAtMs: Date.parse("2026-08-24T00:59:59.000Z"),
      lastModelLatencyMs: 42_000,
      lastModelOperationKey: "segment-1:5",
    });

    expect(decideAdaptiveDeadlineExtension(state)).toMatchObject({
      extendedByMs: 180_000,
      operationKey: "segment-1:5",
      trigger: "RECENT_MODEL_PROGRESS",
    });
  });

  it("does not extend for stale completed model progress", () => {
    const state = adaptiveState({
      activeOperation: null,
      activeOperationKey: null,
      activeOperationStartedAtMs: null,
      lastModelCompletedAtMs: Date.parse("2026-08-24T00:54:59.000Z"),
      lastModelLatencyMs: 42_000,
      lastModelOperationKey: "segment-1:5",
    });

    expect(decideAdaptiveDeadlineExtension(state)).toBeNull();
  });

  it("does not spend extension budget when there is ample time", () => {
    expect(
      decideAdaptiveDeadlineExtension(
        adaptiveState({ deadlineAtMs: Date.parse("2026-08-24T01:10:00.000Z") }),
      ),
    ).toBeNull();
  });

  it("extends at most once for the same model operation", () => {
    expect(
      decideAdaptiveDeadlineExtension(
        adaptiveState({
          lastDeadlineExtensionOperationKey: "segment-1:4",
        }),
      ),
    ).toBeNull();
  });

  it("never extends beyond the hard deadline", () => {
    const state = adaptiveState({
      hardDeadlineAtMs: Date.parse("2026-08-24T01:01:30.000Z"),
    });

    expect(decideAdaptiveDeadlineExtension(state)?.deadlineAtMs).toBe(
      state.hardDeadlineAtMs,
    );
  });

  it("does not resurrect an already expired run", () => {
    const nowMs = Date.parse("2026-08-24T01:00:00.000Z");
    expect(
      decideAdaptiveDeadlineExtension(
        adaptiveState({ deadlineAtMs: nowMs, nowMs }),
      ),
    ).toBeNull();
  });
});
