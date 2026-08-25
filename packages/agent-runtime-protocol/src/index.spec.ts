import { describe, expect, it } from "vitest";

import {
  agentProviderSchema,
  missingRequiredEvidenceKinds,
  runtimeBrowserAcquireOutputSchema,
  runtimeCriterionSchema,
  runtimeModelCandidateSchema,
  runtimeOutcomeSchema,
  runtimeSpecAnalysisOutcomeSchema,
  runtimeTaskSnapshotSchema,
  runtimeTraceEventSchema,
} from "./index.js";

describe("agent runtime protocol", () => {
  it("uses a generic extension point for custom model providers", () => {
    expect(agentProviderSchema.parse("CUSTOM")).toBe("CUSTOM");
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
