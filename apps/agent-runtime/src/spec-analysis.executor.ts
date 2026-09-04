import {
  runtimeGeneratedSpecSchema,
  runtimeSpecAnalysisOutcomeSchema,
  runtimeTraceEventSchema,
  type RuntimeSpecAnalysisOutcome,
  type RuntimeSpecAnalysisTaskLease,
  type RuntimeSpecSourceRef,
  type RuntimeTraceEvent,
} from "@devproof/agent-runtime-protocol";
import { z } from "zod";

import {
  ControlPlaneError,
  type ActiveLease,
  type ControlPlaneClient,
} from "./control-plane.client.js";
import type {
  ModelResponse,
  ResponsesClientFactory,
} from "./browser-verification.executor.js";

interface ModelFunctionCall {
  arguments: string;
  call_id: string;
  name: string;
  type: "function_call";
}

const analysisSummarySchema = z.string().trim().min(1).max(4_000);
const finishSpecSchema = z.object({
  analysisSummary: analysisSummarySchema,
  spec: runtimeGeneratedSpecSchema,
});
const MAX_CONSECUTIVE_SOURCE_FAILURES = 2;

type SourceToolName =
  | "linear_get_issue"
  | "github_get_pull_request"
  | "github_list_changed_files"
  | "github_read_file"
  | "github_search_code"
  | "knowledge_search";

export class SpecAnalysisExecutor {
  constructor(
    private readonly modelClient: ResponsesClientFactory,
    private readonly controlPlane: ControlPlaneClient,
    private readonly toolLimit: number,
  ) {}

