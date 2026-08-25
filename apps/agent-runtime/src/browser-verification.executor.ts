import {
  missingRequiredEvidenceKinds,
  runtimeCriterionResultSchema,
  runtimeEvidenceKindSchema,
  runtimeOutcomeSchema,
  runtimeTraceEventSchema,
  type RuntimeBrowserAcquireInput,
  type RuntimeEvidenceRef,
  type RuntimeModelCandidate,
  type RuntimeOutcome,
  type RuntimeTaskLease,
  type RuntimeTraceEvent,
} from "@devproof/agent-runtime-protocol";
import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";
import { z } from "zod";

import type {
  ActiveLease,
  ControlPlaneClient,
} from "./control-plane.client.js";

interface ModelFunctionCall {
  arguments: string;
  call_id: string;
  name: string;
  type: "function_call";
}

export interface ModelResponse {
  id: string;
  output: Array<ModelFunctionCall | Record<string, unknown>>;
  usage?: Record<string, unknown>;
}

interface ToolExecutionResult {
  browserCommandCount: number;
  outcome?: RuntimeOutcome;
  output: unknown;
}

export interface ResponsesClient {
  responses: {
    create(
      request: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<ModelResponse>;
  };
}

export type ResponsesClientFactory = (
  candidate: RuntimeModelCandidate,
) => ResponsesClient;

const recordCriterionInputSchema = runtimeCriterionResultSchema;
const finishInputSchema = z.object({
  summary: z.string().trim().min(1).max(8_000),
  verdict: z.enum(["PASSED", "FAILED", "INCONCLUSIVE"]),
});
const humanInputSchema = z.object({
  context: z.record(z.string(), z.unknown()).default({}),
  kind: z.string().trim().min(1).max(120).default("BROWSER_HITL"),
  prompt: z.string().trim().min(1).max(8_000),
  responseSchema: z.record(z.string(), z.unknown()).default({}),
  summary: z.string().trim().min(1).max(8_000),
});

/** Executes one leased browser-verification task without owning retry state. */
export class BrowserVerificationExecutor {
  constructor(
    private readonly modelClient: ResponsesClientFactory,
    private readonly controlPlane: ControlPlaneClient,
    private readonly toolLimit: number,
  ) {}

