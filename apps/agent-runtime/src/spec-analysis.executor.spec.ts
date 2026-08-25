import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeSpecAnalysisTaskLease,
  RuntimeSpecSourceRef,
} from "@devproof/agent-runtime-protocol";

import { SpecAnalysisExecutor } from "./spec-analysis.executor.js";

const source: RuntimeSpecSourceRef = {
  contentHash: "a".repeat(64),
  excerpt: "Users can request a refund.",
  externalId: "analysis-source://cc61de8d-cf29-4561-b2cd-c67c304668a5/source-1",
  kind: "LINEAR_ISSUE",
  label: "ENG-123 · Refund flow",
  locator: { issueId: "issue-1" },
  revision: null,
  uri: "https://linear.app/acme/issue/ENG-123/refund-flow",
};

const task: RuntimeSpecAnalysisTaskLease = {
  fencingToken: "3",
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
  snapshot: {
    attemptNumber: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    issueRef: "ENG-123",
    modelCandidates: [
      {
        apiKey: "sk-test-model-secret",
        baseUrl: "https://gateway.example.com/v1",
        displayName: "Test model",
        modelId: "gpt-test",
      },
    ],
    stageAttemptId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
    taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
    teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
    traceId: "1234567890abcdef1234567890abcdef",
  },
  taskId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
};

const lease = {
  fencingToken: task.fencingToken,
  leaseToken: task.leaseToken,
  taskId: task.taskId,
  workerId: "worker-1",
};

function call(name: string, arguments_: unknown, id: string) {
  return {
    arguments: JSON.stringify(arguments_),
    call_id: id,
    name,
    type: "function_call" as const,
  };
}

describe("SpecAnalysisExecutor", () => {
  it("records every analysis, model and tool step and returns a cited Spec", async () => {
    const spec = {
      cases: [
        {
          criteria: [
            {
              description: "订单显示为已退款状态。",
              id: "refunded-state",
              requiredEvidenceKinds: ["DOM", "BUSINESS_REFERENCE"],
              sourceRefs: [source.externalId],
            },
          ],
          name: "退款状态",
          preconditions: ["已存在一笔已支付订单。"],
          rationale: "覆盖 Issue 中的退款要求。",
          sourceRefs: [source.externalId],
          steps: [
            {
              action: "发起退款。",
              expectedObservation: "订单状态变为已退款。",
              order: 1,
            },
          ],
        },
      ],
      scope: { inScope: ["退款状态"] },
      summary: "验证退款行为。",
    };
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-1",
        output: [
          { summary: "private hidden reasoning", type: "reasoning" },
          call(
            "linear_get_issue",
            { analysisSummary: "先读取权威 Issue。" },
            "call-1",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-2",
        output: [
          call(
            "knowledge_search",
            {
              analysisSummary: "检查相关退款业务规则。",
              query: "refund order state",
            },
            "call-2",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-3",
        output: [
          call(
            "finish_spec",
            {
              analysisSummary:
                "先提交一份包含英文摘要的 Spec，用于验证语言校验。",
              spec: { ...spec, summary: "Verify refund behavior." },
            },
            "call-3",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-4",
        output: [
          call(
            "finish_spec",
            {
              analysisSummary: "引用来源足以支持一份可执行的 Spec。",
              spec,
            },
            "call-4",
          ),
        ],
      });
    const appendSpecEvent = vi.fn().mockResolvedValue({ accepted: true });
    const executeSpecTool = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          issue: { identifier: "ENG-123", title: "Refund flow" },
          pullRequestUrls: [],
        },
        sourceRefs: [source],
      })
      .mockResolvedValueOnce({
        result: { diagnostics: [], items: [] },
        sourceRefs: [],
      });
    const executor = new SpecAnalysisExecutor(
      () => ({ responses: { create } }) as never,
      { appendSpecEvent, executeSpecTool } as never,
      10,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome.kind).toBe("SPEC_GENERATED");
    expect(executeSpecTool).toHaveBeenCalledTimes(2);
    const kinds = appendSpecEvent.mock.calls.map((arguments_) => arguments_[1]);
    expect(
      kinds.filter((kind) => kind === "agent.model.completed"),
    ).toHaveLength(4);
    expect(
      kinds.filter((kind) => kind === "agent.analysis.completed"),
    ).toHaveLength(4);
    expect(kinds.filter((kind) => kind === "agent.tool.started")).toHaveLength(
      4,
    );
    expect(
      kinds.filter((kind) => kind === "agent.tool.completed"),
    ).toHaveLength(4);
    expect(
      appendSpecEvent.mock.calls.find(
        (arguments_) =>
          arguments_[1] === "agent.tool.completed" &&
          arguments_[2]?.callId === "call-1",
      )?.[2],
    ).toMatchObject({ sourceRefs: [source.externalId] });
    expect(kinds).toContain("agent.spec.generated");
    expect(kinds).toContain("agent.spec.validation_failed");
    expect(JSON.stringify(appendSpecEvent.mock.calls)).not.toContain(
      "private hidden reasoning",
    );
    const firstRequest = create.mock.calls[0]?.[0] as {
      input: Array<{ content?: string; role?: string }>;
      tools: Array<{ description: string }>;
    };
    expect(firstRequest.input[0]?.content).toContain(
      "所有用户可见的生成内容必须使用简体中文",
    );
    expect(
      firstRequest.tools.every((tool) =>
        /[\u3400-\u9fff]/u.test(tool.description),
      ),
    ).toBe(true);
  });
});