  async execute(
    task: RuntimeSpecAnalysisTaskLease,
    lease: ActiveLease,
    signal: AbortSignal,
  ): Promise<RuntimeSpecAnalysisOutcome> {
    signal.throwIfAborted();
    const candidates = task.snapshot.modelCandidates;
    const preferredModel = candidates[0]!;
    const segmentId = `${task.taskId}:${lease.fencingToken}`;
    const segmentStartedAt = Date.now();
    const history: unknown[] = [
      { role: "system", content: systemPrompt() },
      {
        role: "user",
        content: JSON.stringify(
          {
            issueRef: task.snapshot.issueRef,
            objective:
              "分析 Issue、关联 Pull Request、代码变更和相关知识，并生成一份完整、可执行的中文测试规格。",
            targetUrl: task.snapshot.targetUrl ?? null,
          },
          null,
          2,
        ),
      },
    ];
    const sources = new Map<string, RuntimeSpecSourceRef>();
    const calledTools = new Set<string>();
    const sourceFailureCounts = new Map<SourceToolName, number>();
    const unavailableTools = new Set<SourceToolName>();
    let linkedPullRequestCount = 0;
    let segmentStatus: "FAILED" | "SUCCEEDED" = "FAILED";
    let segmentError: string | undefined;
    let leaseRejected = false;
    let step = 0;

    await this.appendTrace(lease, signal, {
      kind: "agent.segment.started",
      payload: {
        attemptNumber: task.snapshot.attemptNumber,
        inputPreview: tracePreview({
          issueRef: task.snapshot.issueRef,
          targetUrl: task.snapshot.targetUrl ?? null,
        }),
        model: preferredModel.modelId,
        provider: "OPENAI_COMPATIBLE",
        segmentId,
      },
    });

    try {
      for (let callCount = 0; callCount < this.toolLimit;) {
        signal.throwIfAborted();
        step += 1;
        const inputPreview = modelHistoryPreview(history);
        let response: ModelResponse | null = null;
        let selectedModel = preferredModel;
        let selectedStartedAt = Date.now();
        let lastError: unknown;

        for (const candidate of candidates) {
          signal.throwIfAborted();
          const modelStartedAt = Date.now();
          await this.appendTrace(lease, signal, {
            kind: "agent.model.started",
            payload: {
              attemptNumber: task.snapshot.attemptNumber,
              inputPreview,
              model: candidate.modelId,
              provider: "OPENAI_COMPATIBLE",
              segmentId,
              step,
            },
          });
          try {
            response = await this.modelClient(candidate).responses.create(
              {
                input: history,
                model: candidate.modelId,
                parallel_tool_calls: false,
                tool_choice: "required",
                tools: toolDefinitions(sources.keys(), unavailableTools),
              },
              { signal },
            );
            selectedModel = candidate;
            selectedStartedAt = modelStartedAt;
            lastError = undefined;
            break;
          } catch (error) {
            signal.throwIfAborted();
            lastError = error;
            await this.appendTrace(lease, signal, {
              kind: "agent.model.failed",
              payload: {
                attemptNumber: task.snapshot.attemptNumber,
                durationMs: Date.now() - modelStartedAt,
                errorMessage: traceError(error),
                inputPreview,
                model: candidate.modelId,
                provider: "OPENAI_COMPATIBLE",
                segmentId,
                step,
              },
            });
            if (signal.aborted) throw error;
          }
        }

        if (!response) {
          throw new Error(
            `All configured model providers failed: ${traceError(lastError)}`,
          );
        }
        await this.appendTrace(lease, signal, {
          kind: "agent.model.completed",
          payload: {
            attemptNumber: task.snapshot.attemptNumber,
            durationMs: Date.now() - selectedStartedAt,
            inputPreview,
            model: selectedModel.modelId,
            outputPreview: modelOutputPreview(response.output),
            provider: "OPENAI_COMPATIBLE",
            responseId: response.id,
            segmentId,
            step,
            ...(response.usage ? { usage: traceRecord(response.usage) } : {}),
          },
        });
        history.push(...response.output);
        const calls = response.output.filter(isFunctionCall);
        if (!calls.length) {
          history.push({
            role: "user",
            content:
              "请继续调用且只调用一个可用工具。仅返回文本无法完成 Spec 分析。",
          });
          continue;
        }

        for (const call of calls) {
          signal.throwIfAborted();
          callCount += 1;
          if (callCount > this.toolLimit) break;
          const startedAt = Date.now();
          const parsedArguments = parseArguments(call.arguments);
          const summary = analysisSummary(parsedArguments);
          if (!summary) {
            await this.appendTrace(lease, signal, {
              kind: "agent.tool.started",
              payload: {
                attemptNumber: task.snapshot.attemptNumber,
                callId: call.call_id,
                inputPreview: tracePreview(parsedArguments),
                name: call.name,
                segmentId,
                step,
              },
            });
            await this.appendTrace(
              lease,
              signal,
              toolFailed(
                task,
                segmentId,
                step,
                call,
                startedAt,
                "每次工具调用都必须提供中文 analysisSummary。",
              ),
            );
            history.push(
              toolOutput(call, {
                accepted: false,
                error: "每次工具调用都必须提供中文 analysisSummary。",
              }),
            );
            continue;
          }
          await this.appendTrace(lease, signal, {
            kind: "agent.analysis.completed",
            payload: {
              attemptNumber: task.snapshot.attemptNumber,
              callId: call.call_id,
              sourceRefs: [],
              summary,
              segmentId,
              step,
            },
          });
          await this.appendTrace(lease, signal, {
            kind: "agent.tool.started",
            payload: {
              attemptNumber: task.snapshot.attemptNumber,
              callId: call.call_id,
              inputPreview: tracePreview(parsedArguments),
              name: call.name,
              segmentId,
              step,
            },
          });
          signal.throwIfAborted();

          if (call.name === "finish_spec") {
            const parsed = finishSpecSchema.safeParse(parsedArguments);
            if (!parsed.success) {
              await this.validationFailed(
                lease,
                signal,
                task,
                segmentId,
                step,
                parsed.error.message,
                parsedArguments,
              );
              await this.toolCorrection(
                lease,
                signal,
                task,
                segmentId,
                step,
                call,
                startedAt,
                parsed.error.message,
              );
              history.push(
                toolOutput(
                  call,
                  specCorrection(parsed.error.message, sources.keys()),
                ),
              );
              continue;
            }
            const validationError = validateFinalSpec({
              calledTools,
              linkedPullRequestCount,
              sources,
              spec: parsed.data.spec,
              unavailableTools,
            });
            if (validationError) {
              await this.validationFailed(
                lease,
                signal,
                task,
                segmentId,
                step,
                validationError,
                parsed.data.spec,
              );
              await this.toolCorrection(
                lease,
                signal,
                task,
                segmentId,
                step,
                call,
                startedAt,
                validationError,
              );
              history.push(
                toolOutput(
                  call,
                  specCorrection(validationError, sources.keys()),
                ),
              );
              continue;
            }
            const usedSourceIds = specSourceIds(parsed.data.spec);
            const sourceRefs = usedSourceIds.map((id) => sources.get(id)!);
            await this.appendTrace(lease, signal, {
              kind: "agent.tool.completed",
              payload: {
                attemptNumber: task.snapshot.attemptNumber,
                callId: call.call_id,
                durationMs: Date.now() - startedAt,
                inputPreview: tracePreview({
                  analysisSummary: parsed.data.analysisSummary,
                  caseCount: parsed.data.spec.cases.length,
                }),
                name: call.name,
                outputPreview: { accepted: true },
                segmentId,
                sourceRefs: usedSourceIds,
                status: "SUCCEEDED",
                step,
              },
            });
            await this.appendTrace(lease, signal, {
              kind: "agent.spec.generated",
              payload: {
                attemptNumber: task.snapshot.attemptNumber,
                caseCount: parsed.data.spec.cases.length,
                outputPreview: tracePreview(parsed.data.spec),
                segmentId,
                sourceRefs: usedSourceIds,
                step,
              },
            });
            segmentStatus = "SUCCEEDED";
            return runtimeSpecAnalysisOutcomeSchema.parse({
              kind: "SPEC_GENERATED",
              sourceRefs,
              spec: parsed.data.spec,
              summary: parsed.data.spec.summary,
            });
          }

          if (!isSourceToolName(call.name)) {
            const error = `未知的 Spec 分析工具：${call.name}`;
            await this.appendTrace(
              lease,
              signal,
              toolFailed(task, segmentId, step, call, startedAt, error),
            );
            history.push(toolOutput(call, { accepted: false, error }));
            continue;
          }
          const sourceToolName = call.name;

          try {
            const output = await this.controlPlane.executeSpecTool(
              lease,
              {
                arguments: parsedArguments,
                callId: call.call_id,
                name: sourceToolName,
              },
              signal,
            );
            calledTools.add(call.name);
            sourceFailureCounts.delete(sourceToolName);
            output.sourceRefs.forEach((source) =>
              sources.set(source.externalId, source),
            );
            if (call.name === "linear_get_issue") {
              const result = record(output.result);
              linkedPullRequestCount = Array.isArray(result.pullRequestUrls)
                ? result.pullRequestUrls.length
                : 0;
            }
            await this.appendTrace(lease, signal, {
              kind: "agent.tool.completed",
              payload: {
                attemptNumber: task.snapshot.attemptNumber,
                callId: call.call_id,
                durationMs: Date.now() - startedAt,
                inputPreview: tracePreview(parsedArguments),
                name: call.name,
                outputPreview: tracePreview(output.result),
                segmentId,
                sourceRefs: output.sourceRefs.map(
                  (source) => source.externalId,
                ),
                status: "SUCCEEDED",
                step,
              },
            });
            history.push(toolOutput(call, output.result));
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof ControlPlaneError && error.status === 409) {
              throw error;
            }
            const errorMessage = traceError(error);
            const availabilityFailure = isSourceAvailabilityFailure(error);
            const failureCount = availabilityFailure
              ? (sourceFailureCounts.get(sourceToolName) ?? 0) + 1
              : 0;
            const sourceUnavailable =
              availabilityFailure &&
              failureCount >= MAX_CONSECUTIVE_SOURCE_FAILURES;
            if (availabilityFailure) {
              sourceFailureCounts.set(sourceToolName, failureCount);
            } else {
              sourceFailureCounts.delete(sourceToolName);
            }
            if (sourceUnavailable) unavailableTools.add(sourceToolName);
            const traceMessage = sourceUnavailable
              ? `${errorMessage}；${sourceToolName} 已连续失败 ${failureCount} 次，数据源已标记为不可用并停止调用。`
              : errorMessage;
            await this.appendTrace(
              lease,
              signal,
              toolFailed(task, segmentId, step, call, startedAt, traceMessage),
            );
            if (sourceUnavailable) {
              history.push(
                toolOutput(call, {
                  accepted: false,
                  code: "SOURCE_UNAVAILABLE",
                  consecutiveFailures: failureCount,
                  error: errorMessage,
                  skipped: true,
                  sourceTool: sourceToolName,
                }),
              );
              if (requiredSourceToolNames.has(sourceToolName)) {
                return sourceUnavailableOutcome(
                  sourceToolName,
                  failureCount,
                  error,
                );
              }
              continue;
            }
            history.push(
              toolOutput(call, {
                accepted: false,
                error: errorMessage,
              }),
            );
          }
        }
      }

      return runtimeSpecAnalysisOutcomeSchema.parse({
        error: {
          code: "SPEC_AGENT_TOOL_LIMIT_EXCEEDED",
          failureClass: "TOOL_EXECUTION",
          message: `Spec 分析超过 ${this.toolLimit} 次工具调用上限。`,
          phase: "spec_analysis",
        },
        executionDisposition: "AGENT_ERROR",
        kind: "RETRYABLE_FAILURE",
        summary: "Agent 未能在工具调用预算内完成 Spec。",
      });
    } catch (error) {
      leaseRejected =
        error instanceof ControlPlaneError && error.status === 409;
      segmentError = traceError(error);
      throw error;
    } finally {
      if (!leaseRejected)
        await this.appendTrace(lease, signal, {
          kind: "agent.segment.completed",
          payload: {
            attemptNumber: task.snapshot.attemptNumber,
            durationMs: Date.now() - segmentStartedAt,
            ...(segmentError ? { errorMessage: segmentError } : {}),
            segmentId,
            status: segmentStatus,
          },
        }).catch(() => undefined);
    }
  }

  private async appendTrace(
    lease: ActiveLease,
    signal: AbortSignal,
    event: RuntimeTraceEvent,
  ) {
    signal.throwIfAborted();
    const parsed = runtimeTraceEventSchema.parse(event);
    return this.controlPlane.appendSpecEvent(
      lease,
      parsed.kind,
      parsed.payload,
      signal,
    );
  }

  private validationFailed(
    lease: ActiveLease,
    signal: AbortSignal,
    task: RuntimeSpecAnalysisTaskLease,
    segmentId: string,
    step: number,
    errorMessage: string,
    output: unknown,
  ) {
    return this.appendTrace(lease, signal, {
      kind: "agent.spec.validation_failed",
      payload: {
        attemptNumber: task.snapshot.attemptNumber,
        errorMessage: errorMessage.slice(0, 4_000),
        outputPreview: tracePreview(output),
        segmentId,
        step,
      },
    });
  }

  private toolCorrection(
    lease: ActiveLease,
    signal: AbortSignal,
    task: RuntimeSpecAnalysisTaskLease,
    segmentId: string,
    step: number,
    call: ModelFunctionCall,
    startedAt: number,
    error: string,
  ) {
    return this.appendTrace(lease, signal, {
      kind: "agent.tool.completed",
      payload: {
        attemptNumber: task.snapshot.attemptNumber,
        callId: call.call_id,
        durationMs: Date.now() - startedAt,
        inputPreview: tracePreview(parseArguments(call.arguments)),
        name: call.name,
        outputPreview: { accepted: false, error: error.slice(0, 4_000) },
        segmentId,
        sourceRefs: [],
        status: "FAILED",
        step,
      },
    });
  }
}

