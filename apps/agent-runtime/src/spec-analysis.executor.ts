import {
  validateCaseAccountRequirements,
  accountRequirementIssuesMessage,
  OBSERVATION_CONTRACT_GUIDANCE,
  BUSINESS_CHECK_GUIDANCE,
} from "@devproof/agent-runtime-protocol";
import { randomUUID } from "node:crypto";

import {
  runtimeGeneratedSpecSchema,
  runtimeGeneratedSpecCaseSchema,
  runtimeSpecCriterionSchema,
  runtimeSpecAnalysisOutcomeSchema,
  runtimeTraceEventSchema,
  specSelectedSourceCoverageError,
  specRequirementCoverageError,
  specCapabilityError,
  specNecessityError,
  SPEC_EXECUTION_SCOPE_GUIDANCE,
  SPEC_NECESSITY_GUIDANCE,
  type RuntimeSpecAnalysisOutcome,
  type RuntimeSpecAnalysisTaskLease,
  type RuntimeSpecSourceRef,
  type RuntimeTraceEvent,
} from "@devproof/agent-runtime-protocol";
import { z } from "zod";
import { ModelHealth } from "./model-health.js";
import { isInvalidModelToolSchema } from "./model-tool-schema.js";
import { hasExternalCaseDependency } from "./spec-case-dependency.js";
import {
  compactSpecSchema,
  defineSpecRequirements,
  normalizeCompactSpec,
  referencedSpecSchema,
  requirementPlanSchema,
  specCheckSchema,
  type SpecRequirement,
} from "./spec-draft.js";
import {
  defineChecksSchema,
  defineBusinessChecksSchema,
  SpecCheckCatalog,
} from "./spec-check-catalog.js";
import { specCriterionIssues } from "./spec-criterion-validation.js";

import {
  ControlPlaneError,
  type ActiveLease,
  type ControlPlaneClient,
} from "./control-plane.client.js";
import {
  modelFunctionCalls,
  type ModelCompletion,
  type ModelClientFactory,
  type ModelFunctionCall,
  type ModelMessage,
  type ModelAssistantMessage,
} from "./model-types.js";

const analysisSummarySchema = z.string().trim().min(1).max(4_000);
const finishSpecSchema = z.object({
  analysisSummary: analysisSummarySchema,
  spec: runtimeGeneratedSpecSchema.extend({
    cases: z
      .array(
        runtimeGeneratedSpecCaseSchema.extend({
          criteria: z
            .array(
              runtimeSpecCriterionSchema.safeExtend({
                basis: runtimeSpecCriterionSchema.shape.basis.unwrap(),
                observationTargets: specCheckSchema.shape.observationTargets,
                requiredEvidenceKinds:
                  specCheckSchema.shape.requiredEvidenceKinds.removeDefault(),
              }),
            )
            .min(1)
            .max(100),
        }),
      )
      .min(1)
      .max(100),
  }),
});
const MAX_CONSECUTIVE_SOURCE_FAILURES = 2;
const MAX_TEXT_ONLY_STEPS = 4;

type SourceToolName =
  | "get_task_context"
  | "linear_get_issue"
  | "github_get_pull_request"
  | "github_list_changed_files"
  | "github_read_file"
  | "github_search_code";

