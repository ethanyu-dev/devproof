import { describe, expect, it } from "vitest";

import {
  agentProviderSchema,
  browserExecutionCriterion,
  browserExecutionSnapshot,
  missingRequiredEvidenceKinds,
  runtimeBrowserAcquireOutputSchema,
  runtimeCriterionSchema,
  runtimeModelCandidateSchema,
  runtimeOutcomeSchema,
  runtimeRegistrationInputSchema,
  runtimeRegistrationOutputSchema,
  runtimeSpecAnalysisOutcomeSchema,
  runtimeSpecAnalysisTaskLeaseSchema,
  runtimeSpecAnalysisToolNameSchema,
  runtimeTaskSnapshotSchema,
  runtimeTaskLeaseSchema,
  runtimeTraceEventSchema,
} from "./index.js";

describe("agent runtime protocol", () => {
  it("removes analysis provenance at the browser lease boundary without changing stored input", () => {
    const stored = runtimeTaskSnapshotSchema.parse({
      attemptId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      attemptNumber: 1,
      businessReferences: [
        {
          externalId: "reference://spec/source",
          kind: "BUSINESS_REFERENCE",
          metadata: { excerpt: "private source code" },
        },
      ],
      criteria: [
        {
          id: "visible",
          description: "类型下拉显示合规模型映射。",
          basis: {
            quote: "analysis rationale",
            sourceRefs: ["reference://spec/source"],
          },
          observationTargets: [
            { label: "类型下拉", expectedText: "合规模型映射" },
          ],
          requireObservedEvidence: true,
          requiredEvidenceKinds: ["DOM", "SCREENSHOT", "BUSINESS_REFERENCE"],
        },
      ],
      deadlineAt: new Date().toISOString(),
      goal: "核对白名单类型。",
      runId: "285146a8-5230-4b02-832a-5eef19e8dc8a",
      teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
      traceId: "1234567890abcdef1234567890abcdef",
      executionPolicy: { resume: { response: { account: "test-account" } } },
    });
    stored.executionPolicy.accountRequirements = {
      version: 2,
      requirements: [
        {
          role: "subject",
          label: "白名单用户",
          usage: "READ_EXISTING",
          rationale: "核对业务用户",
          subjectBinding: {
            kind: "BUSINESS_INPUT",
            target: "用户 ID",
            stepOrders: [1],
            basis: {
              sourceRef: "analysis-source://private",
              quote: "private source code",
            },
          },
        },
      ],
    };
    const before = runtimeTaskSnapshotSchema.parse(stored);
    const lease = runtimeTaskLeaseSchema.parse({
      taskId: "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0",
      fencingToken: "1",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      leaseExpiresAt: new Date().toISOString(),
      snapshot: stored,
    });
    expect(lease.snapshot.businessReferences).toEqual([]);
    expect(lease.snapshot.criteria[0]).toEqual({
      id: "visible",
      description: "类型下拉显示合规模型映射。",
      required: true,
      requireObservedEvidence: true,
      observationTargets: before.criteria[0]!.observationTargets,
      requiredEvidenceKinds: ["DOM", "SCREENSHOT"],
    });
    expect(lease.snapshot.executionPolicy.resume).toEqual(
      before.executionPolicy.resume,
    );
    expect(lease.snapshot.executionPolicy.accountRequirements).toMatchObject({
      version: 2,
      requirements: [
        {
          subjectBinding: {
            kind: "BUSINESS_INPUT",
            target: "用户 ID",
            stepOrders: [1],
          },
        },
      ],
    });
    expect(JSON.stringify(lease.snapshot)).not.toMatch(
      /private source code|analysis rationale|reference:\/\/|analysis-source:\/\//u,
    );
    expect(stored).toEqual(before);
    expect(browserExecutionSnapshot(lease.snapshot)).toEqual(lease.snapshot);
  });

  it("requires actual browser evidence for a legacy source-only criterion", () => {
    const criterion = runtimeCriterionSchema.parse({
      id: "legacy",
      description: "The page matches the requirement.",
      requiredEvidenceKinds: ["BUSINESS_REFERENCE"],
    });
    expect(browserExecutionCriterion(criterion).requiredEvidenceKinds).toEqual([
      "DOM",
      "SCREENSHOT",
    ]);
    expect(
      missingRequiredEvidenceKinds(
        browserExecutionCriterion(criterion),
        [],
        [],
      ),
    ).toEqual(["DOM", "SCREENSHOT"]);
  });

  it("accepts negotiated check references and legacy Spec generation formats", () => {
    const format = runtimeSpecAnalysisTaskLeaseSchema.shape.snapshot.pick({
      specFormat: true,
    });
    expect(format.parse({})).toEqual({});
    for (const specFormat of ["COMPACT", "CHECK_REFERENCES"])
      expect(format.parse({ specFormat })).toEqual({ specFormat });
    expect(format.safeParse({ specFormat: "UNKNOWN" }).success).toBe(false);
  });

  it("rejects the retired knowledge tool while accepting Issue and GitHub tools", () => {
    expect(
      runtimeSpecAnalysisToolNameSchema.safeParse("knowledge_search").success,
    ).toBe(false);
    for (const name of [
      "linear_get_issue",
      "github_get_pull_request",
      "github_list_changed_files",
      "github_read_file",
      "github_search_code",
    ]) {
      expect(runtimeSpecAnalysisToolNameSchema.parse(name)).toBe(name);
    }
  });

  it("keeps Spec lease clock metadata optional during rolling upgrades", () => {
    const clockFields = runtimeSpecAnalysisTaskLeaseSchema.pick({
      leaseExpiresAt: true,
      serverTime: true,
      leaseDurationMs: true,
    });
    const leaseExpiresAt = "2026-09-04T01:01:00.000Z";
    expect(clockFields.parse({ leaseExpiresAt })).toEqual({ leaseExpiresAt });
    expect(
      clockFields.parse({
        leaseExpiresAt,
        serverTime: "2026-09-04T01:00:00.000Z",
        leaseDurationMs: 60_000,
      }),
    ).toMatchObject({
      serverTime: "2026-09-04T01:00:00.000Z",
      leaseDurationMs: 60_000,
    });
  });
  it("uses a generic extension point for custom model providers", () => {
    expect(agentProviderSchema.parse("CUSTOM")).toBe("CUSTOM");
  });

  it("accepts registration without retired analysis capacity", () => {
    expect(
      runtimeRegistrationOutputSchema.parse({
        browserConcurrency: 2,
        pools: ["BROWSER_EXECUTION"],
        refreshAfterMs: 5_000,
        specConcurrency: 0,
      }),
    ).not.toHaveProperty("analysisConcurrency");
  });

  it("registers a v9 Runtime with one declared pool", () => {
    expect(
      runtimeRegistrationInputSchema.parse({
        pool: "SPEC_ANALYSIS",
        protocol: {
          major: 2,
          minor: 9,
          name: "devproof-agent-runtime",
        },
        workerId: "spec-runtime-1",
      }).pool,
    ).toBe("SPEC_ANALYSIS");
    expect(
      runtimeRegistrationInputSchema.safeParse({
        pool: "MIXED",
        protocol: {
          major: 2,
          minor: 9,
          name: "devproof-agent-runtime",
        },
        workerId: "mixed-runtime",
      }).success,
    ).toBe(false);
  });

  it("validates an OpenAI-compatible model candidate", () => {
    expect(
      runtimeModelCandidateSchema.parse({
        apiKey: "sk-secret",
        baseUrl: "https://gateway.example.com/v1",
        displayName: "Primary model",
        modelId: "provider/model-1",
      }),
    ).toEqual({
      apiKey: "sk-secret",
      baseUrl: "https://gateway.example.com/v1",
      displayName: "Primary model",
      modelId: "provider/model-1",
    });
  });

  it("keeps infrastructure failures separate from product verdicts", () => {
    const outcome = runtimeOutcomeSchema.parse({
      error: {
        code: "PROVIDER_STREAM_DISCONNECTED",
        failureClass: "PROVIDER",
        message: "The provider stream closed before the agent completed.",
      },
      executionDisposition: "PROVIDER_ERROR",
      kind: "RETRYABLE_FAILURE",
      summary: "The verification was not executed.",
    });

    expect(outcome).not.toHaveProperty("verdict");
  });

  it("rejects a passing verdict when a criterion did not pass", () => {
    expect(
      runtimeOutcomeSchema.safeParse({
        criteria: [
          {
            criterionId: "page-visible",
            status: "INCONCLUSIVE",
            summary: "The browser did not become available.",
          },
        ],
        executionDisposition: "EXECUTED",
        kind: "VERIFICATION_COMPLETED",
        summary: "No conclusive result.",
        verdict: "PASSED",
      }).success,
    ).toBe(false);
  });

  it("accepts a coherent completed verification", () => {
    const outcome = runtimeOutcomeSchema.parse({
      criteria: [
        {
          criterionId: "page-visible",
          evidenceRefs: ["artifact-1"],
          status: "PASSED",
          summary: "The page is visible.",
        },
      ],
      evidence: [{ externalId: "artifact-1", kind: "SCREENSHOT" }],
      executionDisposition: "EXECUTED",
      kind: "VERIFICATION_COMPLETED",
      summary: "All required criteria passed.",
      verdict: "PASSED",
    });

    expect(outcome.kind).toBe("VERIFICATION_COMPLETED");
    if (outcome.kind !== "VERIFICATION_COMPLETED") {
      throw new Error("Expected a completed verification outcome.");
    }
    expect(outcome.verdict).toBe("PASSED");
  });

  it("preserves the locator recovery stop reason without requiring it from older agents", () => {
    const outcome = {
      criteria: [
        {
          criterionId: "settings-visible",
          status: "INCONCLUSIVE",
          summary: "The target could not be resolved after two retargets.",
        },
      ],
      executionDisposition: "EXECUTED",
      kind: "VERIFICATION_COMPLETED",
      summary: "Locator recovery was exhausted.",
      verdict: "INCONCLUSIVE",
    };
    expect(runtimeOutcomeSchema.parse(outcome)).not.toHaveProperty(
      "termination",
    );
    expect(
      runtimeOutcomeSchema.parse({
        ...outcome,
        termination: { reason: "LOCATOR_RECOVERY_EXHAUSTED" },
      }),
    ).toHaveProperty("termination.reason", "LOCATOR_RECOVERY_EXHAUSTED");
    expect(
      runtimeOutcomeSchema.safeParse({
        ...outcome,
        termination: { reason: "UNKNOWN_REASON" },
      }).success,
    ).toBe(false);
  });

  it("represents browser capacity waits without failing the Runtime task", () => {
    expect(
      runtimeBrowserAcquireOutputSchema.parse({
        browserExecutionId: "ab91fa7b-afd8-42be-982b-e860de0fca67",
        reason: "NO_AVAILABLE_SLOT",
        retryAfterMs: 2_000,
        status: "WAITING_CAPACITY",
      }),
    ).toEqual(
      expect.objectContaining({
        reason: "NO_AVAILABLE_SLOT",
        status: "WAITING_CAPACITY",
      }),
    );
  });

  it("keeps old criteria compatible while supporting typed evidence requirements", () => {
    expect(
      runtimeCriterionSchema.parse({
        description: "The page is visible.",
        id: "page-visible",
      }),
    ).toMatchObject({ requiredEvidenceKinds: [] });

    const basis = {
      observationTarget: "类型下拉",
      quote: "需求中的实际类型名称",
      sourceRefs: ["reference://task/source"],
    };
    expect(
      runtimeCriterionSchema.parse({
        description: "类型下拉中可以找到指定类型。",
        id: "type-visible",
        basis,
      }).basis,
    ).toEqual(basis);

    expect(
      missingRequiredEvidenceKinds(
        runtimeCriterionSchema.parse({
          description: "The page and source rule are verified.",
          id: "page-visible",
          requiredEvidenceKinds: ["SCREENSHOT", "BUSINESS_REFERENCE"],
        }),
        ["artifact://screen"],
        [
          {
            externalId: "artifact://screen",
            kind: "SCREENSHOT",
            label: "",
            metadata: {},
          },
        ],
      ),
    ).toEqual(["BUSINESS_REFERENCE"]);
  });

  it("defaults business references for snapshots created by older producers", () => {
    const parsed = runtimeTaskSnapshotSchema.parse({
      attemptId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      attemptNumber: 1,
      criteria: [
        { description: "The page is visible.", id: "visible", required: true },
      ],
      deadlineAt: new Date().toISOString(),
      environment: {},
      executionPolicy: {},
      goal: "Verify the page.",
      runId: "285146a8-5230-4b02-832a-5eef19e8dc8a",
      teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
      traceId: "1234567890abcdef1234567890abcdef",
    });

    expect(parsed.businessReferences).toEqual([]);
  });

  it("validates correlated model and tool trajectory events", () => {
    expect(
      runtimeTraceEventSchema.parse({
        kind: "agent.tool.completed",
        payload: {
          attemptNumber: 1,
          callId: "call-1",
          durationMs: 42,
          inputPreview: { commandType: "page.snapshot" },
          name: "browser_command",
          outputPreview: { status: "SUCCEEDED" },
          segmentId: "task-1:4",
          status: "SUCCEEDED",
          step: 2,
        },
      }),
    ).toMatchObject({ kind: "agent.tool.completed" });

    expect(
      runtimeTraceEventSchema.safeParse({
        kind: "agent.model.completed",
        payload: { attemptNumber: 1, segmentId: "task-1:4", step: 0 },
      }).success,
    ).toBe(false);
  });

  it("validates a source-traceable Agent-generated Spec", () => {
    const source = {
      contentHash: "a".repeat(64),
      excerpt: "Refunds must restore the order state.",
      externalId:
        "analysis-source://cc61de8d-cf29-4561-b2cd-c67c304668a5/source-1",
      kind: "LINEAR_ISSUE",
      label: "ENG-123 · Refund flow",
      locator: { issueId: "issue-1" },
      revision: null,
      uri: "https://linear.app/acme/issue/ENG-123/refund-flow",
    };
    const outcome = runtimeSpecAnalysisOutcomeSchema.parse({
      kind: "SPEC_GENERATED",
      sourceRefs: [source],
      spec: {
        cases: [
          {
            authRole: "member",
            criteria: [
              {
                description: "The refunded order is displayed as refunded.",
                id: "order-refunded",
                requiredEvidenceKinds: ["DOM", "BUSINESS_REFERENCE"],
                sourceRefs: [source.externalId],
              },
            ],
            name: "Refunded order state",
            preconditions: ["A paid order exists."],
            rationale: "Covers the Issue acceptance requirement.",
            sourceRefs: [source.externalId],
            steps: [
              {
                action: "Refund the paid order.",
                expectedObservation: "The order status becomes Refunded.",
                order: 1,
              },
            ],
          },
        ],
        scope: { inScope: ["Order refund state"] },
        summary: "Verify the refund state transition.",
      },
      summary: "Verify the refund state transition.",
    });

    expect(outcome.kind).toBe("SPEC_GENERATED");
  });
});