const sourceToolNames = new Set<SourceToolName>([
  "linear_get_issue",
  "github_get_pull_request",
  "github_list_changed_files",
  "github_read_file",
  "github_search_code",
  "knowledge_search",
]);
const requiredSourceToolNames = new Set<SourceToolName>(["linear_get_issue"]);

function isSourceToolName(name: string): name is SourceToolName {
  return sourceToolNames.has(name as SourceToolName);
}

function toolDefinitions(
  sourceIds: Iterable<string> = [],
  unavailableTools: ReadonlySet<string> = new Set(),
) {
  const observedSourceIds = [...sourceIds];
  const analysisSummary = {
    description:
      "使用简体中文简要说明已获得的信息以及为什么需要执行本次操作；该内容会展示给用户，不要包含隐藏思维链。",
    maxLength: 4_000,
    minLength: 1,
    type: "string",
  };
  const pullRequestUrl = { format: "uri", maxLength: 2_000, type: "string" };
  return [
    {
      type: "function",
      name: "linear_get_issue",
      description:
        "读取权威的 Linear Issue，并发现其关联的 Pull Request；必须最先调用此工具。",
      parameters: objectSchema({ analysisSummary }, ["analysisSummary"]),
      strict: false,
    },
    {
      type: "function",
      name: "github_get_pull_request",
      description:
        "读取 Issue 关联 Pull Request 的元数据、描述、检查结果、版本和部署信息。",
      parameters: objectSchema({ analysisSummary, pullRequestUrl }, [
        "analysisSummary",
        "pullRequestUrl",
      ]),
      strict: false,
    },
    {
      type: "function",
      name: "github_list_changed_files",
      description: "分页读取关联 Pull Request 的变更文件和有界 diff 片段。",
      parameters: objectSchema(
        {
          analysisSummary,
          page: { maximum: 15, minimum: 1, type: "integer" },
          pullRequestUrl,
        },
        ["analysisSummary", "pullRequestUrl"],
      ),
      strict: false,
    },
    {
      type: "function",
      name: "github_read_file",
      description:
        "在 Pull Request 的 head SHA 上读取变更文件或相关文件，单次最多 400 行。",
      parameters: objectSchema(
        {
          analysisSummary,
          endLine: { minimum: 1, type: "integer" },
          path: { maxLength: 2_000, minLength: 1, type: "string" },
          pullRequestUrl,
          startLine: { minimum: 1, type: "integer" },
        },
        ["analysisSummary", "path", "pullRequestUrl"],
      ),
      strict: false,
    },
    {
      type: "function",
      name: "github_search_code",
      description:
        "在已授权的 Pull Request 仓库内检索相关代码，并返回固定在 head SHA 上的有界代码片段。",
      parameters: objectSchema(
        {
          analysisSummary,
          pathPrefix: { maxLength: 2_000, minLength: 1, type: "string" },
          pullRequestUrl,
          query: { maxLength: 500, minLength: 2, type: "string" },
        },
        ["analysisSummary", "pullRequestUrl", "query"],
      ),
      strict: false,
    },
    {
      type: "function",
      name: "knowledge_search",
      description: "使用从 Issue 和代码分析中提炼的查询检索只读知识库。",
      parameters: objectSchema(
        {
          analysisSummary,
          query: { maxLength: 20_000, minLength: 3, type: "string" },
        },
        ["analysisSummary", "query"],
      ),
      strict: false,
    },
    {
      type: "function",
      name: "finish_spec",
      description:
        "完成来源分析后提交完整、可执行的中文 Spec；每个 Case 和验收标准都必须引用实际观察到的 analysis-source。",
      parameters: constrainSourceRefs(
        stripFormats(z.toJSONSchema(finishSpecSchema)),
        observedSourceIds,
      ) as Record<string, unknown>,
      strict: false,
    },
  ].filter((tool) => !unavailableTools.has(tool.name));
}