  async execute(
    task: RuntimeTaskLease,
    lease: ActiveLease,
    signal: AbortSignal,
  ): Promise<RuntimeOutcome> {
    const targetUrl = readTargetUrl(task.snapshot.environment);
    const browserPolicy = readBrowserPolicy(task.snapshot.executionPolicy);
    await this.acquireBrowserWithPolicy(task, lease, signal, {
      availabilityPolicy: browserPolicy.availabilityPolicy,
      profile: browserPolicy.profile,
      requiredCapabilities: browserPolicy.requiredCapabilities,
      ...(targetUrl ? { targetUrl } : {}),
    });
    const modelCandidates = task.snapshot.modelCandidates ?? [];
    if (modelCandidates.length === 0) {
      throw new Error("当前团队尚未配置 Agent 模型。");
    }
    await this.controlPlane.appendEvent(lease, "executor.started", {
      executor: "browser-verification",
      model: modelCandidates[0]?.modelId,
      modelCandidates: modelCandidates.map((candidate) => candidate.modelId),
    });

    const history: unknown[] = [
      { role: "system", content: systemPrompt() },
      {
        role: "user",
        content: taskPrompt(task, targetUrl),
      },
    ];
    const segmentId = `${task.taskId}:${lease.fencingToken}`;
    const segmentStartedAt = Date.now();
    const preferredModel = modelCandidates[0]!;
    await this.appendTraceEvent(lease, {
      kind: "agent.segment.started",
      payload: {
        attemptNumber: task.snapshot.attemptNumber,
        inputPreview: tracePreview({
          goal: task.snapshot.goal,
          humanResume: readHumanResume(task.snapshot.executionPolicy),
          targetUrl: targetUrl ?? null,
        }),
        model: preferredModel.modelId,
        provider: "OPENAI_COMPATIBLE",
        segmentId,
      },
    });
    const criterionResults = new Map<
      string,
      z.infer<typeof recordCriterionInputSchema>
    >();
    const evidence = new Map<string, RuntimeEvidenceRef>(
      task.snapshot.businessReferences.map((reference) => [
        reference.externalId,
        reference,
      ]),
    );
    let browserCommandCount = 0;
    let preserveBrowserForHuman = false;
    let segmentErrorMessage: string | undefined;
    let segmentStatus: "FAILED" | "SUCCEEDED" | "WAITING_HUMAN" = "FAILED";
    let step = 0;
    const hitlPolicy = readHitlPolicy(task.snapshot.executionPolicy);
    const deadlinePolicy = readDeadlinePolicy(task.snapshot.executionPolicy);

    try {
      for (let callCount = 0; callCount < this.toolLimit;) {
        const deadlineOutcome = deadlineFinalizationOutcome({
          browserCommandCount,
          criterionResults,
          deadlineAt: task.snapshot.deadlineAt,
          evidence,
          policy: deadlinePolicy,
          task,
        });
        if (deadlineOutcome) {
          await this.controlPlane
            .appendEvent(lease, "executor.deadline.finalized", {
              deadlineAt: task.snapshot.deadlineAt,
              reason: "FINALIZATION_RESERVE_REACHED",
            })
            .catch(() => undefined);
          segmentStatus = "SUCCEEDED";
          return deadlineOutcome;
        }
        step += 1;
        const modelInputPreview = tracePreview(history);
        let response: ModelResponse | null = null;
        let selectedModel = preferredModel;
        let selectedModelStartedAt = Date.now();
        let lastModelError: unknown;
        for (const candidate of modelCandidates) {
          const modelStartedAt = Date.now();
          await this.appendTraceEvent(lease, {
            kind: "agent.model.started",
            payload: {
              attemptNumber: task.snapshot.attemptNumber,
              inputPreview: modelInputPreview,
              model: candidate.modelId,
              provider: "OPENAI_COMPATIBLE",
              segmentId,
              step,
            },
          });
          const modelAbort = abortScope(
            signal,
            deadlinePolicy.mode === "ADAPTIVE"
              ? deadlinePolicy.maxModelCallSeconds * 1_000
              : null,
          );
          try {
            response = await this.modelClient(candidate).responses.create(
              {
                input: history,
                model: candidate.modelId,
                parallel_tool_calls: false,
                tool_choice: "required",
                tools: toolDefinitions(hitlPolicy.enabled),
              },
              { signal: modelAbort.signal },
            );
            selectedModel = candidate;
            selectedModelStartedAt = modelStartedAt;
            lastModelError = undefined;
            break;
          } catch (error) {
            const responseError =
              modelAbort.signal.aborted && !signal.aborted
                ? (modelAbort.signal.reason ?? error)
                : error;
            lastModelError = responseError;
            await this.appendTraceEvent(lease, {
              kind: "agent.model.failed",
              payload: {
                attemptNumber: task.snapshot.attemptNumber,
                durationMs: Math.max(0, Date.now() - modelStartedAt),
                errorMessage: traceErrorMessage(responseError),
                inputPreview: modelInputPreview,
                model: candidate.modelId,
                provider: "OPENAI_COMPATIBLE",
                segmentId,
                step,
              },
            });
            if (signal.aborted) throw responseError;
          } finally {
            modelAbort.dispose();
          }
        }
        if (!response) {
          throw new Error(
            `All configured model providers failed: ${traceErrorMessage(
              lastModelError ?? "No model response was returned.",
            )}`,
          );
        }
        await this.appendTraceEvent(lease, {
          kind: "agent.model.completed",
          payload: {
            attemptNumber: task.snapshot.attemptNumber,
            durationMs: Math.max(0, Date.now() - selectedModelStartedAt),
            inputPreview: modelInputPreview,
            model: selectedModel.modelId,
            outputPreview: tracePreview(response.output),
            provider: "OPENAI_COMPATIBLE",
            responseId: response.id,
            segmentId,
            step,
            ...(response.usage ? { usage: traceRecord(response.usage) } : {}),
          },
        });
        history.push(...response.output);
        const calls = response.output.filter(isFunctionCall);
        if (calls.length === 0) {
          history.push({
            role: "user",
            content: "请继续调用一个可用工具。仅返回文本无法完成验证。",
          });
          continue;
        }

        for (const call of calls) {
          callCount += 1;
          if (callCount > this.toolLimit) break;
          const toolInputPreview = traceToolInput(call.arguments);
          const toolStartedAt = Date.now();
          await this.appendTraceEvent(lease, {
            kind: "agent.tool.started",
            payload: {
              attemptNumber: task.snapshot.attemptNumber,
              callId: call.call_id,
              inputPreview: toolInputPreview,
              name: call.name,
              segmentId,
              step,
            },
          });
          let result: ToolExecutionResult;
          try {
            result = await this.executeTool({
              browserCommandCount,
              call,
              criterionResults,
              evidence,
              lease,
              signal,
              task,
            });
          } catch (error) {
            await this.appendTraceEvent(lease, {
              kind: "agent.tool.failed",
              payload: {
                attemptNumber: task.snapshot.attemptNumber,
                callId: call.call_id,
                durationMs: Math.max(0, Date.now() - toolStartedAt),
                errorMessage: traceErrorMessage(error),
                inputPreview: toolInputPreview,
                name: call.name,
                segmentId,
                step,
              },
            });
            throw error;
          }
          await this.appendTraceEvent(lease, {
            kind: "agent.tool.completed",
            payload: {
              attemptNumber: task.snapshot.attemptNumber,
              callId: call.call_id,
              durationMs: Math.max(0, Date.now() - toolStartedAt),
              inputPreview: toolInputPreview,
              name: call.name,
              outputPreview: tracePreview(result.output),
              segmentId,
              sourceRefs: [],
              status: traceToolFailed(result.output) ? "FAILED" : "SUCCEEDED",
              step,
            },
          });
          browserCommandCount = result.browserCommandCount;
          if (result.outcome) {
            preserveBrowserForHuman = result.outcome.kind === "WAITING_HUMAN";
            segmentStatus = preserveBrowserForHuman
              ? "WAITING_HUMAN"
              : "SUCCEEDED";
            return result.outcome;
          }
          history.push({
            call_id: call.call_id,
            output: JSON.stringify(result.output),
            type: "function_call_output",
          });
        }
      }

      return runtimeOutcomeSchema.parse({
        error: {
          code: "AGENT_TOOL_LIMIT_EXCEEDED",
          failureClass: "TOOL_EXECUTION",
          message: `浏览器验证超过 ${this.toolLimit} 次工具调用上限。`,
          phase: "browser_verification",
        },
        executionDisposition:
          browserCommandCount > 0 ? "AGENT_ERROR" : "NOT_RUN",
        kind: "RETRYABLE_FAILURE",
        summary: "Agent 未能在工具调用预算内完成验证。",
      });
    } catch (error) {
      segmentErrorMessage = traceErrorMessage(error);
      throw error;
    } finally {
      try {
        await this.appendTraceEvent(lease, {
          kind: "agent.segment.completed",
          payload: {
            attemptNumber: task.snapshot.attemptNumber,
            durationMs: Math.max(0, Date.now() - segmentStartedAt),
            segmentId,
            status: segmentStatus,
            ...(segmentErrorMessage
              ? { errorMessage: segmentErrorMessage }
              : {}),
          },
        });
      } finally {
        if (!preserveBrowserForHuman) {
          await this.controlPlane
            .releaseBrowser(lease)
            .catch(async (error: unknown) => {
              await this.controlPlane
                .appendEvent(lease, "browser.release.deferred", {
                  message:
                    error instanceof Error ? error.message : String(error),
                })
                .catch(() => undefined);
            });
        }
      }
    }
  }

