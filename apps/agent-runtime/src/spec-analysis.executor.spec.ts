import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeSpecAnalysisTaskLease,
  RuntimeSpecSourceRef,
} from "@devproof/agent-runtime-protocol";

import { SpecAnalysisExecutor } from "./spec-analysis.executor.js";
import { ControlPlaneError } from "./control-plane.client.js";

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
    const invalidCaseSourceRef = `${source.externalId}-case-typo`;
    const invalidCriterionSourceRef = `${source.externalId}-criterion-typo`;
    const specWithInvalidSourceRefs = {
      ...spec,
      cases: spec.cases.map((testCase) => ({
        ...testCase,
        criteria: testCase.criteria.map((criterion) => ({
          ...criterion,
          sourceRefs: [invalidCriterionSourceRef],
        })),
        sourceRefs: [invalidCaseSourceRef],
      })),
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
              analysisSummary: "修正字段后提交完整 Spec。",
              spec: specWithInvalidSourceRefs,
            },
            "call-4",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-5",
        output: [
          call(
            "finish_spec",
            {
              analysisSummary: "逐字采用合法来源并提交可执行的 Spec。",
              spec,
            },
            "call-5",
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
    ).toHaveLength(5);
    expect(
      kinds.filter((kind) => kind === "agent.analysis.completed"),
    ).toHaveLength(5);
    expect(kinds.filter((kind) => kind === "agent.tool.started")).toHaveLength(
      5,
    );
    expect(
      kinds.filter((kind) => kind === "agent.tool.completed"),
    ).toHaveLength(5);
    expect(
      appendSpecEvent.mock.calls.find(
        (arguments_) =>
          arguments_[1] === "agent.tool.completed" &&
          arguments_[2]?.callId === "call-1",
      )?.[2],
    ).toMatchObject({ sourceRefs: [source.externalId] });
    expect(kinds).toContain("agent.spec.generated");
    expect(
      kinds.filter((kind) => kind === "agent.spec.validation_failed"),
    ).toHaveLength(2);
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
    expect(JSON.stringify(firstRequest.tools)).not.toContain(source.externalId);

    const secondRequest = create.mock.calls[1]?.[0] as {
      tools: Array<{ name: string; parameters: unknown }>;
    };
    const finishSpecTool = secondRequest.tools.find(
      (tool) => tool.name === "finish_spec",
    );
    const finishSpecParameters = JSON.stringify(finishSpecTool?.parameters);
    expect(finishSpecParameters).toContain(
      "必须逐字选择一个已经由来源工具返回的 analysis-source。",
    );
    expect(finishSpecParameters).toContain(
      JSON.stringify({ enum: [source.externalId] }).slice(1, -1),
    );

    const finalRequest = create.mock.calls[4]?.[0] as {
      input: Array<{ call_id?: string; output?: string; type?: string }>;
    };
    const correctionOutput = finalRequest.input.find(
      (item) =>
        item.type === "function_call_output" && item.call_id === "call-4",
    );
    expect(correctionOutput).toBeDefined();
    const correction = JSON.parse(correctionOutput?.output ?? "{}") as {
      allowedSourceRefs?: string[];
      error?: string;
    };
    expect(correction.allowedSourceRefs).toEqual([source.externalId]);
    expect(correction.error).toContain("2 个尚未观察到的来源（共 2 处）");
    expect(correction.error).toContain("spec.cases[0].sourceRefs[0]");
    expect(correction.error).toContain(
      "spec.cases[0].criteria[0].sourceRefs[0]",
    );
  });

  it("stops after two consecutive failures from the required Linear source", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-1",
        output: [
          call(
            "linear_get_issue",
            { analysisSummary: "读取权威 Issue。" },
            "call-1",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-2",
        output: [
          call(
            "linear_get_issue",
            { analysisSummary: "Linear 暂时失败，再重试一次。" },
            "call-2",
          ),
        ],
      });
    const appendSpecEvent = vi.fn().mockResolvedValue({ accepted: true });
    const executeSpecTool = vi.fn().mockRejectedValue(
      new ControlPlaneError(500, {
        message: "Internal server error",
        statusCode: 500,
      }),
    );
    const executor = new SpecAnalysisExecutor(
      () => ({ responses: { create } }) as never,
      { appendSpecEvent, executeSpecTool } as never,
      60,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      error: {
        code: "SPEC_ANALYSIS_SOURCE_UNAVAILABLE",
        details: {
          consecutiveFailures: 2,
          sourceTool: "linear_get_issue",
          status: 500,
        },
      },
      executionDisposition: "NOT_RUN",
      kind: "FATAL_FAILURE",
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(executeSpecTool).toHaveBeenCalledTimes(2);
  });

  it("removes an unavailable optional source and completes with remaining evidence", async () => {
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
      risks: ["知识库数据源不可用，规格仅基于 Linear Issue。"],
      scope: { inScope: ["退款状态"] },
      summary: "验证退款行为。",
    };
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-1",
        output: [
          call(
            "linear_get_issue",
            { analysisSummary: "读取权威 Issue。" },
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
              analysisSummary: "检索退款业务知识。",
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
            "knowledge_search",
            {
              analysisSummary: "知识库暂时失败，再重试一次。",
              query: "refund order state",
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
              analysisSummary: "知识库不可用，使用剩余来源完成规格。",
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
      .mockRejectedValueOnce(
        new ControlPlaneError(500, { message: "Internal server error" }),
      )
      .mockRejectedValueOnce(
        new ControlPlaneError(500, { message: "Internal server error" }),
      );
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
    expect(executeSpecTool).toHaveBeenCalledTimes(3);
    const fourthRequest = create.mock.calls[3]?.[0] as {
      tools: Array<{ name: string }>;
    };
    expect(fourthRequest.tools.map((tool) => tool.name)).not.toContain(
      "knowledge_search",
    );
  });
});
