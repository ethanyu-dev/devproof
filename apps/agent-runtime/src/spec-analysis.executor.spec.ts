import { describe, expect, it, vi } from "vitest";

import { runtimeGeneratedSpecSchema } from "@devproof/agent-runtime-protocol";
import type {
  RuntimeSpecAnalysisTaskLease,
  RuntimeSpecSourceRef,
} from "@devproof/agent-runtime-protocol";

import {
  SpecAnalysisExecutor,
  validateFinalSpec,
} from "./spec-analysis.executor.js";
import { ControlPlaneError } from "./control-plane.client.js";
import { LeaseLostError } from "./lease-supervisor.js";

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
    type: "function" as const,
    id: id,
    function: { name: name, arguments: JSON.stringify(arguments_) },
  };
}

function refundSpec(sourceRef = source.externalId, quote = source.excerpt) {
  return runtimeGeneratedSpecSchema.parse({
    summary: "验证退款行为。",
    scope: { inScope: ["退款状态"] },
    cases: [
      {
        name: "退款状态",
        rationale: "覆盖退款要求。",
        preconditions: ["具有退款权限。"],
        sourceRefs: [sourceRef],
        steps: [
          {
            order: 1,
            action: "发起退款。",
            expectedObservation: "显示退款结果。",
          },
        ],
        criteria: [
          {
            id: "refund",
            description: "显示退款结果。",
            sourceRefs: [sourceRef],
            requiredEvidenceKinds: ["DOM"],
            basis: { sourceRef, quote, observationTarget: "退款结果" },
            observationTargets: [
              { label: "退款结果", expectedText: quote.slice(0, 500) },
            ],
          },
        ],
      },
    ],
  });
}

async function executeCalls(
  calls: ReturnType<typeof call>[],
  executeSpecTool: ReturnType<typeof vi.fn>,
  runTask = task,
) {
  const responses = calls.map((toolCall) => ({
    id: `response-${toolCall.id}`,
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [toolCall],
    },
  }));
  const create = vi.fn().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected extra model request");
    return response;
  });
  const appendSpecEvent = vi.fn().mockResolvedValue({ accepted: true });
  const outcome = await new SpecAnalysisExecutor(
    () => ({ complete: create }),
    { appendSpecEvent, executeSpecTool } as never,
    calls.length,
  ).execute(runTask, lease, new AbortController().signal);
  return { create, appendSpecEvent, outcome };
}