  private appendTraceEvent(lease: ActiveLease, event: RuntimeTraceEvent) {
    const parsed = runtimeTraceEventSchema.parse(event);
    return this.controlPlane.appendEvent(lease, parsed.kind, parsed.payload);
  }

  private async acquireBrowserWithPolicy(
    task: RuntimeTaskLease,
    lease: ActiveLease,
    signal: AbortSignal,
    execution: RuntimeBrowserAcquireInput["execution"],
  ) {
    for (;;) {
      const result = await this.controlPlane.acquireBrowser(lease, execution);
      if (result.status === "ACQUIRED") return result;

      if (
        Date.now() + result.retryAfterMs >=
        Date.parse(task.snapshot.deadlineAt)
      ) {
        throw new Error(
          `等待浏览器容量时超过获取截止时间（${result.reason}）。`,
        );
      }
      await abortableDelay(result.retryAfterMs, signal);
    }
  }

  private async executeTool(input: {
    browserCommandCount: number;
    call: ModelFunctionCall;
    criterionResults: Map<string, z.infer<typeof recordCriterionInputSchema>>;
    evidence: Map<string, RuntimeEvidenceRef>;
    lease: ActiveLease;
    signal: AbortSignal;
    task: RuntimeTaskLease;
  }): Promise<ToolExecutionResult> {
    let raw: unknown;
    try {
      raw = JSON.parse(input.call.arguments) as unknown;
    } catch {
      return correction(
        input.browserCommandCount,
        "工具参数必须是有效的 JSON。",
      );
    }

    if (input.call.name === "browser_command") {
      const parsed = runtimeActionCommandInputSchema.safeParse(raw);
      if (!parsed.success) {
        return correction(input.browserCommandCount, parsed.error.message);
      }
      try {
        const result = await this.controlPlane.browserCommand(
          input.lease,
          parsed.data,
          input.signal,
        );
        collectEvidence(result, input.evidence);
        return {
          browserCommandCount: input.browserCommandCount + 1,
          output: result,
        };
      } catch (error) {
        return correction(
          input.browserCommandCount + 1,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (input.call.name === "record_criterion") {
      const parsed = recordCriterionInputSchema.safeParse(raw);
      if (!parsed.success) {
        return correction(input.browserCommandCount, parsed.error.message);
      }
      const chineseError = requireChineseText(
        parsed.data.summary,
        "record_criterion.summary",
      );
      if (chineseError) {
        return correction(input.browserCommandCount, chineseError);
      }
      const criterion = input.task.snapshot.criteria.find(
        (item) => item.id === parsed.data.criterionId,
      );
      if (!criterion) {
        return correction(
          input.browserCommandCount,
          `未知的验收标准：${parsed.data.criterionId}。`,
        );
      }
      const unavailable = parsed.data.evidenceRefs.filter(
        (reference) => !input.evidence.has(reference),
      );
      if (unavailable.length > 0) {
        return correction(
          input.browserCommandCount,
          `验收标准引用了尚未观察到的证据：${unavailable.join(", ")}。`,
        );
      }
      if (parsed.data.status === "PASSED") {
        const missingKinds = missingRequiredEvidenceKinds(
          criterion,
          parsed.data.evidenceRefs,
          input.evidence.values(),
        );
        if (missingKinds.length > 0) {
          return correction(
            input.browserCommandCount,
            `通过的验收标准缺少必需证据类型：${missingKinds.join(", ")}。请采集或引用对应证据，否则将该标准记录为 INCONCLUSIVE。`,
          );
        }
      }
      input.criterionResults.set(parsed.data.criterionId, parsed.data);
      return {
        browserCommandCount: input.browserCommandCount,
        output: { accepted: true },
      };
    }

    if (input.call.name === "request_human_input") {
      const hitlPolicy = readHitlPolicy(input.task.snapshot.executionPolicy);
      const deadlinePolicy = readDeadlinePolicy(
        input.task.snapshot.executionPolicy,
      );
      if (!hitlPolicy.enabled) {
        return correction(
          input.browserCommandCount,
          "当前 Run 已禁用 HITL。请继续自主执行，或以 INCONCLUSIVE 结论结束。",
        );
      }
      const parsed = humanInputSchema.safeParse(raw);
      if (!parsed.success) {
        return correction(input.browserCommandCount, parsed.error.message);
      }
      const chineseError =
        requireChineseText(parsed.data.prompt, "request_human_input.prompt") ??
        requireChineseText(parsed.data.summary, "request_human_input.summary");
      if (chineseError) {
        return correction(input.browserCommandCount, chineseError);
      }
      return {
        browserCommandCount: input.browserCommandCount,
        outcome: runtimeOutcomeSchema.parse({
          executionDisposition: "BLOCKED",
          intervention: {
            context: parsed.data.context,
            expiresAt: new Date(
              Math.min(
                Date.now() + hitlPolicy.timeoutSeconds * 1_000,
                Date.parse(
                  deadlinePolicy.mode === "ADAPTIVE" &&
                    deadlinePolicy.refundHumanWait
                    ? (input.task.snapshot.hardDeadlineAt ??
                        input.task.snapshot.deadlineAt)
                    : input.task.snapshot.deadlineAt,
                ),
              ),
            ).toISOString(),
            kind: parsed.data.kind,
            prompt: parsed.data.prompt,
            responseSchema: parsed.data.responseSchema,
          },
          kind: "WAITING_HUMAN",
          summary: parsed.data.summary,
        }),
        output: { accepted: true },
      };
    }

    if (input.call.name === "finish_verification") {
      const parsed = finishInputSchema.safeParse(raw);
      if (!parsed.success) {
        return correction(input.browserCommandCount, parsed.error.message);
      }
      const chineseError = requireChineseText(
        parsed.data.summary,
        "finish_verification.summary",
      );
      if (chineseError) {
        return correction(input.browserCommandCount, chineseError);
      }
      if (input.browserCommandCount === 0) {
        return correction(
          input.browserCommandCount,
          "完成验证前至少需要执行一次浏览器命令。",
        );
      }
      const missing = input.task.snapshot.criteria
        .filter((criterion) => criterion.required)
        .filter((criterion) => !input.criterionResults.has(criterion.id));
      if (missing.length > 0) {
        return correction(
          input.browserCommandCount,
          `完成验证前必须记录所有必需的验收标准：${missing
            .map((criterion) => criterion.id)
            .join(", ")}。`,
        );
      }
      const criteria = input.task.snapshot.criteria
        .map((criterion) => input.criterionResults.get(criterion.id))
        .filter(
          (
            criterion,
          ): criterion is z.infer<typeof recordCriterionInputSchema> =>
            criterion !== undefined,
        );
      const outcome = runtimeOutcomeSchema.safeParse({
        criteria,
        evidence: [...input.evidence.values()],
        executionDisposition: "EXECUTED",
        kind: "VERIFICATION_COMPLETED",
        summary: parsed.data.summary,
        verdict: parsed.data.verdict,
      });
      if (!outcome.success) {
        return correction(input.browserCommandCount, outcome.error.message);
      }
      return {
        browserCommandCount: input.browserCommandCount,
        outcome: outcome.data,
        output: { accepted: true },
      };
    }

    return correction(
      input.browserCommandCount,
      `未知工具：${input.call.name}。`,
    );
  }
}

function correction(browserCommandCount: number, message: string) {
  return {
    browserCommandCount,
    output: { accepted: false, error: message },
  };
}

const CHINESE_TEXT = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

function requireChineseText(value: string, field: string) {
  return CHINESE_TEXT.test(value)
    ? null
    : `${field} 必须使用简体中文；标识符、URL 和代码符号可以保持原样。`;
}

const SENSITIVE_TRACE_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|session(?:id)?)$/iu;
const TRACE_ARRAY_LIMIT = 20;
const TRACE_KEY_LIMIT = 40;
const TRACE_STRING_LIMIT = 2_000;

function traceToolInput(argumentsValue: string): unknown {
  try {
    return tracePreview(JSON.parse(argumentsValue) as unknown);
  } catch {
    return tracePreview(argumentsValue);
  }
}

function traceRecord(value: Record<string, unknown>): Record<string, unknown> {
  const preview = tracePreview(value);
  return preview && typeof preview === "object" && !Array.isArray(preview)
    ? (preview as Record<string, unknown>)
    : {};
}

function tracePreview(value: unknown, depth = 0): unknown {
  if (typeof value === "string")
    return redactTraceText(value).slice(0, TRACE_STRING_LIMIT);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (depth >= 6) return "[depth limit]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, TRACE_ARRAY_LIMIT)
      .map((item) => tracePreview(item, depth + 1));
    return value.length > TRACE_ARRAY_LIMIT
      ? [...items, `[${value.length - TRACE_ARRAY_LIMIT} more items]`]
      : items;
  }
  if (!value || typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, TRACE_KEY_LIMIT)
      .map(([key, child]) => [
        key,
        SENSITIVE_TRACE_KEY.test(key)
          ? "••••redacted••••"
          : tracePreview(child, depth + 1),
      ]),
  );
}

function redactTraceText(value: string): string {
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
    )
    .replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
      try {
        const url = new URL(candidate);
        url.username = "";
        url.password = "";
        for (const key of url.searchParams.keys()) {
          if (SENSITIVE_TRACE_KEY.test(key)) {
            url.searchParams.set(key, "••••redacted••••");
          }
        }
        return url.toString();
      } catch {
        return candidate;
      }
    });
}