function constrainSourceRefs(
  value: unknown,
  sourceIds: readonly string[],
): unknown {
  if (!sourceIds.length) return value;
  if (Array.isArray(value)) {
    return value.map((child) => constrainSourceRefs(child, sourceIds));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      const constrainedChild = constrainSourceRefs(child, sourceIds);
      if (
        key !== "sourceRefs" ||
        !constrainedChild ||
        typeof constrainedChild !== "object" ||
        Array.isArray(constrainedChild)
      ) {
        return [key, constrainedChild];
      }
      const sourceRefSchema = constrainedChild as Record<string, unknown>;
      const itemSchema = record(sourceRefSchema.items);
      return [
        key,
        {
          ...sourceRefSchema,
          items: {
            ...itemSchema,
            description:
              "必须逐字选择一个已经由来源工具返回的 analysis-source。",
            enum: sourceIds,
          },
        },
      ];
    }),
  );
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { additionalProperties: false, properties, required, type: "object" };
}

function stripFormats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripFormats);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      key === "format" ? [] : [[key, stripFormats(child)]],
    ),
  );
}

function systemPrompt() {
  return `你是 DevProof 的 Spec 分析 Agent。
请基于权威的 Linear Issue、关联的 GitHub Pull Request、变更代码、相关代码和知识库内容，生成一份完整、可执行的验证 Spec。
必须先调用 linear_get_issue。对于每个关联 Pull Request，都要检查元数据和变更文件；为了理解实际行为，应读取必要的实现文件，不能只依赖文件名或 PR 描述；还要使用由 Issue 和代码分析提炼出的查询检索知识库。
同一非必需数据源连续两次返回 5xx 或限流错误后，执行器会将其标记为不可用并移除对应工具；不要继续尝试该工具，应在风险中说明数据源缺失并使用其余可用来源完成分析。Linear Issue 是后续来源的必要入口，如果它不可用，执行器会立即以明确的数据源错误终止。
每次工具调用都必须包含 analysisSummary：用简体中文给出简洁、用户可见的决策摘要，不要输出隐藏思维链。
所有用户可见的生成内容必须使用简体中文，包括 Spec 摘要、范围、假设、风险、Case 名称、前置条件、测试数据、设计理由、操作步骤、预期现象、验收标准和清理步骤。标识符、URL、代码符号、API 路径、工具名、枚举值和 source reference 保持原样，不要翻译。
每个 Case 和每条验收标准都必须引用工具实际返回的 analysis-source；绝不能编造来源引用。
生成具体的前置条件、测试数据、有序操作、预期现象、验收标准、证据类型和清理步骤。优先描述业务可观察行为，而不是实现细节。
只有在完成 Issue、关联 PR 代码和知识库调查后才能调用 finish_spec。绝不能泄露凭据。`;
}

