import { describe, expect, it } from "vitest";

import {
  POST_RUN_ANALYSIS_REPORT_MAX_BYTES,
  agentProviderSchema,
  missingRequiredEvidenceKinds,
  runtimeBrowserAcquireOutputSchema,
  runtimeCriterionSchema,
  runtimeModelCandidateSchema,
  runtimePostRunAnalysisOutcomeSchema,
  runtimePostRunAnalysisReportSchema,
  runtimePostRunAnalysisTaskLeaseSchema,
  runtimePostRunAnalysisToolInputSchema,
  runtimeRegistrationInputSchema,
  runtimeRegistrationOutputSchema,
  runtimeOutcomeSchema,
  runtimeSpecAnalysisOutcomeSchema,
  runtimeTaskSnapshotSchema,
  runtimeTraceEventSchema,
} from "./index.js";

describe("agent runtime protocol", () => {
  it("uses a generic extension point for custom model providers", () => {
    expect(agentProviderSchema.parse("CUSTOM")).toBe("CUSTOM");
  });

  it("defaults analysis concurrency when registering against a v4 control plane", () => {
    expect(
      runtimeRegistrationOutputSchema.parse({
        browserConcurrency: 2,
        pools: ["BROWSER_EXECUTION"],
        refreshAfterMs: 5_000,
        specConcurrency: 0,
      }),
    ).toMatchObject({ analysisConcurrency: 0 });
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

  it("validates leased post-run bundle and evidence readers", () => {
    const identity = {
      fencingToken: "3",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      workerId: "worker-1",
    };
    expect(
      runtimePostRunAnalysisToolInputSchema.parse({
        ...identity,
        analysisSummary: "读取完整执行索引。",
        cursor: 0,
        maxBytes: 64_000,
        name: "read_analysis_manifest",
      }).name,
    ).toBe("read_analysis_manifest");
    expect(
      runtimePostRunAnalysisToolInputSchema.parse({
        ...identity,
        analysisSummary: "读取日志包。",
        cursor: 0,
        maxBytes: 64_000,
        name: "read_analysis_bundle",
      }).name,
    ).toBe("read_analysis_bundle");
    expect(
      runtimePostRunAnalysisToolInputSchema.parse({
        ...identity,
        analysisSummary: "读取网络日志证据。",
        cursor: 0,
        evidenceRef: "artifact://network-log",
        maxBytes: 32_000,
        name: "read_analysis_evidence",
      }).name,
    ).toBe("read_analysis_evidence");
    expect(
      runtimePostRunAnalysisToolInputSchema.safeParse({
        ...identity,
        analysisSummary: "缺少证据引用。",
        cursor: 0,
        name: "read_analysis_evidence",
      }).success,
    ).toBe(false);
  });

  it("requires Runtime phase location on post-run findings", () => {
    const outcome = runtimePostRunAnalysisOutcomeSchema.parse({
      kind: "ANALYSIS_COMPLETED",
      report: {
        coverage: {
          bundleBytesRead: 0,
          bundleFullyScanned: false,
          candidateCount: 8,
          evidenceBytesRead: 64_000,
          evidenceReadCount: 2,
          manifestBytesRead: 0,
          manifestFullyScanned: false,
          strategy: "failure-first-v1",
        },
        findings: [
          {
            attemptNumber: 3,
            category: "AGENT_REASONING",
            component: "agent-runtime.context-manager",
            confidence: 0.99,
            evidenceRefs: ["run-event://event-1"],
            failureClass: "CONTEXT_WINDOW_EXCEEDED",
            impact: "运行后分析无法完成。",
            phase: "POST_RUN_ANALYSIS.MODEL_INVOCATION",
            recommendation: "使用滚动摘要限制模型历史。",
            rootCause: "日志分块被持续累积到模型上下文。",
            runId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
            runtimeId: null,
            severity: "HIGH",
            title: "模型上下文持续增长",
          },
        ],
        summary: "问题已定位到运行后分析的模型调用阶段。",
      },
    });

    expect(outcome).toMatchObject({
      report: {
        coverage: {
          candidateCount: 8,
          evidenceReadCount: 2,
          strategy: "failure-first-v1",
        },
        findings: [
          {
            failureClass: "CONTEXT_WINDOW_EXCEEDED",
            phase: "POST_RUN_ANALYSIS.MODEL_INVOCATION",
          },
        ],
      },
    });
  });

  it("permits a model-free lease for a deterministic clean pass", () => {
    const lease = runtimePostRunAnalysisTaskLeaseSchema.parse({
      fencingToken: "1",
      leaseExpiresAt: "2026-09-02T08:00:00.000Z",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      snapshot: {
        analysisId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
        analyzerVersion: "post-run-analysis-v4",
        attemptNumber: 1,
        deadlineAt: "2026-09-02T08:00:00.000Z",
        input: {
          byteSize: 2,
          completeness: {
            browserExecutionsFinalized: true,
            durableEvents: true,
            evidenceMetadata: true,
          },
          manifest: {
            analysisSynopsis: {
              candidateCount: 0,
              cleanPass: true,
              completenessSufficient: true,
            },
          },
          schemaVersion: "devproof.task-logs.v2",
          sha256: "a".repeat(64),
        },
        modelCandidates: [],
        sourceRef: null,
        taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
        teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
        title: "clean pass",
        traceId: "1".repeat(32),
      },
      taskId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
    });

    expect(lease.snapshot.modelCandidates).toEqual([]);
  });

  it("rejects a post-run report that cannot fit inside the API request limit", () => {
    const finding = {
      attemptNumber: null,
      category: "PRODUCT_BUG" as const,
      component: "Runtime",
      confidence: 0.9,
      evidenceRefs: ["artifact://runtime-log"],
      failureClass: "COMMAND_FAILED",
      impact: "错".repeat(8_000),
      phase: "SPEC_EXECUTION",
      recommendation: "错".repeat(8_000),
      rootCause: "错".repeat(8_000),
      runId: null,
      runtimeId: null,
      severity: "HIGH" as const,
      title: "Runtime command failed",
    };
    const report = {
      findings: Array.from({ length: 10 }, () => finding),
      summary: "Oversized report",
    };

    expect(JSON.stringify(report).length).toBeLessThan(
      POST_RUN_ANALYSIS_REPORT_MAX_BYTES,
    );
    expect(runtimePostRunAnalysisReportSchema.safeParse(report).success).toBe(
      false,
    );
  });

  it("requires runId whenever a post-run finding identifies a runtime", () => {
    expect(
      runtimePostRunAnalysisOutcomeSchema.safeParse({
        kind: "ANALYSIS_COMPLETED",
        report: {
          findings: [
            {
              attemptNumber: 1,
              category: "RUNTIME_ENVIRONMENT",
              component: "Browser Runtime",
              confidence: 0.9,
              evidenceRefs: ["browser-event://event-1"],
              failureClass: "RUNTIME_LOST",
              impact: "测试中断。",
              phase: "SPEC_EXECUTION",
              recommendation: "检查 Runtime 健康状态。",
              rootCause: "Runtime 失联。",
              runId: null,
              runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
              severity: "HIGH",
              title: "Runtime 失联",
            },
          ],
          summary: "Runtime 异常。",
        },
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