function traceToolFailed(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.accepted === false || record.status === "FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function traceErrorMessage(error: unknown): string {
  return redactTraceText(errorMessage(error)).slice(0, 4_000);
}

function isFunctionCall(item: unknown): item is ModelFunctionCall {
  return (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    item.type === "function_call" &&
    "name" in item &&
    "arguments" in item &&
    "call_id" in item
  );
}

function collectEvidence(
  value: unknown,
  target: Map<string, RuntimeEvidenceRef>,
) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectEvidence(item, target));
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.artifacts)) {
      record.artifacts.forEach((item) => {
        if (!item || typeof item !== "object") return;
        const artifact = item as Record<string, unknown>;
        const kind = runtimeEvidenceKindSchema.safeParse(artifact.kind);
        if (typeof artifact.id !== "string" || !kind.success) return;
        const externalId = `artifact://${artifact.id}`;
        target.set(externalId, {
          externalId,
          kind: kind.data,
          label: typeof artifact.label === "string" ? artifact.label : "",
          metadata:
            artifact.metadata && typeof artifact.metadata === "object"
              ? (artifact.metadata as Record<string, unknown>)
              : {},
        });
      });
    }
    if (Array.isArray(record.evidenceRefs)) {
      record.evidenceRefs.forEach((externalId) => {
        if (
          typeof externalId === "string" &&
          /^artifact:\/\//u.test(externalId) &&
          !target.has(externalId)
        ) {
          target.set(externalId, {
            externalId,
            kind: "ARTIFACT",
            label: "",
            metadata: {},
          });
        }
      });
    }
    Object.values(record).forEach((item) => collectEvidence(item, target));
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function readTargetUrl(environment: Record<string, unknown>) {
  for (const key of ["targetUrl", "baseUrl"]) {
    const value = environment[key];
    if (typeof value === "string" && /^https?:\/\//iu.test(value)) return value;
  }
  return undefined;
}

type RuntimeDeadlinePolicy =
  | { mode: "FIXED" }
  | {
      finalizationReserveSeconds: number;
      maxModelCallSeconds: number;
      mode: "ADAPTIVE";
      refundHumanWait: boolean;
    };

function readDeadlinePolicy(
  executionPolicy: Record<string, unknown>,
): RuntimeDeadlinePolicy {
  const value =
    executionPolicy.deadline &&
    typeof executionPolicy.deadline === "object" &&
    !Array.isArray(executionPolicy.deadline)
      ? (executionPolicy.deadline as Record<string, unknown>)
      : {};
  if (value.mode !== "ADAPTIVE") return { mode: "FIXED" };
  return {
    finalizationReserveSeconds: boundedInteger(
      value.finalizationReserveSeconds,
      15,
      300,
      60,
    ),
    maxModelCallSeconds: boundedInteger(
      value.maxModelCallSeconds,
      60,
      900,
      300,
    ),
    mode: "ADAPTIVE",
    refundHumanWait:
      typeof value.refundHumanWait === "boolean" ? value.refundHumanWait : true,
  };
}

function deadlineFinalizationOutcome(input: {
  browserCommandCount: number;
  criterionResults: Map<string, z.infer<typeof recordCriterionInputSchema>>;
  deadlineAt: string;
  evidence: Map<string, RuntimeEvidenceRef>;
  policy: RuntimeDeadlinePolicy;
  task: RuntimeTaskLease;
}): RuntimeOutcome | null {
  if (input.policy.mode !== "ADAPTIVE" || input.browserCommandCount === 0) {
    return null;
  }
  const remainingMs = Date.parse(input.deadlineAt) - Date.now();
  if (remainingMs > input.policy.finalizationReserveSeconds * 1_000) {
    return null;
  }
  const missingRequired = input.task.snapshot.criteria.some(
    (criterion) =>
      criterion.required && !input.criterionResults.has(criterion.id),
  );
  if (missingRequired) return null;
  const criteria = input.task.snapshot.criteria
    .map((criterion) => input.criterionResults.get(criterion.id))
    .filter(
      (criterion): criterion is z.infer<typeof recordCriterionInputSchema> =>
        criterion !== undefined,
    );
  if (criteria.length === 0) return null;
  const statuses = criteria.map((criterion) => criterion.status);
  const verdict = statuses.includes("FAILED")
    ? "FAILED"
    : statuses.includes("INCONCLUSIVE")
      ? "INCONCLUSIVE"
      : "PASSED";
  const summary = [
    "已在执行截止时间前根据记录的验收标准完成验证。",
    ...criteria.map(
      (criterion) => `${criterion.criterionId}: ${criterion.summary}`,
    ),
  ]
    .join("\n")
    .slice(0, 8_000);
  return runtimeOutcomeSchema.parse({
    criteria,
    evidence: [...input.evidence.values()],
    executionDisposition: "EXECUTED",
    kind: "VERIFICATION_COMPLETED",
    summary,
    verdict,
  });
}

function abortScope(parent: AbortSignal, timeoutMs: number | null) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new Error(`模型响应超过 ${Math.round(timeoutMs / 1_000)} 秒。`),
            ),
          timeoutMs,
        );
  timer?.unref();
  return {
    dispose() {
      if (timer) clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
    signal: controller.signal,
  };
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function readBrowserPolicy(policy: Record<string, unknown>) {
  const browser =
    policy.browser && typeof policy.browser === "object"
      ? (policy.browser as Record<string, unknown>)
      : {};
  const profile =
    browser.profile && typeof browser.profile === "object"
      ? (browser.profile as Record<string, unknown>)
      : {};
  const mode = profile.mode === "PERSISTENT" ? "PERSISTENT" : "EPHEMERAL";
  const key = typeof profile.key === "string" ? profile.key : undefined;
  return {
    availabilityPolicy:
      browser.availabilityPolicy === "FAIL_FAST" ? "FAIL_FAST" : "WAIT",
    profile: { ...(key ? { key } : {}), mode },
    requiredCapabilities: Array.isArray(browser.requiredCapabilities)
      ? browser.requiredCapabilities.filter(
          (item): item is string => typeof item === "string",
        )
      : ["browser"],
  } as const;
}

function toolDefinitions(hitlEnabled = true) {
  return [
    {
      type: "function",
      name: "browser_command",
      description:
        "执行一次浏览器操作。先使用 page.navigate 和 page.snapshot，并复用返回的 ref；判断验收标准前要采集持久化证据。SPA 跳转优先等待特定 selector 或文本，不要优先使用 networkidle。NETWORK 证据需要响应数据时，调用 page.network，并设置 includeResponseBodies 和尽可能精确的 urlIncludes。",
      parameters: openAiFunctionSchema(runtimeActionCommandInputSchema),
      strict: false,
    },
    {
      type: "function",
      name: "record_criterion",
      description:
        "仅根据实际观察到的浏览器证据，用简体中文记录一条已声明验收标准的结果。",
      parameters: openAiFunctionSchema(recordCriterionInputSchema),
      strict: false,
    },
    ...(hitlEnabled
      ? [
          {
            type: "function",
            name: "request_human_input",
            description:
              "仅在确实需要人工操作（例如验证码或审批）时暂停 Run；面向用户的提示和摘要必须使用简体中文。",
            parameters: openAiFunctionSchema(humanInputSchema),
            strict: false,
          },
        ]
      : []),
    {
      type: "function",
      name: "finish_verification",
      description:
        "只有在完成浏览器交互并记录全部必需验收标准后才能结束验证；最终摘要必须使用简体中文。",
      parameters: openAiFunctionSchema(finishInputSchema),
      strict: false,
    },
  ];
}

/**
 * Model providers and OpenAI-compatible gateways accept different subsets of
 * JSON Schema string formats. Zod emits validation-only annotations such as
 * `format: "uri"` and `format: "uuid"`, which some providers reject before the
 * model can execute any browser work. Runtime validation still enforces those
 * constraints after the function call, so removing the annotations does not
 * weaken the control-plane boundary.
 *
 * The tools intentionally use `strict: false`: the browser protocol has real
 * optional/defaulted fields, while OpenAI strict tools require every property
 * to appear in `required`. Zod parsing in executeTool remains authoritative.
 */
function openAiFunctionSchema(schema: z.ZodType) {
  return stripValidationFormats(z.toJSONSchema(schema));
}

function stripValidationFormats(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripValidationFormats);
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      key === "format" ? [] : [[key, stripValidationFormats(child)]],
    ),
  );
}