function validateFinalSpec(input: {
  calledTools: ReadonlySet<string>;
  linkedPullRequestCount: number;
  sources: ReadonlyMap<string, RuntimeSpecSourceRef>;
  spec: z.infer<typeof runtimeGeneratedSpecSchema>;
  unavailableTools: ReadonlySet<string>;
}) {
  const chineseError = validateChineseSpec(input.spec);
  if (chineseError) return chineseError;
  if (!input.calledTools.has("linear_get_issue")) {
    return "完成 Spec 前必须读取 Linear Issue。";
  }
  if (
    !input.calledTools.has("knowledge_search") &&
    !input.unavailableTools.has("knowledge_search")
  ) {
    return "完成 Spec 前必须检索知识库。";
  }
  const sourceKinds = new Set(
    [...input.sources.values()].map((source) => source.kind),
  );
  if (input.linkedPullRequestCount > 0) {
    if (
      !sourceKinds.has("GITHUB_PULL_REQUEST") &&
      !input.unavailableTools.has("github_get_pull_request")
    ) {
      return "完成 Spec 前必须读取每个相关联的 Pull Request。";
    }
    if (
      (!sourceKinds.has("GITHUB_DIFF") &&
        !input.unavailableTools.has("github_list_changed_files")) ||
      (!sourceKinds.has("GITHUB_FILE") &&
        !input.unavailableTools.has("github_read_file"))
    ) {
      return "完成 Spec 前必须同时检查变更 diff 片段和相关代码内容。";
    }
  }
  const invalidSourceRefs = specSourceRefEntries(input.spec).filter(
    ({ sourceRef }) => !input.sources.has(sourceRef),
  );
  if (invalidSourceRefs.length) {
    const details = invalidSourceRefs
      .slice(0, 20)
      .map(({ path, sourceRef }) => `- ${path}: ${sourceRef}`);
    if (invalidSourceRefs.length > details.length) {
      details.push(`- 另有 ${invalidSourceRefs.length - details.length} 处`);
    }
    return [
      `Spec 引用了 ${new Set(invalidSourceRefs.map(({ sourceRef }) => sourceRef)).size} 个尚未观察到的来源（共 ${invalidSourceRefs.length} 处）：`,
      ...details,
      "请只从 allowedSourceRefs 中逐字复制来源引用。",
    ].join("\n");
  }
  return null;
}