describe("SpecAnalysisExecutor", () => {
  it("negotiates compact cases and preserves uncovered requirements across corrections", async () => {
    const compactTask = {
      ...task,
      snapshot: { ...task.snapshot, specFormat: "COMPACT" as const },
    };
    const issue = {
      ...source,
      excerpt: "新增旧版对公转账白名单，样式参考 ZDR。",
    };
    const requirements = [
      {
        description: "支持旧版对公转账白名单",
        sourceRef: source.externalId,
        quote: "新增旧版对公转账白名单",
      },
      {
        description: "样式参考 ZDR",
        sourceRef: source.externalId,
        quote: "样式参考 ZDR",
      },
    ];
    const spec = {
      summary: "验证白名单类型",
      cases: [
        {
          name: "检查新增白名单类型",
          steps: ["独立打开白名单配置，检查类型选项。"],
          preconditions: ["不依赖其他 Case。"],
          testData: [
            "LEGACY_CORPORATE",
            "https://example.com",
            "user@example.com",
          ],
          criteria: [
            {
              requirementId: "requirement-1",
              description: "可以选择旧版对公转账白名单。",
              observationTargets: [
                { label: "对公转账类型", expectedText: "旧版对公转账白名单" },
              ],
            },
          ],
        },
      ],
    };
    const executeSpecTool = vi.fn().mockResolvedValue({
      result: { pullRequestUrls: [] },
      sourceRefs: [issue],
    });
    const { create, outcome } = await executeCalls(
      [
        call("linear_get_issue", { analysisSummary: "读取需求。" }, "issue"),
        call(
          "finish_spec",
          { analysisSummary: "尝试直接提交。", spec },
          "premature",
        ),
        call(
          "define_requirements",
          { analysisSummary: "确定完整需求。", requirements },
          "plan",
        ),
        call(
          "finish_spec",
          { analysisSummary: "提交类型检查。", spec },
          "missing-style",
        ),
        call(
          "define_requirements",
          {
            analysisSummary: "缩小需求范围。",
            requirements: requirements.slice(0, 1),
          },
          "shrink",
        ),
        call(
          "finish_spec",
          {
            analysisSummary: "明确待确认项。",
            spec: {
              ...spec,
              uncoveredRequirements: [
                {
                  requirementId: "requirement-2",
                  reason: "尚未明确样式比较范围，等待确认。",
                },
              ],
            },
          },
          "finish",
        ),
      ],
      executeSpecTool,
      compactTask,
    );
    expect(outcome).toMatchObject({
      kind: "SPEC_GENERATED",
      spec: {
        requirements: requirements.map((item, index) => ({
          ...item,
          id: `requirement-${index + 1}`,
        })),
        uncoveredRequirements: [{ requirementId: "requirement-2" }],
        cases: [
          {
            sourceRefs: [source.externalId],
            priority: "MEDIUM",
            steps: [{ order: 1 }],
            criteria: [
              {
                requirementId: "requirement-1",
                required: true,
                requiredEvidenceKinds: ["DOM"],
              },
            ],
          },
        ],
      },
    });
    expect(executeSpecTool).toHaveBeenCalledTimes(1);
    const toolNames = (index: number) =>
      create.mock.calls[index]![0].tools.map(
        (tool: { function: { name: string } }) => tool.function.name,
      );
    expect(toolNames(0)).toEqual(["linear_get_issue"]);
    expect(toolNames(1)).toContain("define_requirements");
    expect(toolNames(1)).not.toContain("finish_spec");
    expect(toolNames(3)).not.toContain("define_requirements");
    const finishTool = create.mock.calls[3]![0].tools.find(
      (tool: { function: { name: string } }) =>
        tool.function.name === "finish_spec",
    );
    const caseInput =
      finishTool.function.parameters.properties.spec.properties.cases.items;
    expect(caseInput.required).toEqual(["name", "steps", "criteria"]);
    expect(caseInput.properties.criteria.items.required).toEqual([
      "requirementId",
      "description",
      "observationTargets",
    ]);
    const transcript = JSON.stringify(create.mock.calls.at(-1)![0].messages);
    expect(transcript).toContain("遗漏需求：requirement-2");
    expect(transcript).toContain("不能为通过校验删除需求");
  });

  it("rejects the incident's Linear URL passed to GitHub and hides tools without linked PRs", async () => {
    const executeSpecTool = vi.fn().mockResolvedValue({
      result: { pullRequestUrls: [] },
      sourceRefs: [source],
    });
    const { create, appendSpecEvent, outcome } = await executeCalls(
      [
        call(
          "github_search_code",
          {
            analysisSummary: "先检查代码。",
            pullRequestUrl: source.uri,
            query: "LEGACY_CORPORATE",
          },
          "before-issue",
        ),
        call("linear_get_issue", { analysisSummary: "读取需求。" }, "issue"),
        call(
          "github_search_code",
          {
            analysisSummary: "检查代码。",
            pullRequestUrl: source.uri,
            query: "LEGACY_CORPORATE",
          },
          "invalid-pr",
        ),
        call(
          "finish_spec",
          { analysisSummary: "提交部分规格。", spec: refundSpec() },
          "finish",
        ),
      ],
      executeSpecTool,
    );
    expect(outcome.kind).toBe("SPEC_GENERATED");
    expect(executeSpecTool).toHaveBeenCalledTimes(1);
    expect(
      create.mock.calls[0]![0].tools.map(
        (tool: { function: { name: string } }) => tool.function.name,
      ),
    ).toEqual(["linear_get_issue"]);
    expect(
      create.mock.calls
        .at(-1)![0]
        .tools.map(
          (tool: { function: { name: string } }) => tool.function.name,
        ),
    ).toEqual(["linear_get_issue", "finish_spec"]);
    expect(
      appendSpecEvent.mock.calls.filter(
        (args) => args[1] === "agent.tool.failed",
      ),
    ).toHaveLength(2);
    expect(JSON.stringify(create.mock.calls.at(-1))).toContain("没有关联 PR");
  });

  it("requires metadata, diffs, file reads and discovered Route Specs for every linked PR", () => {
    const first = "https://github.com/acme/web/pull/42";
    const second = "https://github.com/acme/api/pull/43";
    const sources = new Map([[source.externalId, source]]);
    const addSource = (
      url: string,
      kind: RuntimeSpecSourceRef["kind"],
      path = "src/refund.ts",
      query?: string,
    ) => {
      const externalId = `analysis-source://${url}/${kind}/${path}/${query ?? "read"}`;
      sources.set(externalId, {
        ...source,
        externalId,
        kind,
        uri:
          kind === "GITHUB_PULL_REQUEST"
            ? url
            : `${url}/files#${encodeURIComponent(path)}`,
        locator: { path, ...(query ? { query } : {}) },
      });
    };
    for (const kind of [
      "GITHUB_PULL_REQUEST",
      "GITHUB_DIFF",
      "GITHUB_FILE",
    ] as const)
      addSource(first, kind);
    const input = {
      calledTools: new Set(["linear_get_issue"]),
      linkedPullRequests: [
        { url: first },
        { url: second, changedFiles: ["specs/routes/refund.md"] },
      ],
      sources,
      sourceContents: new Map([[source.externalId, source.excerpt]]),
      spec: refundSpec(),
      unavailableTools: new Set<string>(),
    };
    expect(validateFinalSpec(input)).toContain(second);
    addSource(second, "GITHUB_PULL_REQUEST");
    addSource(second, "GITHUB_DIFF");
    addSource(second, "GITHUB_FILE", "src/refund.ts", "refund");
    expect(validateFinalSpec(input)).toContain("搜索片段不能替代");
    addSource(second, "GITHUB_FILE");
    expect(validateFinalSpec(input)).toContain("specs/routes/refund.md");
    addSource(second, "GITHUB_FILE", "specs/routes/refund.md");
    expect(validateFinalSpec(input)).toBeNull();
  });

  it("does not validate a quote using a different file in the same tool response", async () => {
    const url = "https://github.com/acme/web/pull/42";
    const fileA = {
      ...source,
      kind: "GITHUB_DIFF",
      externalId: `${source.externalId}-a`,
      excerpt: "文件甲说明退款。",
      uri: `${url}/files#a.ts`,
      locator: { path: "a.ts" },
    };
    const fileB = {
      ...fileA,
      externalId: `${source.externalId}-b`,
      excerpt: "文件乙允许撤销退款。",
      uri: `${url}/files#b.ts`,
      locator: { path: "b.ts" },
    };
    const executeSpecTool = vi
      .fn()
      .mockImplementation(async (_lease, input) => {
        if (input.name === "linear_get_issue")
          return { result: { pullRequestUrls: [url] }, sourceRefs: [source] };
        if (input.name === "github_get_pull_request")
          return {
            result: {},
            sourceRefs: [
              {
                ...source,
                kind: "GITHUB_PULL_REQUEST",
                uri: url,
                externalId: `${source.externalId}-pr`,
              },
            ],
          };
        if (input.name === "github_read_file")
          return {
            result: { content: fileA.excerpt },
            sourceRefs: [
              {
                ...fileA,
                kind: "GITHUB_FILE",
                externalId: `${source.externalId}-read`,
              },
            ],
          };
        return {
          result: {
            files: [fileA, fileB].map((file) => ({
              sourceRef: file.externalId,
              patch: file.excerpt,
            })),
          },
          sourceRefs: [fileA, fileB],
        };
      });
    const args = { analysisSummary: "核对来源。", pullRequestUrl: url };
    const { outcome, appendSpecEvent } = await executeCalls(
      [
        call("linear_get_issue", args, "issue"),
        call("github_get_pull_request", args, "pr"),
        call("github_list_changed_files", args, "diff"),
        call("github_read_file", { ...args, path: "a.ts" }, "file"),
        call(
          "finish_spec",
          {
            analysisSummary: "提交规格。",
            spec: refundSpec(fileA.externalId, fileB.excerpt),
          },
          "wrong-quote",
        ),
        call(
          "finish_spec",
          {
            analysisSummary: "修正引用。",
            spec: refundSpec(fileB.externalId, fileB.excerpt),
          },
          "correct-quote",
        ),
      ],
      executeSpecTool,
    );
    expect(outcome.kind).toBe("SPEC_GENERATED");
    expect(
      appendSpecEvent.mock.calls.filter(
        (args) => args[1] === "agent.spec.validation_failed",
      ),
    ).toHaveLength(1);
  });
  it.each([
    "已完成 Case 1，确认目标类型可选。",
    "依赖其他用例创建的数据。",
    "已了解 ZDR 新增的完整操作路径。",
  ])("rejects undelivered prerequisites: %s", (precondition) => {
    const text = "目标类型可选。";
    const spec = runtimeGeneratedSpecSchema.parse({
      summary: "独立核验目标类型。",
      scope: { inScope: ["类型可选性"] },
      cases: [
        {
          name: "检查类型",
          preconditions: [precondition],
          rationale: "核对真实页面。",
          sourceRefs: [source.externalId],
          steps: [
            {
              order: 1,
              action: "在本 Case 中观察目标类型。",
              expectedObservation: text,
            },
          ],
          criteria: [
            {
              id: "type",
              description: text,
              observationTargets: [{ label: "类型控件", expectedText: text }],
              sourceRefs: [source.externalId],
              requiredEvidenceKinds: ["DOM"],
              basis: {
                sourceRef: source.externalId,
                quote: text,
                observationTarget: "类型控件",
              },
            },
          ],
        },
      ],
    });
    const input = {
      spec,
      calledTools: new Set(["linear_get_issue"]),
      linkedPullRequests: [],
      sources: new Map([[source.externalId, source]]),
      sourceContents: new Map([[source.externalId, text]]),
      unavailableTools: new Set<string>(),
    };
    expect(validateFinalSpec(input)).toContain("每例独立并发执行");
    spec.cases[0]!.preconditions = [
      "具备访问权限，进入后只读核查类型与参照界面。",
    ];
    expect(validateFinalSpec(input)).toBeNull();
  });

  it("correlates each fallback call independently, even when candidates share a model name", async () => {
    const create = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const appendSpecEvent = vi.fn().mockResolvedValue({ accepted: true });
    const executor = new SpecAnalysisExecutor(
      () => ({ complete: create }),
      { appendSpecEvent } as never,
      10,
    );
    const candidate = task.snapshot.modelCandidates[0]!;
    await expect(
      executor.execute(
        {
          ...task,
          snapshot: {
            ...task.snapshot,
            modelCandidates: [
              candidate,
              { ...candidate, baseUrl: "https://fallback.example.com/v1" },
            ],
          },
        },
        lease,
        new AbortController().signal,
      ),
    ).rejects.toThrow("provider unavailable");
    const events = appendSpecEvent.mock.calls.filter((call) =>
      call[1].startsWith("agent.model."),
    );
    expect(events.map((call) => call[1])).toEqual([
      "agent.model.started",
      "agent.model.failed",
      "agent.model.started",
      "agent.model.failed",
    ]);
    const firstId = events[0]![2].modelCallId;
    const secondId = events[2]![2].modelCallId;
    expect(firstId).toEqual(expect.any(String));
    expect(secondId).toEqual(expect.any(String));
    expect(secondId).not.toBe(firstId);
    expect(events[1]![2].modelCallId).toBe(firstId);
    expect(events[3]![2].modelCallId).toBe(secondId);
  });

  it("bounds text-only chat replies without treating them as a finished Spec", async () => {
    const message = {
      role: "assistant" as const,
      content: "继续分析需求。",
      reasoning_content: "private text-only reasoning",
    };
    const requests: Record<string, unknown>[] = [];
    const create = vi.fn().mockImplementation(async (request) => {
      requests.push(structuredClone(request));
      return { id: "chatcmpl-text", message };
    });
    const appendSpecEvent = vi.fn().mockResolvedValue({ accepted: true });
    const executeSpecTool = vi.fn();
    const executor = new SpecAnalysisExecutor(
      () => ({ complete: create }),
      { appendSpecEvent, executeSpecTool } as never,
      10,
    );
    await expect(
      executor.execute(task, lease, new AbortController().signal),
    ).rejects.toThrow("repeated text-only responses");
    expect(create).toHaveBeenCalledTimes(4);
    expect(executeSpecTool).not.toHaveBeenCalled();
    expect(requests[0]).toMatchObject({ tool_choice: "auto", stream: false });
    expect(requests[1]!.messages).toEqual(
      expect.arrayContaining([
        message,
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("请继续调用"),
        }),
      ]),
    );
    expect(JSON.stringify(appendSpecEvent.mock.calls)).not.toContain(
      message.reasoning_content,
    );
    expect(appendSpecEvent.mock.calls.at(-1)).toEqual(
      expect.arrayContaining([
        "agent.segment.completed",
        expect.objectContaining({ status: "FAILED" }),
      ]),
    );
  });

  it("rejects invented mandatory remark requirements even with a valid source id", () => {
    const issueText = "新增 LEGACY_CORPORATE 类型；样式参考 ZDR。";
    const spec = runtimeGeneratedSpecSchema.parse({
      summary: "验证新建类型。",
      scope: { inScope: ["新建类型"] },
      cases: [
        {
          name: "新建类型",
          preconditions: ["已登录后台，业务账号另由 TEST_ACCOUNT 提供。"],
          rationale: "来自需求。",
          sourceRefs: [source.externalId],
          testData: ["实际记录 ID 用于追踪，不假设备注字段存在。"],
          steps: [
            {
              order: 1,
              action: "探索新建表单实际字段。",
              expectedObservation: "观察可用控件。",
            },
          ],
          criteria: [
            {
              id: "remark",
              description: "备注必须回显。",
              required: true,
              requiredEvidenceKinds: ["DOM"],
              sourceRefs: [source.externalId],
              basis: {
                sourceRef: source.externalId,
                quote: "备注必须回显。",
                observationTarget: "列表备注列",
              },
            },
          ],
        },
      ],
    });
    const input = {
      spec,
      calledTools: new Set(["linear_get_issue"]),
      linkedPullRequests: [],
      sources: new Map([[source.externalId, source]]),
      sourceContents: new Map([[source.externalId, issueText]]),
      unavailableTools: new Set<string>(),
    };
    expect(validateFinalSpec(input)).toContain("未出现在实际来源");
    const criterion = spec.cases[0]!.criteria[0]!;
    criterion.description = "新建类型提供 LEGACY_CORPORATE。";
    criterion.basis = {
      sourceRef: source.externalId,
      quote: issueText,
      observationTarget: "新建弹窗的类型选项",
    };
    criterion.observationTargets = [
      { label: "新建类型", expectedText: "LEGACY_CORPORATE" },
    ];
    expect(validateFinalSpec(input)).toBeNull();
    delete criterion.observationTargets;
    expect(validateFinalSpec(input)).toContain("缺少 observationTargets");
    criterion.observationTargets = [
      { label: "LEGACY", expectedText: "LEGACY_CORPORATE" },
      { label: "ZDR", expectedText: "LEGACY_CORPORATE" },
    ];
    expect(validateFinalSpec(input)).toContain("必须能区分各对象");
    criterion.observationTargets[1]!.expectedText = "invented-enum";
    expect(validateFinalSpec(input)).toContain("必须来自已读取的来源");
    criterion.observationTargets[1]!.expectedText = "ZDR";
    expect(validateFinalSpec(input)).toBeNull();
    delete criterion.basis;
    expect(validateFinalSpec(input)).toContain(
      "探索步骤和自拟测试标识不能作为产品要求",
    );
  });
  it("does not start an execution whose lease has already been lost", async () => {
    const controller = new AbortController();
    const lost = new LeaseLostError();
    controller.abort(lost);
    const create = vi.fn();
    const appendSpecEvent = vi.fn();
    const executor = new SpecAnalysisExecutor(
      () => ({ complete: create }) as never,
      { appendSpecEvent } as never,
      10,
    );
    await expect(executor.execute(task, lease, controller.signal)).rejects.toBe(
      lost,
    );
    expect(create).not.toHaveBeenCalled();
    expect(appendSpecEvent).not.toHaveBeenCalled();
  });

  it("cancels an in-flight trace request when ownership expires", async () => {
    const controller = new AbortController();
    const create = vi.fn();
    const appendSpecEvent = vi.fn(
      (_lease, _kind, _payload, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const executor = new SpecAnalysisExecutor(
      () => ({ complete: create }) as never,
      { appendSpecEvent } as never,
      10,
    );
    const running = executor.execute(task, lease, controller.signal);
    const lost = new LeaseLostError();
    controller.abort(lost);
    await expect(running).rejects.toBe(lost);
    expect(appendSpecEvent.mock.calls[0]?.[3]).toBe(controller.signal);
    expect(create).not.toHaveBeenCalled();
  });

  it("stops after a source call loses its lease instead of retrying it as a tool failure", async () => {
    const lost = new ControlPlaneError(409, { code: "RUNTIME_LEASE_LOST" });
    const controller = new AbortController();
    const create = vi.fn().mockResolvedValue({
      id: "response-1",
      message: {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          call("linear_get_issue", { analysisSummary: "读取需求。" }, "call-1"),
        ],
      },
    });
    const appendSpecEvent = vi.fn().mockResolvedValue({ accepted: true });
    const executeSpecTool = vi.fn().mockRejectedValue(lost);
    const executor = new SpecAnalysisExecutor(
      () => ({ complete: create }) as never,
      { appendSpecEvent, executeSpecTool } as never,
      10,
    );
    await expect(executor.execute(task, lease, controller.signal)).rejects.toBe(
      lost,
    );
    expect(create).toHaveBeenCalledOnce();
    expect(executeSpecTool).toHaveBeenCalledOnce();
    expect(executeSpecTool.mock.calls[0]?.[2]).toBe(controller.signal);
    expect(appendSpecEvent.mock.calls.at(-1)?.[1]).toBe("agent.tool.started");
  });

  it("does not start another source call or trace after the active call is aborted", async () => {
    const controller = new AbortController();
    const lost = new LeaseLostError();
    const create = vi.fn().mockResolvedValue({
      id: "response-1",
      message: {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          call("linear_get_issue", { analysisSummary: "读取需求。" }, "call-1"),
          call(
            "github_get_pull_request",
            {
              analysisSummary: "读取关联 PR。",
              pullRequestUrl: "https://github.com/acme/web/pull/42",
            },
            "call-2",
          ),
        ],
      },
    });
    const appendSpecEvent = vi.fn().mockResolvedValue({ accepted: true });
    const executeSpecTool = vi.fn().mockImplementation(async () => {
      controller.abort(lost);
      throw lost;
    });
    const executor = new SpecAnalysisExecutor(
      () => ({ complete: create }) as never,
      { appendSpecEvent, executeSpecTool } as never,
      10,
    );
    await expect(executor.execute(task, lease, controller.signal)).rejects.toBe(
      lost,
    );
    expect(create).toHaveBeenCalledOnce();
    expect(executeSpecTool).toHaveBeenCalledOnce();
    expect(appendSpecEvent.mock.calls.at(-1)?.[1]).toBe("agent.tool.started");
  });

  it("records every analysis step and completes an Issue-only Spec without knowledge", async () => {
    const spec = {
      cases: [
        {
          criteria: [
            {
              description: "订单显示为已退款状态。",
              observationTargets: [
                { label: "退款状态", expectedText: source.excerpt },
              ],
              basis: {
                sourceRef: source.externalId,
                quote: source.excerpt,
                observationTarget: "订单详情的退款状态",
              },
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
        message: {
          role: "assistant" as const,
          content: null,
          reasoning_content: "private hidden reasoning",
          tool_calls: [
            call(
              "linear_get_issue",
              { analysisSummary: "先读取权威 Issue。" },
              "call-1",
            ),
          ],
        },
      })
      .mockResolvedValueOnce({
        id: "response-3",
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: [
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
        },
      })
      .mockResolvedValueOnce({
        id: "response-4",
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            call(
              "finish_spec",
              {
                analysisSummary: "修正字段后提交完整 Spec。",
                spec: specWithInvalidSourceRefs,
              },
              "call-4",
            ),
          ],
        },
      })
      .mockResolvedValueOnce({
        id: "response-5",
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            call(
              "finish_spec",
              {
                analysisSummary: "逐字采用合法来源并提交可执行的 Spec。",
                spec,
              },
              "call-5",
            ),
          ],
        },
      });
    const appendSpecEvent = vi.fn().mockResolvedValue({ accepted: true });
    const executeSpecTool = vi.fn().mockResolvedValueOnce({
      result: {
        issue: { identifier: "ENG-123", title: "Refund flow" },
        pullRequestUrls: [],
      },
      sourceRefs: [source],
    });
    const executor = new SpecAnalysisExecutor(
      () => ({ complete: create }) as never,
      { appendSpecEvent, executeSpecTool } as never,
      10,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome.kind).toBe("SPEC_GENERATED");
    expect(executeSpecTool).toHaveBeenCalledTimes(1);
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
    expect(
      kinds.filter((kind) => kind === "agent.spec.validation_failed"),
    ).toHaveLength(2);
    expect(JSON.stringify(appendSpecEvent.mock.calls)).not.toContain(
      "private hidden reasoning",
    );
    const firstRequest = create.mock.calls[0]?.[0] as {
      messages: Array<{ content?: string; role?: string }>;
      tools: Array<{ function: { description: string } }>;
    };
    expect(firstRequest.messages[0]?.content).toContain(
      "所有用户可见的生成内容必须使用简体中文",
    );
    expect(
      firstRequest.tools.every((tool) =>
        /[\u3400-\u9fff]/u.test(tool.function.description),
      ),
    ).toBe(true);
    expect(JSON.stringify(firstRequest.tools)).not.toContain(source.externalId);
    expect(JSON.stringify(firstRequest.tools)).not.toContain(
      "knowledge_search",
    );
    expect(firstRequest.messages[0]?.content).not.toContain("知识库");

    const secondRequest = create.mock.calls[1]?.[0] as {
      tools: Array<{ function: { name: string; parameters: unknown } }>;
    };
    const finishSpecTool = secondRequest.tools.find(
      (tool) => tool.function.name === "finish_spec",
    );
    const finishSpecParameters = JSON.stringify(
      finishSpecTool?.function.parameters,
    );
    expect(finishSpecParameters).toContain(
      "必须逐字选择一个已经由来源工具返回的 analysis-source。",
    );
    expect(finishSpecParameters).toContain(
      JSON.stringify({ enum: [source.externalId] }).slice(1, -1),
    );

    const finalRequest = create.mock.calls[3]?.[0] as {
      messages: Array<{
        tool_call_id?: string;
        content?: string;
        role?: string;
      }>;
    };
    const correctionOutput = finalRequest.messages.find(
      (item) => item.role === "tool" && item.tool_call_id === "call-4",
    );
    expect(correctionOutput).toBeDefined();
    const correction = JSON.parse(correctionOutput?.content ?? "{}") as {
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
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            call(
              "linear_get_issue",
              { analysisSummary: "读取权威 Issue。" },
              "call-1",
            ),
          ],
        },
      })
      .mockResolvedValueOnce({
        id: "response-2",
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            call(
              "linear_get_issue",
              { analysisSummary: "Linear 暂时失败，再重试一次。" },
              "call-2",
            ),
          ],
        },
      });
    const appendSpecEvent = vi.fn().mockResolvedValue({ accepted: true });
    const executeSpecTool = vi.fn().mockRejectedValue(
      new ControlPlaneError(500, {
        message: "Internal server error",
        statusCode: 500,
      }),
    );
    const executor = new SpecAnalysisExecutor(
      () => ({ complete: create }) as never,
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

  it.each([false, true])(
    "requires linked PR metadata, diffs and code without knowledge (search unavailable: %s)",
    async (searchUnavailable) => {
      const spec = {
        cases: [
          {
            criteria: [
              {
                description: "订单显示为已退款状态。",
                observationTargets: [
                  { label: "退款状态", expectedText: source.excerpt },
                ],
                basis: {
                  sourceRef: source.externalId,
                  quote: source.excerpt,
                  observationTarget: "订单详情的退款状态",
                },
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
        risks: searchUnavailable
          ? ["GitHub 代码检索不可用，已读取变更文件和实现代码。"]
          : [],
        scope: { inScope: ["退款状态"] },
        summary: "验证退款行为。",
      };
      const pullRequestUrl = "https://github.com/acme/web/pull/42";
      const githubArguments = {
        analysisSummary: "检查退款实现。",
        pullRequestUrl,
      };
      const finishArguments = {
        analysisSummary: "提交已核对来源的规格。",
        spec,
      };
      const calls = [
        call(
          "linear_get_issue",
          { analysisSummary: "读取权威 Issue。" },
          "issue",
        ),
        call("finish_spec", finishArguments, "before-pr"),
        call("github_get_pull_request", githubArguments, "pr"),
        call("github_list_changed_files", githubArguments, "diff"),
        call("finish_spec", finishArguments, "before-code"),
        call(
          "github_read_file",
          { ...githubArguments, path: "src/refund.ts" },
          "file",
        ),
        ...(searchUnavailable
          ? [
              call(
                "github_search_code",
                { ...githubArguments, query: "refund" },
                "search-1",
              ),
              call(
                "github_search_code",
                { ...githubArguments, query: "refund" },
                "search-2",
              ),
              call(
                "github_search_code",
                { ...githubArguments, query: "refund" },
                "search-after-disabled",
              ),
            ]
          : []),
        call("finish_spec", finishArguments, "finish"),
      ];
      const responses = calls.map((toolCall, index) => ({
        id: `response-${index + 1}`,
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: [toolCall],
        },
      }));
      const create = vi.fn().mockImplementation(async () => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected extra model request");
        return response;
      });
      const appendSpecEvent = vi.fn().mockResolvedValue({ accepted: true });
      const executeSpecTool = vi
        .fn()
        .mockImplementation(async (_lease, input) => {
          if (input.name === "linear_get_issue") {
            return {
              result: {
                issue: { identifier: "ENG-123", title: "Refund flow" },
                pullRequestUrls: [pullRequestUrl],
              },
              sourceRefs: [source],
            };
          }
          if (input.name === "github_search_code") {
            throw new ControlPlaneError(500, {
              message: "Internal server error",
            });
          }
          const kinds: Record<string, RuntimeSpecSourceRef["kind"]> = {
            github_get_pull_request: "GITHUB_PULL_REQUEST",
            github_list_changed_files: "GITHUB_DIFF",
            github_read_file: "GITHUB_FILE",
          };
          const kind = kinds[input.name];
          if (!kind) throw new Error(`Unexpected source tool: ${input.name}`);
          return {
            result: { pullRequestUrl },
            sourceRefs: [
              {
                ...source,
                externalId: `${source.externalId}-${kind}`,
                kind,
                revision: "head-sha",
                uri: pullRequestUrl,
              },
            ],
          };
        });
      const executor = new SpecAnalysisExecutor(
        () => ({ complete: create }) as never,
        { appendSpecEvent, executeSpecTool } as never,
        12,
      );

      const outcome = await executor.execute(
        task,
        lease,
        new AbortController().signal,
      );

      expect(outcome.kind).toBe("SPEC_GENERATED");
      const githubTool = create.mock.calls[1]![0].tools.find(
        (tool: { function: { name: string } }) =>
          tool.function.name === "github_search_code",
      );
      expect(
        githubTool.function.parameters.properties.pullRequestUrl.enum,
      ).toEqual([pullRequestUrl]);
      expect(executeSpecTool.mock.calls.map((args) => args[1].name)).toEqual([
        "linear_get_issue",
        "github_get_pull_request",
        "github_list_changed_files",
        "github_read_file",
        ...(searchUnavailable
          ? ["github_search_code", "github_search_code"]
          : []),
      ]);
      expect(
        appendSpecEvent.mock.calls.filter(
          (args) => args[1] === "agent.spec.validation_failed",
        ),
      ).toHaveLength(2);
      const finalRequest = create.mock.calls.at(-1)?.[0] as {
        tools: Array<{ function: { name: string } }>;
      };
      const toolNames = finalRequest.tools.map((tool) => tool.function.name);
      expect(toolNames).not.toContain("knowledge_search");
      expect(toolNames.includes("github_search_code")).toBe(!searchUnavailable);
    },
  );
});