function taskPrompt(task: RuntimeTaskLease, targetUrl?: string) {
  return JSON.stringify(
    {
      acceptanceCriteria: task.snapshot.criteria,
      availableBusinessReferences: task.snapshot.businessReferences,
      goal: task.snapshot.goal,
      humanResume: readHumanResume(task.snapshot.executionPolicy),
      languageRequirement:
        "所有用户可见的分析、验收标准结果、人工接管提示和最终摘要必须使用简体中文。",
      targetUrl: targetUrl ?? null,
    },
    null,
    2,
  );
}

function readHitlPolicy(policy: Record<string, unknown>) {
  const value =
    policy.hitl && typeof policy.hitl === "object"
      ? (policy.hitl as Record<string, unknown>)
      : {};
  const timeout = Number(value.timeoutSeconds);
  return {
    enabled: value.enabled !== false,
    timeoutSeconds:
      Number.isInteger(timeout) && timeout >= 30 && timeout <= 604_800
        ? timeout
        : 3_600,
  };
}

function readHumanResume(policy: Record<string, unknown>) {
  const value =
    policy.resume && typeof policy.resume === "object"
      ? (policy.resume as Record<string, unknown>)
      : null;
  if (!value) return null;
  return {
    interventionId:
      typeof value.interventionId === "string" ? value.interventionId : null,
    resolvedAt: typeof value.resolvedAt === "string" ? value.resolvedAt : null,
    response:
      value.response && typeof value.response === "object"
        ? value.response
        : {},
  };
}