function isSourceAvailabilityFailure(error: unknown) {
  return (
    error instanceof ControlPlaneError &&
    (error.status === 429 || error.status >= 500)
  );
}

function sourceUnavailableOutcome(
  sourceTool: SourceToolName,
  consecutiveFailures: number,
  error: unknown,
): RuntimeSpecAnalysisOutcome {
  const status = error instanceof ControlPlaneError ? error.status : null;
  return runtimeSpecAnalysisOutcomeSchema.parse({
    error: {
      code: "SPEC_ANALYSIS_SOURCE_UNAVAILABLE",
      details: {
        consecutiveFailures,
        sourceTool,
        ...(status === null ? {} : { status }),
      },
      failureClass: "TOOL_EXECUTION",
      message: `必需数据源 ${sourceTool} 连续 ${consecutiveFailures} 次调用失败，已停止重试。最后一次错误：${traceError(error)}`,
      phase: "spec_analysis",
    },
    executionDisposition: "NOT_RUN",
    kind: "FATAL_FAILURE",
    summary: `必需数据源 ${sourceTool} 不可用，Spec 分析已停止以避免重复调用。`,
  });
}

const CHINESE_TEXT = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

function validateChineseSpec(spec: z.infer<typeof runtimeGeneratedSpecSchema>) {
  const fields: Array<[string, string]> = [
    ["summary", spec.summary],
    ...spec.assumptions.map(
      (value, index) => [`assumptions[${index}]`, value] as [string, string],
    ),
    ...spec.risks.map(
      (value, index) => [`risks[${index}]`, value] as [string, string],
    ),
    ...spec.scope.inScope.map(
      (value, index) => [`scope.inScope[${index}]`, value] as [string, string],
    ),
    ...spec.scope.outOfScope.map(
      (value, index) =>
        [`scope.outOfScope[${index}]`, value] as [string, string],
    ),
  ];
  spec.cases.forEach((testCase, caseIndex) => {
    fields.push(
      [`cases[${caseIndex}].name`, testCase.name],
      [`cases[${caseIndex}].rationale`, testCase.rationale],
      ...testCase.preconditions.map(
        (value, index) =>
          [`cases[${caseIndex}].preconditions[${index}]`, value] as [
            string,
            string,
          ],
      ),
      ...testCase.testData.map(
        (value, index) =>
          [`cases[${caseIndex}].testData[${index}]`, value] as [string, string],
      ),
      ...testCase.cleanup.map(
        (value, index) =>
          [`cases[${caseIndex}].cleanup[${index}]`, value] as [string, string],
      ),
      ...testCase.steps.flatMap((step, index) => [
        [`cases[${caseIndex}].steps[${index}].action`, step.action] as [
          string,
          string,
        ],
        [
          `cases[${caseIndex}].steps[${index}].expectedObservation`,
          step.expectedObservation,
        ] as [string, string],
      ]),
      ...testCase.criteria.map(
        (criterion, index) =>
          [
            `cases[${caseIndex}].criteria[${index}].description`,
            criterion.description,
          ] as [string, string],
      ),
    );
  });
  const invalid = fields.find(([, value]) => !CHINESE_TEXT.test(value));
  return invalid
    ? `${invalid[0]} 必须使用简体中文描述；标识符、URL 和代码符号可以保持原样。`
    : null;
}