export class SpecAnalysisExecutor {
  private readonly modelHealth = new ModelHealth();
  constructor(
    private readonly modelClient: ModelClientFactory,
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
    const checkReferences = task.snapshot.specFormat === "CHECK_REFERENCES";
    const compact = checkReferences || task.snapshot.specFormat === "COMPACT";
    const checkCatalog = new SpecCheckCatalog(
      task.snapshot.observationContractVersion === 3,
    );
    let requirements: SpecRequirement[] | null = null;
    const issueTexts = new Map<string, string>();
    const history: ModelMessage[] = [
      {
        role: "system",
        content:
          systemPrompt(
            compact,
            checkReferences,
            task.snapshot.observationContractVersion === 3,
          ) +
          (task.snapshot.observationContractVersion === 2
            ? "\n\n" + OBSERVATION_CONTRACT_GUIDANCE
            : ""),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            issueRef: task.snapshot.issueRef,
            pullRequestUrls: task.snapshot.pullRequestUrls,
            goal: task.snapshot.goal,
            objective:
              "分析选定的测试说明、Issue、PR 和相关代码，生成优先覆盖本次必要业务结果的中文测试规格；保留明确要求，避免扩展为整页回归。",
            targetUrl: task.snapshot.targetUrl ?? null,
          },
          null,
          2,
        ),
      },
    ];
    const sources = new Map<string, RuntimeSpecSourceRef>();
    const sourceContents = new Map<string, string>();
    const calledTools = new Set<string>();
    const sourceFailureCounts = new Map<SourceToolName, number>();
    const unavailableTools = new Set<SourceToolName>();
    let linkedPullRequests: Array<{ url: string; changedFiles?: string[] }> =
      [];
    let segmentStatus: "FAILED" | "SUCCEEDED" | "WAITING_HUMAN" = "FAILED";
    let segmentError: string | undefined;
    let leaseRejected = false;
    let step = 0;
    let textOnlySteps = 0;

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
        let response: ModelCompletion | null = null;
        let selectedModel = preferredModel;
        let selectedStartedAt = Date.now();
        let selectedModelCallId: string | undefined;
        let selectedModelAttempt = 1;
        let lastError: unknown;
        let lastSchemaError: unknown;
        const schemaRejectedCandidates = new Set<(typeof candidates)[number]>();

        for (const {
          candidate,
          modelAttempt,
          maxModelAttempts,
        } of this.modelHealth.attempts(candidates)) {
          signal.throwIfAborted();
          if (schemaRejectedCandidates.has(candidate)) continue;
          const modelStartedAt = Date.now();
          const modelCallId = randomUUID();
          await this.appendTrace(lease, signal, {
            kind: "agent.model.started",
            payload: {
              modelCallId,
              attemptNumber: task.snapshot.attemptNumber,
              inputPreview: { ...inputPreview, modelAttempt, maxModelAttempts },
              model: candidate.modelId,
              provider: "OPENAI_COMPATIBLE",
              segmentId,
              step,
            },
          });
          try {
            response = await this.modelClient(candidate).complete(
              {
                messages: structuredClone(history),
                model: candidate.modelId,
                parallel_tool_calls: false,
                tool_choice: "auto",
                stream: false,
                tools: toolDefinitions(
                  sources.keys(),
                  unavailableTools,
                  calledTools.has("get_task_context") ||
                    calledTools.has("linear_get_issue"),
                  linkedPullRequests.map((pr) => pr.url),
                  compact,
                  requirements,
                  checkReferences ? checkCatalog : undefined,
                  task.snapshot.observationContractVersion === 3,
                ),
              },
              { signal },
            );
            selectedModel = candidate;
            this.modelHealth.success(candidate);
            selectedModelCallId = modelCallId;
            selectedModelAttempt = modelAttempt;
            selectedStartedAt = modelStartedAt;
            lastError = undefined;
            break;
          } catch (error) {
            signal.throwIfAborted();
            lastError = error;
            const schemaRejected = isInvalidModelToolSchema(error);
            if (schemaRejected) {
              schemaRejectedCandidates.add(candidate);
              lastSchemaError = error;
            }
            const candidateHealth = schemaRejected
              ? null
              : this.modelHealth.failure(candidate, error);
            await this.appendTrace(lease, signal, {
              kind: "agent.model.failed",
              payload: {
                modelCallId,
                attemptNumber: task.snapshot.attemptNumber,
                durationMs: Date.now() - modelStartedAt,
                errorMessage: traceError(error),
                inputPreview: {
                  ...inputPreview,
                  candidateHealth,
                  modelAttempt,
                  maxModelAttempts,
                },
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
            `All configured model providers failed: ${traceError(lastSchemaError ?? lastError ?? "Configured candidates are temporarily unavailable after previous provider failures.")}`,
          );
        }
        await this.appendTrace(lease, signal, {
          kind: "agent.model.completed",
          payload: {
            modelCallId: selectedModelCallId,
            attemptNumber: task.snapshot.attemptNumber,
            durationMs: Date.now() - selectedStartedAt,
            inputPreview: {
              ...inputPreview,
              modelAttempt: selectedModelAttempt,
            },
            model: selectedModel.modelId,
            outputPreview: modelOutputPreview(response.message),
            provider: "OPENAI_COMPATIBLE",
            responseId: response.id,
            segmentId,
            step,
            ...(response.usage ? { usage: traceRecord(response.usage) } : {}),
          },
        });
        history.push(response.message);
        const calls = modelFunctionCalls(response.message);
        if (!calls.length) {
          if (++textOnlySteps >= MAX_TEXT_ONLY_STEPS) {
            throw new Error(
              "Spec analysis stopped after repeated text-only responses without tool calls.",
            );
          }
          history.push({
            role: "user",
            content:
              "请继续调用且只调用一个可用工具。仅返回文本无法完成 Spec 分析。",
          });
          continue;
        }

        textOnlySteps = 0;
        for (const call of calls) {
          signal.throwIfAborted();
          callCount += 1;
          if (callCount > this.toolLimit) break;
          const startedAt = Date.now();
          const parsedArguments = parseArguments(call.function.arguments);
          const summary = analysisSummary(parsedArguments);
          if (!summary) {
            await this.appendTrace(lease, signal, {
              kind: "agent.tool.started",
              payload: {
                attemptNumber: task.snapshot.attemptNumber,
                callId: call.id,
                inputPreview: tracePreview(parsedArguments),
                name: call.function.name,
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
              callId: call.id,
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
              callId: call.id,
              inputPreview: tracePreview(parsedArguments),
              name: call.function.name,
              segmentId,
              step,
            },
          });
          signal.throwIfAborted();

          if (call.function.name === "request_analysis_input") {
            const request = z
              .object({ message: z.string().trim().min(1).max(4_000) })
              .safeParse(parsedArguments);
            if (
              !request.success ||
              !(
                calledTools.has("get_task_context") ||
                calledTools.has("linear_get_issue")
              )
            ) {
              await this.toolCorrection(
                lease,
                signal,
                task,
                segmentId,
                step,
                call,
                startedAt,
                "请先读取任务上下文，并说明需要澄清的具体验收目标。",
              );
              history.push(
                toolOutput(call, {
                  accepted: false,
                  error: "请先读取任务上下文，并说明需要澄清的具体验收目标。",
                }),
              );
              continue;
            }
            await this.appendTrace(lease, signal, {
              kind: "agent.tool.completed",
              payload: {
                attemptNumber: task.snapshot.attemptNumber,
                callId: call.id,
                durationMs: Date.now() - startedAt,
                name: call.function.name,
                inputPreview: tracePreview(parsedArguments),
                outputPreview: { message: request.data.message },
                segmentId,
                sourceRefs: [],
                status: "SUCCEEDED",
                step,
              },
            });
            segmentStatus = "WAITING_HUMAN";
            return {
              kind: "INPUT_REQUIRED",
              summary: request.data.message,
              request: {
                missing: ["TEST_INTENT"],
                message: request.data.message,
                issueRef: task.snapshot.issueRef ?? "",
                goal: task.snapshot.goal,
                pullRequestUrls: linkedPullRequests.map((item) => item.url),
                deploymentCandidates: [],
              },
            };
          }

          if (compact && call.function.name === "define_requirements") {
            try {
              const coverageError = sourceCoverageError({
                calledTools,
                linkedPullRequests,
                sources,
                unavailableTools,
              });
              if (coverageError) throw new Error(coverageError);
              if (requirements)
                throw new Error(
                  "需求清单已确定，不能为通过校验删除需求。无法验证的需求请在 uncoveredRequirements 中说明原因。",
                );
              requirements = defineSpecRequirements(
                parsedArguments,
                sourceContents,
                sources,
                issueTexts,
              );
              history.push(toolOutput(call, { accepted: true, requirements }));
              await this.appendTrace(lease, signal, {
                kind: "agent.tool.completed",
                payload: {
                  attemptNumber: task.snapshot.attemptNumber,
                  callId: call.id,
                  durationMs: Date.now() - startedAt,
                  name: call.function.name,
                  inputPreview: tracePreview(parsedArguments),
                  outputPreview: tracePreview({ requirements }),
                  segmentId,
                  sourceRefs: requirements.map((item) => item.sourceRef),
                  status: "SUCCEEDED",
                  step,
                },
              });
            } catch (error) {
              const message = traceError(error);
              await this.toolCorrection(
                lease,
                signal,
                task,
                segmentId,
                step,
                call,
                startedAt,
                message,
              );
              history.push(
                toolOutput(call, {
                  accepted: false,
                  error: message,
                  requirements,
                }),
              );
            }
            continue;
          }

          if (checkReferences && call.function.name === "define_checks") {
            try {
              if (!requirements)
                throw new Error(
                  "请先调用 define_requirements 确定完整需求清单。",
                );
              const result = checkCatalog.define(
                parsedArguments,
                requirements,
                sourceContents,
              );
              history.push(toolOutput(call, result));
              await this.appendTrace(lease, signal, {
                kind: "agent.tool.completed",
                payload: {
                  attemptNumber: task.snapshot.attemptNumber,
                  callId: call.id,
                  durationMs: Date.now() - startedAt,
                  name: call.function.name,
                  segmentId,
                  step,
                  inputPreview: tracePreview(parsedArguments),
                  outputPreview: tracePreview({
                    ...result,
                    ...(result.issues.length
                      ? {
                          error: result.issues
                            .map((issue) => issue.message)
                            .join("\n")
                            .slice(0, 4_000),
                        }
                      : {}),
                  }),
                  sourceRefs: [],
                  status: result.accepted ? "SUCCEEDED" : "FAILED",
                },
              });
            } catch (error) {
              const message = traceError(error);
              await this.toolCorrection(
                lease,
                signal,
                task,
                segmentId,
                step,
                call,
                startedAt,
                message,
              );
              history.push(
                toolOutput(call, {
                  accepted: false,
                  error: message,
                  revision: checkCatalog.revision,
                }),
              );
            }
            continue;
          }

          if (call.function.name === "finish_spec") {
            let argumentsToValidate = parsedArguments;
            if (compact) {
              try {
                if (!requirements)
                  throw new Error(
                    "请先调用 define_requirements 确定完整需求清单，再提交用例。",
                  );
                argumentsToValidate = {
                  ...parsedArguments,
                  spec: checkReferences
                    ? checkCatalog.expand(parsedArguments.spec, requirements)
                    : normalizeCompactSpec(parsedArguments.spec, requirements),
                };
              } catch (error) {
                const message = traceError(error);
                await this.toolCorrection(
                  lease,
                  signal,
                  task,
                  segmentId,
                  step,
                  call,
                  startedAt,
                  message,
                );
                history.push(
                  toolOutput(call, specCorrection(message, sources.keys())),
                );
                continue;
              }
            }
            const parsed = finishSpecSchema.safeParse(argumentsToValidate);
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
            parsed.data.spec.scopePolicy = "CHANGE_FOCUSED";
            const unsupportedBusiness =
              task.snapshot.observationContractVersion !== 3 &&
              parsed.data.spec.cases.some((c) =>
                c.criteria.some(
                  (check) => check.observationContract?.version === 3,
                ),
              );
            const validationError = unsupportedBusiness
              ? "当前任务未协商业务验收格式，请使用任务支持的旧格式。"
              : validateFinalSpec({
                  issueTexts,
                  calledTools,
                  linkedPullRequests,
                  sources,
                  sourceContents,
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
                callId: call.id,
                durationMs: Date.now() - startedAt,
                inputPreview: tracePreview({
                  analysisSummary: parsed.data.analysisSummary,
                  caseCount: parsed.data.spec.cases.length,
                }),
                name: call.function.name,
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

          if (!isSourceToolName(call.function.name)) {
            const error = `未知的 Spec 分析工具：${call.function.name}`;
            await this.appendTrace(
              lease,
              signal,
              toolFailed(task, segmentId, step, call, startedAt, error),
            );
            history.push(toolOutput(call, { accepted: false, error }));
            continue;
          }
          const sourceToolName = call.function.name;
          const sourceToolError = unavailableTools.has(sourceToolName)
            ? `数据源 ${sourceToolName} 已标记为不可用，请使用其余来源并说明风险。`
            : sourceToolName !== "get_task_context" &&
                sourceToolName !== "linear_get_issue" &&
                (!(
                  calledTools.has("get_task_context") ||
                  calledTools.has("linear_get_issue")
                ) ||
                  !linkedPullRequests.some(
                    (pr) => pr.url === record(parsedArguments).pullRequestUrl,
                  ))
              ? "GitHub 工具只能使用 get_task_context 返回的 pullRequestUrls。不得传入 Issue 链接或猜测 PR。没有 PR 时按已有 Issue 或测试说明生成规格。"
              : null;
          if (sourceToolError) {
            await this.appendTrace(
              lease,
              signal,
              toolFailed(
                task,
                segmentId,
                step,
                call,
                startedAt,
                sourceToolError,
              ),
            );
            history.push(
              toolOutput(call, {
                accepted: false,
                error: sourceToolError,
                allowedPullRequestUrls: linkedPullRequests.map((pr) => pr.url),
              }),
            );
            continue;
          }

          try {
            const output = await this.controlPlane.executeSpecTool(
              lease,
              {
                arguments: parsedArguments,
                callId: call.id,
                name: sourceToolName,
              },
              signal,
            );
            if (output.inputRequest) {
              await this.appendTrace(lease, signal, {
                kind: "agent.tool.completed",
                payload: {
                  attemptNumber: task.snapshot.attemptNumber,
                  callId: call.id,
                  durationMs: Date.now() - startedAt,
                  name: call.function.name,
                  inputPreview: tracePreview(parsedArguments),
                  outputPreview: output.inputRequest,
                  segmentId,
                  sourceRefs: output.sourceRefs.map(
                    (source) => source.externalId,
                  ),
                  status: "SUCCEEDED",
                  step,
                },
              });
              segmentStatus = "WAITING_HUMAN";
              return {
                kind: "INPUT_REQUIRED",
                request: output.inputRequest,
                summary: output.inputRequest.message,
              };
            }
            calledTools.add(call.function.name);
            sourceFailureCounts.delete(sourceToolName);
            output.sourceRefs.forEach((source) =>
              sources.set(source.externalId, source),
            );
            for (const source of output.sourceRefs) {
              sourceContents.set(
                source.externalId,
                observedSourceContent(source, output.result),
              );
            }
            if (
              call.function.name === "get_task_context" ||
              call.function.name === "linear_get_issue"
            ) {
              const result = record(output.result);
              for (const source of output.sourceRefs.filter((item) =>
                ["LINEAR_ISSUE", "TASK_BRIEF", "GITHUB_PULL_REQUEST"].includes(
                  item.kind,
                ),
              )) {
                issueTexts.set(
                  source.externalId,
                  observedSourceContent(source, output.result),
                );
              }
              linkedPullRequests = z
                .array(z.string().url())
                .parse(result.pullRequestUrls ?? [])
                .map((url) => {
                  const preloaded = (
                    Array.isArray(result.pullRequests)
                      ? result.pullRequests
                      : []
                  )
                    .map((value) => record(record(value).pullRequest))
                    .find((pr) => pr.url === url);
                  return {
                    url,
                    ...(preloaded
                      ? {
                          changedFiles: z
                            .array(z.string())
                            .parse(preloaded.changedFiles ?? []),
                        }
                      : {}),
                  };
                });
            }
            if (call.function.name === "github_get_pull_request") {
              const pr = linkedPullRequests.find(
                (pr) => pr.url === record(parsedArguments).pullRequestUrl,
              );
              if (pr) {
                const result = record(record(output.result).pullRequest);
                pr.changedFiles = z
                  .array(z.string())
                  .parse(result.changedFiles ?? []);
              }
            }
            await this.appendTrace(lease, signal, {
              kind: "agent.tool.completed",
              payload: {
                attemptNumber: task.snapshot.attemptNumber,
                callId: call.id,
                durationMs: Date.now() - startedAt,
                inputPreview: tracePreview(parsedArguments),
                name: call.function.name,
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
        callId: call.id,
        durationMs: Date.now() - startedAt,
        inputPreview: tracePreview(parseArguments(call.function.arguments)),
        name: call.function.name,
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
  "get_task_context",
  "linear_get_issue",
  "github_get_pull_request",
  "github_list_changed_files",
  "github_read_file",
  "github_search_code",
]);
const requiredSourceToolNames = new Set<SourceToolName>([
  "get_task_context",
  "linear_get_issue",
  "github_get_pull_request",
  "github_list_changed_files",
  "github_read_file",
]);

function isSourceToolName(name: string): name is SourceToolName {
  return sourceToolNames.has(name as SourceToolName);
}

function toolDefinitions(
  sourceIds: Iterable<string> = [],
  unavailableTools: ReadonlySet<string> = new Set(),
  contextRead = false,
  pullRequestUrls: readonly string[] = [],
  compact = false,
  requirements: readonly SpecRequirement[] | null = null,
  checkCatalog?: SpecCheckCatalog,
  businessChecks = false,
) {
  const observedSourceIds = [...sourceIds];
  const analysisSummary = {
    description:
      "使用简体中文简要说明已获得的信息以及为什么需要执行本次操作；该内容会展示给用户，不要包含隐藏思维链。",
    maxLength: 4_000,
    minLength: 1,
    type: "string",
  };
  const pullRequestUrl = {
    enum: pullRequestUrls,
    maxLength: 2_000,
    type: "string",
  };
  return [
    {
      type: "function",
      name: "get_task_context",
      description:
        "读取任务选择的 Issue、PR、测试说明和环境候选；必须先调用，缺少某类来源不会阻塞。",
      parameters: objectSchema({ analysisSummary }, ["analysisSummary"]),
      strict: false,
    },
    {
      type: "function",
      name: "request_analysis_input",
      description:
        "已读来源不能确定可观察的验收目标时，请求用户补充明确的测试目标。不能仅因没有 Issue 或 PR 调用。",
      parameters: objectSchema(
        {
          analysisSummary,
          message: { type: "string", minLength: 1, maxLength: 4000 },
        },
        ["analysisSummary", "message"],
      ),
      strict: false,
    },
    {
      type: "function",
      name: "github_get_pull_request",
      description:
        "读取任务选定 Pull Request 的元数据、描述、检查结果、版本和部署信息。",
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
          page: { maximum: 150, minimum: 1, type: "integer" },
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
    ...(compact
      ? [
          {
            type: "function",
            name: "define_requirements",
            description:
              "先筛选本次必要的业务结果，再固定需求清单。保留任务上下文中的明确要求；次级来源推导的行为必须提供 changeBasis 引用测试说明、Issue、PR 明确验收要求或实际 diff 并解释变更关联。等价类型可共用需求，操作和取证不单列需求。系统分配编号，后续必须覆盖或说明未覆盖原因。",
            parameters: constrainSourceRefs(
              stripFormats(
                z.toJSONSchema(
                  requirementPlanSchema.extend({
                    analysisSummary: analysisSummarySchema,
                  }),
                ),
              ),
              observedSourceIds,
            ) as Record<string, unknown>,
            strict: false,
          },
        ]
      : []),
    ...(checkCatalog
      ? [
          {
            type: "function",
            name: "define_checks",
            description:
              "按业务结果分批定义验收，不按点击或字段拆点；同一结果可包含多个必须观察的对象。系统保存有效项并返回 checkId；失败仅重提交该项。修改时提供 checkId 和完整内容。supportingSourceRefs 补充界面/实现依据，不扩大需求范围。",
            parameters: constrainSourceRefs(
              stripFormats(
                z.toJSONSchema(
                  (businessChecks
                    ? defineBusinessChecksSchema
                    : defineChecksSchema
                  ).extend({
                    analysisSummary: analysisSummarySchema,
                    expectedRevision: z.literal(checkCatalog.revision),
                  }),
                  { io: "input" },
                ),
              ),
              observedSourceIds,
            ) as Record<string, unknown>,
            strict: false,
          },
        ]
      : []),
    {
      type: "function",
      name: "finish_spec",
      description: checkCatalog
        ? "提交中文用例的名称、步骤和已校验的 checkIds；系统展开完整验收标准和来源。每个 Case 独立取证，不继承其他 Case 的结果。"
        : "完成来源分析后提交完整、可执行的中文 Spec；每个 Case 和验收标准都必须引用实际观察到的 analysis-source。",
      parameters: constrainSourceRefs(
        stripFormats(
          z.toJSONSchema(
            compact
              ? z.object({
                  analysisSummary: analysisSummarySchema,
                  spec: checkCatalog
                    ? referencedSpecSchema.extend({
                        cases: z
                          .array(
                            referencedSpecSchema.shape.cases.element.extend({
                              checkIds: z
                                .array(
                                  z.enum(
                                    checkCatalog.ids.length
                                      ? checkCatalog.ids
                                      : ["NO_VALIDATED_CHECKS"],
                                  ),
                                )
                                .min(1)
                                .max(100),
                            }),
                          )
                          .min(1)
                          .max(100),
                      })
                    : compactSpecSchema,
                })
              : finishSpecSchema,
            { io: compact ? "input" : "output" },
          ),
        ),
        observedSourceIds,
      ) as Record<string, unknown>,
      strict: false,
    },
  ]
    .filter(
      (tool) =>
        !unavailableTools.has(tool.name) &&
        !(compact && tool.name === "finish_spec" && !requirements) &&
        !(
          checkCatalog &&
          tool.name === "finish_spec" &&
          !checkCatalog.ids.length
        ) &&
        !(tool.name === "define_checks" && !requirements) &&
        !(tool.name === "define_requirements" && requirements) &&
        (tool.name === "get_task_context" ||
          (contextRead &&
            (tool.name === "request_analysis_input" ||
              tool.name === "finish_spec" ||
              tool.name === "define_requirements" ||
              tool.name === "define_checks" ||
              pullRequestUrls.length > 0))),
    )
    .map(({ type: _type, ...definition }) => ({
      type: "function" as const,
      function: {
        ...definition,
        parameters: generationSchema(
          definition.parameters,
          businessChecks,
        ) as Record<string, unknown>,
      },
    }));
}

/** Do not advertise a contract the claiming API did not negotiate. */
function generationSchema(value: unknown, businessChecks: boolean): unknown {
  if (Array.isArray(value))
    return value
      .filter(
        (item) =>
          businessChecks ||
          record(record(record(item).properties).version).const !== 3,
      )
      .map((item) => generationSchema(item, businessChecks));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => businessChecks || key !== "businessCheck")
      .map(([key, child]) => [key, generationSchema(child, businessChecks)]),
  );
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
        key === "sourceRef" &&
        constrainedChild &&
        typeof constrainedChild === "object" &&
        !Array.isArray(constrainedChild)
      )
        return [key, { ...constrainedChild, enum: sourceIds }];
      if (
        (key !== "sourceRefs" && key !== "supportingSourceRefs") ||
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
  const result = Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      key === "format" ? [] : [[key, stripFormats(child)]],
    ),
  );
  if (
    result.properties &&
    typeof result.properties === "object" &&
    "accountRequirements" in result.properties
  )
    result.required = [
      ...new Set([
        ...(Array.isArray(result.required) ? result.required : []),
        "accountRequirements",
        "accountRequirementsVersion",
      ]),
    ];
  return result;
}

function systemPrompt(
  compact = false,
  checkReferences = false,
  businessChecks = false,
) {
  const prompt = `你是 DevProof 的 Spec 分析 Agent。
${SPEC_EXECUTION_SCOPE_GUIDANCE}
${SPEC_NECESSITY_GUIDANCE}
请基于任务提供的测试说明、Issue、GitHub Pull Request 和相关代码，生成覆盖必要业务结果的可执行验证 Spec。Issue 和 PR 都是可选上下文，不是任务身份。
必须先调用 get_task_context。对于每个选定 Pull Request，都要检查元数据和变更文件；为了理解实际行为，应读取必要的实现文件，不能只依赖文件名或 PR 描述。
GitHub 工具的 pullRequestUrl 只能逐字选择 get_task_context 返回的 pullRequestUrls，不能猜测链接。只提供 PR 时根据明确目标和变更生成规格；只提供 Issue 或测试说明时直接根据其生成规格，不要求补齐另一类来源。该工具读取选择的来源并返回 targetUrl；inputRequest 表示需要补充实际缺失的信息。若来源虽可读但测试目标不明确，调用 request_analysis_input 说明要澄清的可观察结果，不要编造验收目标。
若变更包含 specs/routes 下的 Route Spec，必须用 github_read_file 读取它，并结合相关实现及界面文案核对。若 Issue、Route Spec 和实现存在名称或行为冲突，应在 risks 中注明来源与差异，把未确定部分作为待确认事项，不能擅自把其中一种说法设为硬性失败条件。
同一非必需数据源连续两次返回 5xx 或限流错误后，执行器会将其标记为不可用并移除对应工具；不要继续尝试该工具，应在风险中说明数据源缺失并使用其余可用来源完成分析。已选定的来源及 PR 元数据、diff、相关文件是必需来源，必需工具持续不可用时停止生成；前置检查返回 inputRequest 时等待用户补齐。
每次工具调用都必须包含 analysisSummary：用简体中文给出简洁、用户可见的决策摘要，不要输出隐藏思维链。
所有用户可见的生成内容必须使用简体中文，包括 Spec 摘要、范围、假设、风险、Case 名称、前置条件、测试数据、设计理由、操作步骤、预期现象、验收标准和清理步骤。标识符、URL、代码符号、API 路径、工具名、枚举值和 source reference 保持原样，不要翻译。
${compact ? "每条需求引用实际返回的 analysis-source 和原文，由系统传递给 Case 及验收标准；不要手工重复来源字段。" : "每个 Case 和每条验收标准都必须引用工具实际返回的 analysis-source；绝不能编造来源引用。"}
验收标准 description 用一句简洁中文描述一个可观察、可判断的业务行为，保留必要的页面区域、触发条件和预期结果。多个独立行为拆为多条标准；只要求类型可发现时，不附加创建或保存要求。页面已有中文名称时优先使用中文名称；仅在来源承诺同一对象可显示技术枚举时，才将其放入 observationTargets.alternatives；来源原文和地址放入 basis/sourceRefs，不重复拼入 description。例如：在指定页面的类型下拉中，可以找到需求要求的选项（用来源中的实际页面名和选项名替换）。不得为了简短删掉影响判定的限制条件。
每条验收标准还必须提供 observationTargets，逐个列出需要验证的对象（label）及来源中可核对的页面文字（expectedText）。涉及多个类型时，分别列出每个类型的界面显示名，不能用一个“启用”概括所有类型；界面样式比较也必须分别覆盖目标类型和参照类型。${compact ? "每条标准必须引用 define_requirements 返回的 requirementId，来源原文必须直接支持断言。" : "每条验收标准必须提供 basis：sourceRef 必须属于该标准的 sourceRefs，quote 必须逐字摘自该来源工具实际返回的需求或代码，并直接支持该断言；observationTarget 明确验收的页面区域、控件及业务对象。"}来源存在不等于来源支持任意断言；不能用创建弹窗的类型选项证明列表筛选选项或筛选隔离。
严格区分产品要求、探索步骤和自拟测试标识：只有来源明确的产品行为进入 criteria；未知字段和操作路径写成条件性探索步骤或 assumptions，不生成强制验收项。自拟标识只放在 testData，且必须先确认产品存在可填写的字段；不能假设备注字段存在，更不能要求不存在的备注字段或备注回显。用实际记录 ID、业务账号和类型追踪数据。
${compact ? "操作写清业务目标与必要动作；浏览器 Agent 负责定位元素、探索路径和选择工具，不预先编造选择器。前置条件、测试数据和清理步骤按需填写。" : "生成具体的前置条件、测试数据、有序操作、预期现象、验收标准、证据类型和清理步骤。优先描述业务可观察行为，而不是实现细节。"}
内部枚举或代码符号不要求在 DOM 中显示，除非来源明确要求用户看到它。等价业务类型可以共用一条验收，但必须分别观察所有 observationTargets；业务条件或预期不同才拆分，不能观察一个类型后判定所有类型通过。
Spec 用简短、无重复的业务语言：Case 名称只写对象与目标；简单场景通常 3–6 个业务步骤，按“新增→筛选→禁用→重新启用→清理”合并连续点击，不逐个描述按钮操作。复杂场景按需要增加步骤，不能为压缩遗漏要求。每个描述或步骤最多 300 字；接口细节仅作执行参考，按需放入 testData，不进入 criteria。验收标准只写可判定结果，不复述操作步骤；不要在 name、preconditions、testData、steps、criteria 和账号说明中重复同一约束。
账号字段各司其职：label 只写用途，rationale 一句话解释数量或隔离必要性，constraints 只写此业务对象特有的前置条件。通用登录、禁用随机账号、禁止修改他人记录、账号不可用时无法判定等平台规则由执行器统一提供，不在各 Case 中反复抄写。后台登录身份仅填 authRole，不能放进 accountRequirements；后台权限不能填 requiredTypes（它只表示业务类型）。
每个 Case 必须填写 accountRequirementsVersion: 2。非空账号需求必须提供 subjectBinding：kind 为 BUSINESS_INPUT（账号填入业务字段）、BUSINESS_RECORD（按指定账号检查业务记录）或 AUTH_SUBJECT（该账号登录/权限本身是验收对象）；target 为实际业务字段或被测账号对象；stepOrders 引用当前步骤；basis 引用已读来源的 sourceRef 和准确 quote，说明业务确实需要这个账号。AUTH_SUBJECT 还必须填 criterionIds，${checkReferences ? "使用当前 Case 的 checkIds" : compact ? "使用当前 Case 验收标准的一基序号字符串，如 1" : "使用当前 Case 的 criterion id"}。真实来源原文必须支持账号用途，不能仅引用存在权限判断的代码。
创建、编辑、克隆模型或产品配置不等于需要业务账号：模型名称、ID、时间属于普通测试资源，使用 testData 和清理台账。仅需模型编辑权限、列表查看或导出权限的操作账号放 authRole，accountRequirements 为 []。添加用户白名单、指定用户查询、双账号转账需要实际账号；验证账号登录权限时保留 AUTH_SUBJECT，不与执行身份混淆。
每个 Case 必须填写 accountRequirements 数组：不需要业务测试对象时为 []；需要时填写 role（稳定英文标识）、label（中文用途）、count、usage（CREATE_OR_MODIFY 或 READ_EXISTING）、requiredTypes、constraints、rationale。按独立业务测试对象计算最少账号数，不按验收点或类型累加；同一账号能安全验证多个类型时合并为一个角色并列出类型。只有不同身份/数据隔离确有必要才增加数量，并写明原因。账号 A/B 是角色占位符，禁止当作账号值。平台在执行前统一收集并按角色分配；同环境同账号同类型的写操作按执行会话串行，账号可以复用。步骤引用对应角色；账号前置冲突由执行器通过 DATA_PRECONDITION 人工接管获取处置意见；Spec 不预先规定冲突即结束，也不自行换号。纯界面只读 Case 不需要账号；无效账号负向输入不索取有效账号。
每个 Case 必须可独立启动：当前调度器并发运行且不传递其他 Case 的验收结果，不能把“已完成 Case 1”“使用其他用例创建的数据”或“已了解参照类型的操作路径”写作前置条件。必要的权限、数据和控件定位检查放在本 Case 的步骤；仅在对应业务结果属于本次范围时才设为验收标准。不能把假设当作已经观察的事实。
按数据前置条件拆分新增与编辑：新增要求账号下不存在目标记录，编辑要求已有目标记录，不能仅为合并步骤把独立编辑验收绑死在新增成功之后。只有来源明确要求同一记录的完整生命周期时才合并。独立编辑用例不得添加“新增成功”验收来绕过前置检查；数据不足时可在准备步骤说明经授权创建临时记录，准备动作不能充当编辑验收。独立编辑用例必须说明测试记录归属、可修改授权、初始值记录与恢复步骤；仅提供账号不代表授权修改该账号的全部既有数据。无法确认授权时请求 DATA_PRECONDITION，不自动删除既有记录来满足新增条件。账号 constraints 只声明真实业务约束；不同类型的唯一键互不冲突时，不自行增加跨 Case 必须不同账号的要求。
正向写入需要的业务账号只能来自任务明确指定的测试账号或 TEST_ACCOUNT 答复。不能建议从列表挑选其他用户的账号进行新增或修改；只读筛选才允许复用已观察记录。自拟标识不能成为强制回显要求，除非来源证据明确支持相应字段。
账号、用户 UUID 等已有实体不能用随机手机号或时间戳字符串替代。authRole 只描述后台登录身份；业务测试对象是另一用途，不要求与当前登录账号相同。缺少业务账号时通过现有 TEST_ACCOUNT HITL 请求，说明环境、Case、所需业务类型、唯一性约束和已有记录是否可复用。默认并发执行，确有隔离需要时在账号约束中说明独立账号或不冲突的唯一键；创建前只读核查账号+类型是否存在，已存在且不满足场景前置条件时，可由 DATA_PRECONDITION 人工接管处理或明确授权删除指定记录后继续；未授权不得自行删除，不反复索取新账号。列表筛选优先只读复用已有记录，不重复创建其他 Case 的数据。仅清理有明确创建证据且属于本 Case 的记录。故意验证无效账号的负向 Case 保留其无效输入和预期拒绝结果。
只有完成所有可用来源的调查后才能调用 finish_spec；显式选定的来源不可用时不得提交规格，但没有选择 Issue 或 PR 不构成错误；代码来源不可用时应报告明确的数据源错误，不能以部分规格跳过必需来源。绝不能泄露凭据。
${
  compact
    ? `当前使用精简 Spec 协议。先读取必要来源并完成范围筛选，再调用 define_requirements 固定本次必要需求；保留所有明确要求的业务对象与样式参照，不按操作、字段和等价类型机械拆分。最终每条需求都必须对应验收标准，或在 uncoveredRequirements 提供具体缺失信息，不能在修正格式时缩减需求范围。outOfScope 只记录不属于本次要求或改动影响的内容及排除原因。
${checkReferences ? `先调用 define_checks 分批定义验收标准，每项填写 requirementId、description、observationTargets 和必要的 requiredEvidenceKinds；界面文案来自其他已读来源时显式填写 supportingSourceRefs，原需求 basis 保持不变。工具会保存有效项并返回 checkId、revision 和逐字段 issues；只重提交失败项，修改已保存项时携带 checkId 及该项完整内容，并使用工具给出的 expectedRevision。不要为已保存的相同标准重复生成内容。最终 Case 填写 name、steps（有序操作字符串数组）、accountRequirements 和 checkIds，不填写 criteria。checkIds 必须来自 define_checks 成功保存的编号，系统展开完整标准和来源。同一个 check 只在对象、状态和预期完全一致时复用，每个 Case 独立观察和取证。` : `Case 填写 name、steps（有序操作字符串数组）、accountRequirements、criteria。每条 criterion 填写 requirementId、description、observationTargets；必要时用 supportingSourceRefs 引用额外已读的界面证据。`}仅确有需要时填写 preconditions、testData、cleanup；系统自动生成编号、默认优先级、步骤序号及来源 basis。
同一个业务对象的同义显示方式才写在该 target 的 alternatives 中；启用/禁用、成功/失败属于不同状态，不能互为 alternatives。不同业务对象分别列 target，使用各对象实际可见的类型或区域名称作为 expectedText 锚点，所有对象都必须验证；不要让两个样式参照对象都只写“启用状态”。描述中的“或”必须体现在同一 target 的 alternatives 中，不能拆成两个必须出现的对象。UI 未承诺展示内部枚举时，优先使用业务中文名称。
criteria.description 描述产品应满足的条件，不把“截图、记录差异、观察页面”等测试动作当作通过条件。样式比较须写明被比较的目标、参照对象和要比较的结构/交互，requiredEvidenceKinds 包含 SCREENSHOT；来源没有明确比较范围时，在 uncoveredRequirements 中说明待确认内容，不擅自把像素、颜色或字段当作硬性要求。`
    : ""
}`;
  if (!businessChecks) return prompt;
  return (
    prompt
      .split("\n")
      .map((line) => {
        if (line.startsWith("每条验收标准还必须提供 observationTargets"))
          return "对象状态使用 businessCheck；普通界面文字发现使用 observationTargets。网络请求仅作执行参考，不生成网络字段验收。每条标准引用 requirementId，来源原文必须直接支持断言。来源是需求依据，不是待匹配的页面文字；创建表单的选项不能证明列表筛选结果。";
        if (line.startsWith("同一个业务对象的同义显示方式"))
          return "businessCheck.subjects 分别声明必须覆盖的对象，state 只声明共同的预期；不同对象允许具有相同状态。单纯文字目标的 alternatives 仅表示同一对象的等价名称，启用/禁用不能互为 alternatives。";
        return line
          .replaceAll(
            "description、observationTargets",
            "description、businessCheck 或 observationTargets",
          )
          .replace(
            "每个描述或步骤最多 300 字",
            "描述尽量不超过 80 字，单步尽量不超过 100 字（保留必要业务条件）",
          );
      })
      .join("\n") +
    "\n\n" +
    BUSINESS_CHECK_GUIDANCE
  );
}

export function validateFinalSpec(input: {
  issueTexts?: ReadonlyMap<string, string>;
  calledTools: ReadonlySet<string>;
  linkedPullRequests: readonly { url: string; changedFiles?: string[] }[];
  sources: ReadonlyMap<string, RuntimeSpecSourceRef>;
  sourceContents: ReadonlyMap<string, string>;
  spec: z.infer<typeof runtimeGeneratedSpecSchema>;
  unavailableTools: ReadonlySet<string>;
}) {
  const capabilityError = specCapabilityError(
    input.spec,
    input.issueTexts ?? new Map(),
  );
  if (capabilityError) return capabilityError;
  const accountError = accountRequirementIssuesMessage(
    validateCaseAccountRequirements(input.spec.cases, {
      requireVersion: true,
      sourceContents: input.sourceContents,
    }),
  );
  if (accountError) return accountError;
  const chineseError = validateChineseSpec(input.spec);
  if (chineseError) return chineseError;
  const coverageError = specRequirementCoverageError(input.spec);
  if (coverageError) return coverageError;
  const sourceError = sourceCoverageError(input);
  if (sourceError) return sourceError;
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
  const necessityError = specNecessityError(input.spec, input);
  if (necessityError) return necessityError;
  for (const testCase of input.spec.cases) {
    const dataError = caseDataPreconditionError(testCase);
    if (dataError) return dataError;
    if (testCase.preconditions.some(hasExternalCaseDependency))
      return `用例「${testCase.name}」依赖其他 Case 或未交付的操作知识。每例独立并发执行，请将必要检查和参照观察展开为本 Case 的步骤，不得假定其他用例已完成。`;
    for (const criterion of testCase.criteria) {
      const issues = specCriterionIssues(criterion, input.sourceContents);
      if (issues.length)
        return issues
          .map((issue) => `${issue.message}（${issue.path}）`)
          .join("\n");
    }
  }
  return null;
}

/** Editing an existing object must not acquire a fabricated absence requirement. */
export function caseDataPreconditionError(
  testCase: z.infer<typeof runtimeGeneratedSpecSchema>["cases"][number],
) {
  const editing =
    /编辑|修改|更新|禁用|重新启用/u.test(testCase.name) &&
    !/新增|创建|新建|生命周期/u.test(testCase.name);
  const constraints = [
    ...testCase.preconditions,
    ...(testCase.accountRequirements ?? []).flatMap((r) => r.constraints),
  ];
  if (
    editing &&
    constraints.some((c) =>
      /尚不存在|尚未配置|尚未创建|不存在.{0,20}记录|未配置.{0,20}类型/u.test(c),
    )
  )
    return `用例「${testCase.name}」只验收编辑结果，却要求账号不存在目标记录。请改为使用已观察、获授权的既有记录，记录初始状态并恢复；授权或数据冲突交给 DATA_PRECONDITION 人工处置。不要把独立编辑绑定到先新增。`;
  return null;
}

function sourceCoverageError(
  input: Pick<
    Parameters<typeof validateFinalSpec>[0],
    "calledTools" | "linkedPullRequests" | "sources" | "unavailableTools"
  >,
) {
  if (!(
    input.calledTools.has("get_task_context") ||
    input.calledTools.has("linear_get_issue")
  )) {
    return "完成 Spec 前必须读取任务上下文。";
  }
  if (!input.sources.size)
    return "生成 Spec 前必须有可引用的测试说明、Issue 或 PR 内容。";
  return specSelectedSourceCoverageError(input.linkedPullRequests, [
    ...input.sources.values(),
  ]);
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(stringLeaves);
  return [];
}

function observedSourceContent(source: RuntimeSpecSourceRef, result: unknown) {
  // A batched diff/search response contains multiple independent sources. Do
  // not let a quote from one file validate a citation to another file.
  const output = record(result);
  if (source.kind === "TASK_BRIEF")
    return typeof output.goal === "string" ? output.goal : "";
  const items = Array.isArray(output.files)
    ? output.files
    : Array.isArray(output.matches)
      ? output.matches
      : null;
  const { pullRequests } = output;
  const content = items
    ? items.find((item) => record(item).sourceRef === source.externalId)
    : Array.isArray(pullRequests)
      ? source.kind === "GITHUB_PULL_REQUEST"
        ? pullRequests.find(
            (item) => record(item).sourceRef === source.externalId,
          )
        : { issue: output.issue }
      : output;
  return [source.excerpt, ...stringLeaves(content)].join("\n");
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
    ...(spec.requirements ?? []).map(
      (item, index) =>
        [`requirements[${index}].description`, item.description] as [
          string,
          string,
        ],
    ),
    ...(spec.uncoveredRequirements ?? []).map(
      (item, index) =>
        [`uncoveredRequirements[${index}].reason`, item.reason] as [
          string,
          string,
        ],
    ),
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
  // Test data can be literal identifiers, URLs or deliberately invalid inputs.
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
  return [
    ...(spec.requirements ?? []).flatMap((item, index) => [
      {
        path: `spec.requirements[${index}].sourceRef`,
        sourceRef: item.sourceRef,
      },
      ...(item.changeBasis
        ? [
            {
              path: `spec.requirements[${index}].changeBasis.sourceRef`,
              sourceRef: item.changeBasis.sourceRef,
            },
          ]
        : []),
      ...(["intentEvidence", "issueEvidence"] as const).flatMap((field) =>
        item[field]
          ? [
              {
                path: `spec.requirements[${index}].${field}.sourceRef`,
                sourceRef: item[field].sourceRef,
              },
            ]
          : [],
      ),
    ]),
    ...spec.cases.flatMap((testCase, caseIndex) => [
      ...(testCase.accountRequirements ?? []).flatMap((requirement, index) =>
        requirement.subjectBinding
          ? [
              {
                path: `spec.cases[${caseIndex}].accountRequirements[${index}].subjectBinding.basis.sourceRef`,
                sourceRef: requirement.subjectBinding.basis.sourceRef,
              },
            ]
          : [],
      ),
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
    ]),
  ];
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

function toolOutput(call: ModelFunctionCall, output: unknown): ModelMessage {
  return {
    tool_call_id: call.id,
    content: JSON.stringify(output),
    role: "tool",
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
      callId: call.id,
      durationMs: Date.now() - startedAt,
      errorMessage,
      inputPreview: tracePreview(parseArguments(call.function.arguments)),
      name: call.function.name,
      segmentId,
      step,
    },
  };
}

function modelOutputPreview(message: ModelAssistantMessage) {
  return modelFunctionCalls(message).map((call) => ({
    arguments: tracePreview(parseArguments(call.function.arguments)),
    callId: call.id,
    name: call.function.name,
    type: call.type,
  }));
}

function modelHistoryPreview(history: ModelMessage[]) {
  return history.map((item) =>
    item.role === "assistant"
      ? {
          role: item.role,
          content: tracePreview(item.content),
          tool_calls: modelOutputPreview(item),
        }
      : tracePreview(item),
  );
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
        SENSITIVE_KEY.test(key) ||
        /^(?:reasoning|reasoning_content|reasoning_details)$/u.test(key)
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