function systemPrompt() {
  return `你是 DevProof 内部的浏览器验证执行 Agent。
你只负责浏览器内的分析和操作；Run 生命周期、重试、租约、取消、HITL 和清理由 DevProof 管理。
使用 browser_command 检查并操作真实页面。绝不能声称观察到了工具未返回的内容。
对每条已声明的验收标准调用 record_criterion；如需修正，可以更新同一条标准。证据引用必须来自 browser_command 的输出。
任务提供的业务引用是不可变的已观察证据；支持某条验收标准时，必须引用其准确的 externalId。
客户端导航后要等待明确的 selector 或文本。除非确定应用最终会完全空闲，否则避免使用 networkidle。
页面包含 wujie-app 微前端时，snapshot 和文本目标应限定在 wujie-app 内，不要使用通用 body 或 #root selector。
NETWORK 证据需要响应内容时，使用 page.network，设置 includeResponseBodies=true，并提供尽可能精确的 urlIncludes。
只有无法自主继续时才能调用 request_human_input。至少执行一次浏览器操作并记录所有必需验收标准后，才能调用 finish_verification。
所有用户可见的生成内容必须使用简体中文，包括验收标准摘要、HITL 提示、等待摘要和最终验证摘要。标识符、URL、代码符号、API 路径、工具名、枚举值和 evidence reference 保持原样，不要翻译。
绝不能调用会话生命周期操作，也绝不能泄露凭据。`;
}