function specSourceIds(spec: z.infer<typeof runtimeGeneratedSpecSchema>) {
  return Array.from(
    new Set(specSourceRefEntries(spec).map(({ sourceRef }) => sourceRef)),
  );
}

function specSourceRefEntries(
  spec: z.infer<typeof runtimeGeneratedSpecSchema>,
) {
  return spec.cases.flatMap((testCase, caseIndex) => [
    ...testCase.sourceRefs.map((sourceRef, sourceIndex) => ({
      path: `spec.cases[${caseIndex}].sourceRefs[${sourceIndex}]`,
      sourceRef,
    })),
    ...testCase.criteria.flatMap((criterion, criterionIndex) =>
      criterion.sourceRefs.map((sourceRef, sourceIndex) => ({
        path: `spec.cases[${caseIndex}].criteria[${criterionIndex}].sourceRefs[${sourceIndex}]`,
        sourceRef,
      })),
    ),
  ]);
}

function specCorrection(error: string, sourceIds: Iterable<string>) {
  return {
    accepted: false,
    allowedSourceRefs: [...sourceIds],
    error,
  };
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function analysisSummary(value: Record<string, unknown>) {
  const result = analysisSummarySchema.safeParse(value.analysisSummary);
  return result.success && CHINESE_TEXT.test(result.data) ? result.data : null;
}

function toolOutput(call: ModelFunctionCall, output: unknown) {
  return {
    call_id: call.call_id,
    output: JSON.stringify(output),
    type: "function_call_output",
  };
}

function toolFailed(
  task: RuntimeSpecAnalysisTaskLease,
  segmentId: string,
  step: number,
  call: ModelFunctionCall,
  startedAt: number,
  errorMessage: string,
): RuntimeTraceEvent {
  return {
    kind: "agent.tool.failed",
    payload: {
      attemptNumber: task.snapshot.attemptNumber,
      callId: call.call_id,
      durationMs: Date.now() - startedAt,
      errorMessage,
      inputPreview: tracePreview(parseArguments(call.arguments)),
      name: call.name,
      segmentId,
      step,
    },
  };
}

function isFunctionCall(value: unknown): value is ModelFunctionCall {
  return Boolean(
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "function_call" &&
    "name" in value &&
    "arguments" in value &&
    "call_id" in value,
  );
}

function modelOutputPreview(output: ModelResponse["output"]) {
  return output.map((item) => {
    if (isFunctionCall(item)) {
      return {
        arguments: tracePreview(parseArguments(item.arguments)),
        callId: item.call_id,
        name: item.name,
        type: item.type,
      };
    }
    const value = record(item);
    return {
      type: typeof value.type === "string" ? value.type : "provider_output",
    };
  });
}

function modelHistoryPreview(history: unknown[]) {
  return history.map((item) => {
    if (isFunctionCall(item)) {
      return {
        arguments: tracePreview(parseArguments(item.arguments)),
        callId: item.call_id,
        name: item.name,
        type: item.type,
      };
    }
    const value = record(item);
    if (value.type === "reasoning") return { type: "reasoning" };
    return tracePreview(item);
  });
}

const SENSITIVE_KEY =
  /(?:authorization|cookie|password|secret|token|api[-_]?key|credential|session(?:id)?)$/iu;

function tracePreview(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redact(value).slice(0, 2_000);
  if (value === null || ["number", "boolean"].includes(typeof value))
    return value;
  if (depth >= 6) return "[depth limit]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => tracePreview(item, depth + 1));
  }
  if (!value || typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([key, child]) => [
        key,
        SENSITIVE_KEY.test(key)
          ? "••••redacted••••"
          : tracePreview(child, depth + 1),
      ]),
  );
}

function traceRecord(value: Record<string, unknown>) {
  return record(tracePreview(value));
}

function traceError(error: unknown) {
  return redact(error instanceof Error ? error.message : String(error)).slice(
    0,
    4_000,
  );
}

function redact(value: string) {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 ••••redacted••••")
    .replace(/\b(?:dvp_sk_|sk-)[A-Za-z0-9_-]{12,}\b/gu, "••••redacted••••")
    .replace(
      /\b(password|passwd|secret|session(?:id)?|(?:access[_-]?)?token|api[-_]?key)(\s*[=:]\s*|["']?\s*:\s*["'])([^\s,;&"'<>}]+)/giu,
      "$1$2••••redacted••••",
    )
    .replace(
      /([?&](?:access_token|api_key|apikey|password|secret|token)=)[^&#\s]*/giu,
      "$1••••redacted••••",
    );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
