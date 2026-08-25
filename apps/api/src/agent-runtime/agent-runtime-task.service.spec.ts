import { describe, expect, it, vi } from "vitest";

import { runtimeTaskSnapshotSchema } from "@devproof/agent-runtime-protocol";

import {
  AgentRuntimeTaskService,
  completedOutcomeEvidenceError,
  decideAdaptiveDeadlineExtension,
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
    const agentModels = { candidatesForTeam: vi.fn() };
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
    expect(agentModels.candidatesForTeam).not.toHaveBeenCalled();
  });

  it("injects the team's ordered encrypted model configuration", async () => {
    const leaseToken = "70844616-602c-475b-95f6-393015b82ed1";
    const task = {
      attemptId: snapshot.attemptId,
      fencingToken: 4n,
      id: "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken,
      run: { startedAt: null },
      runId: snapshot.runId,
      snapshot,
    };
    const tx = {
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
      candidatesForTeam: vi.fn().mockResolvedValue(modelCandidates),
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

    expect(agentModels.candidatesForTeam).toHaveBeenCalledWith(snapshot.teamId);
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
