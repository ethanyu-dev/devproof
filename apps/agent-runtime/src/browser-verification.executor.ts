import { randomUUID } from "node:crypto";

import {
  missingRequiredEvidenceKinds,
  runtimeCriterionResultSchema,
  runtimeEvidenceKindSchema,
  runtimeOutcomeSchema,
  runtimeTraceEventSchema,
  runtimeVerificationTerminationReasonSchema,
  type RuntimeBrowserAcquireInput,
  type RuntimeEvidenceRef,
  type RuntimeOutcome,
  type RuntimeTaskLease,
  type RuntimeTraceEvent,
} from "@devproof/agent-runtime-protocol";
import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";
import { z } from "zod";
import {
  BrowserToolCatalog,
  enableBrowserToolsInputSchema,
  type BrowserToolGroup,
  type BrowserToolSurfaceMode,
} from "./browser-tool-catalog.js";
import { openAiFunctionSchema } from "./model-tool-schema.js";
import { ModelHealth } from "./model-health.js";

import type {
  ActiveLease,
  ControlPlaneClient,
} from "./control-plane.client.js";
import { VerificationProgress } from "./verification-progress.js";
import {
  BrowserObservations,
  READ_COMMANDS,
  readObservationInputSchema,
} from "./browser-observation.js";
import {
  ContextBudgetExceeded,
  ModelContext,
  jsonBytes,
  type ModelContextOptions,
} from "./model-context.js";
import {
  parseBrowserCommand,
  schemaCorrection,
  toolCorrection,
  type ToolCorrection,
} from "./tool-correction.js";

import {
  modelFunctionCalls,
  type ModelCompletion,
  type ModelClientFactory,
  type ModelFunctionCall,
  type ModelMessage,
  type ModelRequestAttempt,
} from "./model-types.js";

interface ToolExecutionResult {
  browserCommandCount: number;
  correctionBytes?: number;
  locatorRecoveryState?: LocatorRecoveryState | null;
  outcome?: RuntimeOutcome;
  output: unknown;
}

interface LocatorRecoveryState {
  criterionId?: string;
  exhausted: boolean;
  failedCommandType: string;
  failedFrameContext: string | null;
  failedTargetSelectors: string[];
  recoveryToken: string;
  retargetAttempts: number;
}

type RuntimeActionCommand = z.infer<typeof runtimeActionCommandInputSchema>;

const recordCriterionInputSchema = runtimeCriterionResultSchema;
const recordProgressInputSchema = z
  .object({
    phase: z.string().trim().min(1).max(120),
    observations: z
      .array(
        z
          .object({
            observationId: z.string().uuid(),
            cursor: z.number().int().nonnegative(),
            quote: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    nextAction: z.string().trim().min(1).max(500),
  })
  .strict();
const finishInputSchema = z.object({
  criteria: z.array(recordCriterionInputSchema).max(100).optional(),
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

export interface BrowserVerificationOptions extends ModelContextOptions {
  toolSurfaceMode?: BrowserToolSurfaceMode;
}

/** Executes one leased browser-verification task without owning retry state. */
export class BrowserVerificationExecutor {
  private readonly modelHealth = new ModelHealth();
  constructor(
    private readonly modelClient: ModelClientFactory,
    private readonly controlPlane: ControlPlaneClient,
    private readonly toolLimit: number,
    private readonly options: BrowserVerificationOptions = {},
  ) {}

  async execute(
    task: RuntimeTaskLease,
    lease: ActiveLease,
    signal: AbortSignal,
  ): Promise<RuntimeOutcome> {
    signal.throwIfAborted();
    const targetUrl = readTargetUrl(task.snapshot.environment);
    const browserPolicy = readBrowserPolicy(task.snapshot.executionPolicy);
    await this.acquireBrowserWithPolicy(task, lease, signal, {
      availabilityPolicy: browserPolicy.availabilityPolicy,
      profile: browserPolicy.profile,
      requiredCapabilities: [...browserPolicy.requiredCapabilities],
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

    const catalog = new BrowserToolCatalog(
      task.snapshot.criteria,
      this.options.toolSurfaceMode,
    );
    const context = new ModelContext(
      [
        {
          role: "system",
          content: systemPrompt(
            this.options.mode !== "LEGACY",
            catalog.grouped,
          ),
        },
        {
          role: "user",
          content: taskPrompt(task, targetUrl),
        },
      ],
      this.options,
    );
    const observations = new BrowserObservations(undefined, context.bounded);
    const segmentId = `${task.taskId}:${lease.fencingToken}`;
    const segmentStartedAt = Date.now();
    let preferredModel = modelCandidates[0]!;
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
    let locatorRecoveryState: LocatorRecoveryState | null = null;
    let segmentErrorMessage: string | undefined;
    let segmentStatus: "FAILED" | "SUCCEEDED" | "WAITING_HUMAN" = "FAILED";
    let step = 0;
    let automaticObservationCount = 0;
    let pageRefresh: unknown;
    const hitlPolicy = readHitlPolicy(task.snapshot.executionPolicy);
    const requestSettings = {
      // Budget for the largest candidate ID; fallback reuses the same input.
      model: modelCandidates.reduce(
        (longest, item) =>
          jsonBytes(item.modelId) > jsonBytes(longest) ? item.modelId : longest,
        "",
      ),
      parallel_tool_calls: false,
      tool_choice: "auto",
      stream: false,
    };
    const deadlinePolicy = readDeadlinePolicy(task.snapshot.executionPolicy);
    const progress = new VerificationProgress();
    let finalizationDeadline: number | undefined;
    const beginFinalization = () => {
      finalizationDeadline ??= performance.now() + 5_000;
    };
    const finalizationBudgetMs = () =>
      Math.max(
        0,
        (finalizationDeadline ?? performance.now()) - performance.now(),
      );
    const finalize = async (reason: FinalizationReason) => {
      signal.throwIfAborted();
      beginFinalization();
      const outcome = finalizationOutcome({
        browserCommandCount,
        criterionResults,
        evidence,
        task,
        reason,
      });
      if (finalizationBudgetMs() > 0) {
        await settleWithin(
          this.controlPlane.appendEvent(
            lease,
            reason === "FINALIZATION_RESERVE_REACHED"
              ? "executor.deadline.finalized"
              : reason === "TOOL_LIMIT_REACHED"
                ? "executor.budget.finalized"
                : "executor.stagnation.finalized",
            {
              reason,
              deadlineAt: task.snapshot.deadlineAt,
              fencingToken: lease.fencingToken,
              // A recovery checkpoint, not an accepted product verdict. Persist
              // before browser cleanup; the outcome endpoint still validates it.
              pendingOutcome: outcome,
            },
          ),
          finalizationBudgetMs(),
        );
      }
      signal.throwIfAborted();
      segmentStatus = "SUCCEEDED";
      return outcome;
    };

    try {
      if (targetUrl && !readHumanResume(task.snapshot.executionPolicy)) {
        signal.throwIfAborted();
        if (finalizationDue(task, deadlinePolicy))
          return await finalize("FINALIZATION_RESERVE_REACHED");
        const command: RuntimeActionCommand = {
          commandType: "page.navigate",
          payload: { url: targetUrl },
        };
        const startedAt = Date.now();
        await this.controlPlane.appendEvent(
          lease,
          "executor.navigation.started",
          {
            command: tracePreview(command),
          },
        );
        browserCommandCount += 1;
        let result: unknown;
        try {
          result = await this.browserCommand(
            lease,
            command,
            signal,
            observations,
          );
          collectEvidence(result, evidence);
        } catch (error) {
          signal.throwIfAborted();
          result = { accepted: false, error: traceErrorMessage(error) };
        }
        await this.controlPlane.appendEvent(
          lease,
          "executor.navigation.completed",
          {
            durationMs: Math.max(0, Date.now() - startedAt),
            outputPreview: tracePreview(result),
          },
        );
        context.completeTurn(null, [
          {
            role: "user",
            content: JSON.stringify({
              kind: "runtime_initial_navigation",
              command,
              result: observations
                ? observations.project(result, context.bounded)
                : result,
            }),
          },
        ]);
      }
      for (let callCount = 0; callCount < this.toolLimit;) {
        signal.throwIfAborted();
        if (finalizationDue(task, deadlinePolicy)) {
          return await finalize("FINALIZATION_RESERVE_REACHED");
        }
        step += 1;
        // Freeze the tool surface for a response and its fallbacks; refresh expired
        // observations before retrying a provider. Enable calls apply next turn.
        const advertisedGroups = catalog.activeGroups();
        const toolSurface = {
          mode: catalog.grouped ? "GROUPED" : "LEGACY",
          activeGroups: advertisedGroups,
          commandCount: catalog.commandNames().length,
        };
        const requestBase = {
          ...requestSettings,
          tools: toolDefinitions(catalog, hitlPolicy.enabled, context.bounded),
        };
        const prepareView = async () => {
          let view: ReturnType<ModelContext["build"]>;
          try {
            // Reject an impossible fixed request before issuing automatic browser work.
            if (context.bounded && step === 1) context.build(requestBase, {});
            if (context.bounded && observations.needsSnapshot()) {
              const latestObservation = observations.requestedPage();
              const command: RuntimeActionCommand = {
                commandType: "page.snapshot",
                payload: {},
              };
              browserCommandCount += 1;
              automaticObservationCount += 1;
              const observationStartedAt = Date.now();
              await this.controlPlane.appendEvent(
                lease,
                "executor.observation.started",
                {
                  step,
                  command,
                  automaticObservationCount,
                },
              );
              const observationAbort = abortScope(
                signal,
                null,
                () =>
                  Date.parse(task.snapshot.deadlineAt) -
                  finalizationReserveMs(deadlinePolicy),
              );
              let output: unknown;
              try {
                observationAbort.signal.throwIfAborted();
                output = await abortable(
                  this.browserCommand(
                    lease,
                    command,
                    observationAbort.signal,
                    observations,
                  ),
                  observationAbort.signal,
                );
                collectEvidence(output, evidence);
              } catch (error) {
                signal.throwIfAborted();
                output = { accepted: false, error: traceErrorMessage(error) };
              } finally {
                observationAbort.dispose();
              }
              observations.markSnapshotAttempted();
              if (
                observationAbort.signal.reason instanceof
                FinalizationWindowReachedError
              )
                return await finalize("FINALIZATION_RESERVE_REACHED");
              // Project diagnostics and cache the DOM, but never add an automatic read
              // as an extra model turn or claim its screenshot proves business success.
              const projected = observations.project(output);
              observations.retainLatestObservation(latestObservation);
              if (browserCommandSucceeded(output)) progress.observe(output);
              pageRefresh = {
                status: browserCommandSucceeded(output)
                  ? "SUCCEEDED"
                  : "FAILED",
                ...(!browserCommandSucceeded(output)
                  ? { output: projected }
                  : {}),
              };
              await this.controlPlane.appendEvent(
                lease,
                "executor.observation.completed",
                {
                  step,
                  command,
                  automaticObservationCount,
                  durationMs: Math.max(0, Date.now() - observationStartedAt),
                  outputPreview: tracePreview(projected),
                },
              );
              signal.throwIfAborted();
              if (finalizationDue(task, deadlinePolicy))
                return await finalize("FINALIZATION_RESERVE_REACHED");
            }
            const currentPage = observations.currentPage(true);
            const observationIndex = observations.index(8 * 1024);
            const prepared = context.build(
              requestBase,
              {
                acceptedCriteria: [...criterionResults.values()],
                unresolvedCriterionIds: task.snapshot.criteria
                  .filter((item) => !criterionResults.has(item.id))
                  .map((item) => item.id),
                evidence: [...evidence.values()].map(
                  ({ externalId, kind }) => ({
                    externalId,
                    kind,
                    observationStage: observations.evidenceStage(externalId),
                  }),
                ),
                locatorRecovery: locatorRecoveryState,
                observations: observationIndex,
                observationIndexOmitted:
                  observations.index().length - observationIndex.length,
                latestActionFeedback: observations.latestActionFeedback(),
                remainingToolCalls: this.toolLimit - callCount,
                timeBudget: {
                  now: new Date().toISOString(),
                  deadlineAt: task.snapshot.deadlineAt,
                  hardDeadlineAt: task.snapshot.hardDeadlineAt,
                  remainingExecutionSeconds: Math.max(
                    0,
                    Math.floor(
                      (Date.parse(task.snapshot.deadlineAt) -
                        finalizationReserveMs(deadlinePolicy) -
                        Date.now()) /
                        1000,
                    ),
                  ),
                  finalizationReserveSeconds:
                    finalizationReserveMs(deadlinePolicy) / 1000,
                },
                progress: progress.state(),
                browserTools: toolSurface,
                automaticObservationCount,
                pageRefresh,
              },
              observations.currentVisual(),
              currentPage,
              observations.currentPage(),
            );
            if (context.bounded)
              observations.deliverCurrentPage(prepared.currentPage!);
            view = prepared;
          } catch (error) {
            if (!(error instanceof ContextBudgetExceeded)) throw error;
            signal.throwIfAborted();
            segmentErrorMessage = error.message;
            return runtimeOutcomeSchema.parse({
              kind: "FATAL_FAILURE",
              executionDisposition:
                browserCommandCount > 0 ? "AGENT_ERROR" : "NOT_RUN",
              error: {
                code: "AGENT_CONTEXT_BUDGET_EXCEEDED",
                failureClass: "TOOL_EXECUTION",
                message: error.message,
                phase: "browser_verification",
                details: {
                  requestBytes: error.bytes,
                  maxBytes: error.limit,
                  componentBytes: error.components,
                  acceptedCriteria: [...criterionResults.values()],
                  evidence: [...evidence.values()].map(
                    ({ externalId, kind }) => ({ externalId, kind }),
                  ),
                },
              },
              summary:
                "执行上下文超出预算，已停止；已记录的验收结果和证据保留在错误详情中。",
            });
          }
          return view;
        };
        let prepared = await prepareView();
        if (!("messages" in prepared)) return prepared;
        let view = prepared;
        let modelInputPreview = {
          context: { ...view.metrics, toolSurface },
          input: tracePreview(view.messages),
        };
        let response: ModelCompletion | null = null;
        let selectedModel = preferredModel;
        let selectedModelStartedAt = Date.now();
        let selectedModelCallId: string | undefined;
        let selectedAttempts: ModelRequestAttempt[] = [];
        let lastModelError: unknown;
        const orderedCandidates = [
          preferredModel,
          ...modelCandidates.filter(
            (candidate) => candidate !== preferredModel,
          ),
        ];
        let candidateAttempt = 0;
        for (const candidate of orderedCandidates) {
          if (!this.modelHealth.available(candidate)) continue;
          signal.throwIfAborted();
          if (finalizationDue(task, deadlinePolicy)) {
            return await finalize("FINALIZATION_RESERVE_REACHED");
          }
          if (
            candidateAttempt++ > 0 &&
            context.bounded &&
            observations.needsSnapshot()
          ) {
            prepared = await prepareView();
            if (!("messages" in prepared)) return prepared;
            view = prepared;
            modelInputPreview = {
              context: { ...view.metrics, toolSurface },
              input: tracePreview(view.messages),
            };
          }
          const modelStartedAt = Date.now();
          const modelCallId = randomUUID();
          const requestAttempts: ModelRequestAttempt[] = [];
          await this.appendTraceEvent(lease, {
            kind: "agent.model.started",
            payload: {
              progress: progress.state(),
              modelCallId,
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
              ? Math.min(
                  deadlinePolicy.maxModelCallSeconds,
                  modelCandidates.length > 1 ? 90 : Infinity,
                ) * 1_000
              : null,
            () =>
              Date.parse(task.snapshot.deadlineAt) -
              finalizationReserveMs(deadlinePolicy),
          );
          try {
            modelAbort.signal.throwIfAborted();
            response = await abortable(
              this.modelClient(candidate).complete(
                {
                  ...structuredClone(requestBase),
                  messages: structuredClone(view.messages),
                  model: candidate.modelId,
                },
                {
                  signal: modelAbort.signal,
                  onRequestAttempt: (attempt) => requestAttempts.push(attempt),
                },
              ),
              modelAbort.signal,
            );
            signal.throwIfAborted();
            if (finalizationDue(task, deadlinePolicy)) {
              return await finalize("FINALIZATION_RESERVE_REACHED");
            }
            selectedModel = candidate;
            this.modelHealth.success(candidate);
            preferredModel = candidate;
            selectedModelCallId = modelCallId;
            selectedModelStartedAt = modelStartedAt;
            selectedAttempts = requestAttempts;
            lastModelError = undefined;
            break;
          } catch (error) {
            signal.throwIfAborted();
            const responseError =
              modelAbort.signal.aborted && !signal.aborted
                ? (modelAbort.signal.reason ?? error)
                : error;
            lastModelError = responseError;
            const reserveReached =
              modelAbort.signal.reason instanceof
              FinalizationWindowReachedError;
            const candidateHealth = reserveReached
              ? null
              : this.modelHealth.failure(candidate, responseError);
            if (reserveReached) beginFinalization();
            const failedTrace = this.appendTraceEvent(lease, {
              kind: "agent.model.failed",
              payload: {
                modelCallId,
                attemptNumber: task.snapshot.attemptNumber,
                durationMs: Math.max(0, Date.now() - modelStartedAt),
                errorMessage: traceErrorMessage(responseError),
                inputPreview: {
                  ...modelInputPreview,
                  candidateHealth,
                  transport: modelTransport(requestAttempts),
                },
                model: candidate.modelId,
                provider: "OPENAI_COMPATIBLE",
                segmentId,
                step,
              },
            });
            if (reserveReached) {
              await settleWithin(failedTrace, finalizationBudgetMs());
              return await finalize("FINALIZATION_RESERVE_REACHED");
            }
            await failedTrace;
            if (signal.aborted) throw responseError;
          } finally {
            modelAbort.dispose();
          }
        }
        if (!response) {
          throw new Error(
            `All configured model providers failed: ${traceErrorMessage(
              lastModelError ??
                "Configured candidates are temporarily unavailable after previous provider failures.",
            )}`,
          );
        }
        await this.appendTraceEvent(lease, {
          kind: "agent.model.completed",
          payload: {
            modelCallId: selectedModelCallId,
            attemptNumber: task.snapshot.attemptNumber,
            durationMs: Math.max(0, Date.now() - selectedModelStartedAt),
            inputPreview: {
              ...modelInputPreview,
              transport: modelTransport(selectedAttempts),
            },
            model: selectedModel.modelId,
            outputPreview: tracePreview(response.message),
            provider: "OPENAI_COMPATIBLE",
            responseId: response.id,
            segmentId,
            step,
            ...(response.usage ? { usage: traceRecord(response.usage) } : {}),
          },
        });
        const calls = modelFunctionCalls(response.message);
        const toolOutputs: ModelMessage[] = [];
        if (calls.length === 0) {
          if (progress.textOnly()) return await finalize("TEXT_ONLY_LOOP");
          context.completeTurn(response.message, [
            {
              role: "user",
              content: "请继续调用一个可用工具。仅返回文本无法完成验证。",
            },
          ]);
          continue;
        }

        for (const call of calls) {
          signal.throwIfAborted();
          if (finalizationDue(task, deadlinePolicy)) {
            return await finalize("FINALIZATION_RESERVE_REACHED");
          }
          callCount += 1;
          if (callCount > this.toolLimit) break;
          const toolInputPreview = traceToolInput(call.function.arguments);
          const toolStartedAt = Date.now();
          await this.appendTraceEvent(lease, {
            kind: "agent.tool.started",
            payload: {
              attemptNumber: task.snapshot.attemptNumber,
              callId: call.id,
              inputPreview: toolInputPreview,
              name: call.function.name,
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
              locatorRecoveryState,
              observations,
              catalog,
              advertisedGroups,
              signal,
              task,
              remainingToolCalls: this.toolLimit - callCount + 1,
            });
          } catch (error) {
            await this.appendTraceEvent(lease, {
              kind: "agent.tool.failed",
              payload: {
                attemptNumber: task.snapshot.attemptNumber,
                callId: call.id,
                durationMs: Math.max(0, Date.now() - toolStartedAt),
                errorMessage: traceErrorMessage(error),
                inputPreview: toolInputPreview,
                name: call.function.name,
                segmentId,
                step,
              },
            });
            throw error;
          }
          const modelOutput =
            observations && call.function.name === "browser_command"
              ? observations.project(result.output, context.bounded)
              : result.output;
          const stalled = progress.tool({
            name: call.function.name,
            arguments: call.function.arguments,
            output: result.output,
            criteria: [...criterionResults.values()].map((criterion) => ({
              criterionId: criterion.criterionId,
              status: criterion.status,
              evidenceKinds: [
                ...new Set(
                  criterion.evidenceRefs.map((id) => evidence.get(id)!.kind),
                ),
              ].sort(),
            })),
          });
          await this.appendTraceEvent(lease, {
            kind: "agent.tool.completed",
            payload: {
              progress: progress.state(),
              attemptNumber: task.snapshot.attemptNumber,
              callId: call.id,
              durationMs: Math.max(0, Date.now() - toolStartedAt),
              inputPreview: toolInputPreview,
              name: call.function.name,
              outputPreview: tracePreview(
                result.correctionBytes === undefined && !observations
                  ? result.output
                  : {
                      ...(result.output as Record<string, unknown>),
                      ...(result.correctionBytes === undefined
                        ? {}
                        : { correctionBytes: result.correctionBytes }),
                      ...(observations
                        ? {
                            context: {
                              rawOutputBytes: jsonBytes(result.output),
                              modelOutputBytes: jsonBytes(modelOutput),
                            },
                          }
                        : {}),
                    },
              ),
              segmentId,
              sourceRefs: [],
              status: traceToolFailed(result.output) ? "FAILED" : "SUCCEEDED",
              step,
            },
          });
          browserCommandCount = result.browserCommandCount;
          signal.throwIfAborted();
          if (result.locatorRecoveryState !== undefined) {
            locatorRecoveryState = result.locatorRecoveryState;
          }
          if (result.outcome) {
            preserveBrowserForHuman = result.outcome.kind === "WAITING_HUMAN";
            segmentStatus = preserveBrowserForHuman
              ? "WAITING_HUMAN"
              : "SUCCEEDED";
            return result.outcome;
          }
          // Recovery has a hard bound: do not ask the model again or run the
          // remaining tools in this response once both retargets have failed.
          if (locatorRecoveryState?.exhausted)
            return await finalize("LOCATOR_RECOVERY_EXHAUSTED");
          if (stalled) return await finalize("REPEATED_OPERATIONS");
          toolOutputs.push({
            tool_call_id: call.id,
            content: JSON.stringify(modelOutput),
            role: "tool",
          });
        }
        if (toolOutputs.length === calls.length)
          context.completeTurn(response.message, toolOutputs);
      }

      return await finalize("TOOL_LIMIT_REACHED");
    } catch (error) {
      segmentErrorMessage = traceErrorMessage(error);
      throw error;
    } finally {
      const segmentCompleted: RuntimeTraceEvent = {
        kind: "agent.segment.completed",
        payload: {
          attemptNumber: task.snapshot.attemptNumber,
          durationMs: Math.max(0, Date.now() - segmentStartedAt),
          segmentId,
          status: segmentStatus,
          ...(segmentErrorMessage ? { errorMessage: segmentErrorMessage } : {}),
        },
      };
      if (signal.aborted && finalizationDeadline === undefined) {
        const cleanupUntil = Date.now() + 10_000;
        await settleWithin(
          this.appendTraceEvent(lease, segmentCompleted),
          2_000,
        );
        if (!preserveBrowserForHuman) {
          await settleWithin(
            this.controlPlane.releaseBrowser(lease),
            cleanupUntil - Date.now(),
          );
        }
      } else if (finalizationDeadline !== undefined) {
        // The result must reach the worker while it can still be submitted.
        // Closing continues server-side if the bounded RPC wait expires.
        if (finalizationBudgetMs() > 0) {
          await settleWithin(
            this.appendTraceEvent(lease, segmentCompleted),
            finalizationBudgetMs(),
          );
        }
        if (!preserveBrowserForHuman) {
          await settleWithin(
            this.controlPlane.releaseBrowser(lease),
            finalizationBudgetMs(),
          );
        }
        signal.throwIfAborted();
      } else {
        try {
          await this.appendTraceEvent(lease, segmentCompleted);
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
  }

  private appendTraceEvent(lease: ActiveLease, event: RuntimeTraceEvent) {
    const parsed = runtimeTraceEventSchema.parse(event);
    return this.controlPlane.appendEvent(lease, parsed.kind, parsed.payload);
  }

  private async browserCommand(
    lease: ActiveLease,
    command: RuntimeActionCommand,
    signal: AbortSignal,
    observations?: BrowserObservations,
  ) {
    try {
      const result = await this.controlPlane.browserCommand(
        lease,
        command,
        signal,
      );
      observations?.capture(command, result);
      return result;
    } catch (error) {
      observations?.invalidate();
      throw error;
    }
  }

  private async acquireBrowserWithPolicy(
    _task: RuntimeTaskLease,
    lease: ActiveLease,
    signal: AbortSignal,
    execution: RuntimeBrowserAcquireInput["execution"],
  ) {
    signal.throwIfAborted();
    const result = await this.controlPlane.acquireBrowser(
      lease,
      execution,
      signal,
    );
    if (result.status === "ACQUIRED") return result;
    throw new Error(
      `Browser admission was lost before Agent execution (${result.reason}); the task will be retried.`,
    );
  }

  private async captureLocatorRecoverySnapshot(input: {
    command: RuntimeActionCommand;
    evidence: Map<string, RuntimeEvidenceRef>;
    lease: ActiveLease;
    signal: AbortSignal;
    observations: BrowserObservations | undefined;
  }): Promise<{ attempted: boolean; snapshot: unknown }> {
    const recoveryCommand = locatorRecoveryCommand(input.command);
    if (!recoveryCommand) return { attempted: false, snapshot: null };
    try {
      const snapshot = await this.browserCommand(
        input.lease,
        recoveryCommand,
        input.signal,
        input.observations,
      );
      collectEvidence(snapshot, input.evidence);
      return { attempted: true, snapshot };
    } catch (error) {
      return {
        attempted: true,
        snapshot: {
          accepted: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async executeTool(input: {
    browserCommandCount: number;
    call: ModelFunctionCall;
    criterionResults: Map<string, z.infer<typeof recordCriterionInputSchema>>;
    evidence: Map<string, RuntimeEvidenceRef>;
    lease: ActiveLease;
    locatorRecoveryState: LocatorRecoveryState | null;
    observations: BrowserObservations | undefined;
    catalog: BrowserToolCatalog;
    advertisedGroups: readonly BrowserToolGroup[];
    signal: AbortSignal;
    task: RuntimeTaskLease;
    remainingToolCalls?: number;
  }): Promise<ToolExecutionResult> {
    let raw: unknown;
    try {
      raw = JSON.parse(input.call.function.arguments) as unknown;
    } catch {
      return correction(
        input.browserCommandCount,
        toolCorrection("工具参数必须是有效的 JSON。", { code: "INVALID_JSON" }),
      );
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return correction(
        input.browserCommandCount,
        "工具参数必须是 JSON 对象。",
      );
    }

    if (
      input.call.function.name === "enable_browser_tools" &&
      input.catalog.grouped
    ) {
      const parsed = enableBrowserToolsInputSchema.safeParse(raw);
      if (!parsed.success)
        return correction(
          input.browserCommandCount,
          schemaCorrection(parsed.error),
        );
      return {
        browserCommandCount: input.browserCommandCount,
        output: input.catalog.enable(parsed.data.groups),
      };
    }

    if (input.call.function.name === "read_observation" && input.observations) {
      const parsed = readObservationInputSchema.safeParse(raw);
      if (!parsed.success)
        return correction(
          input.browserCommandCount,
          schemaCorrection(parsed.error),
        );
      const page = input.observations.read(
        parsed.data.observationId,
        parsed.data.cursor,
      );
      return {
        browserCommandCount: input.browserCommandCount,
        output: page.accepted === false ? page : { result: page },
      };
    }

    if (input.call.function.name === "record_progress" && input.observations) {
      const parsed = recordProgressInputSchema.safeParse(raw);
      if (!parsed.success)
        return correction(
          input.browserCommandCount,
          schemaCorrection(parsed.error),
        );
      if (
        !parsed.data.observations.every((item) =>
          input.observations!.hasDeliveredQuote(
            item.observationId,
            item.cursor,
            item.quote,
          ),
        )
      )
        return correction(
          input.browserCommandCount,
          "进度引用必须逐字来自本执行段已交付分页；请先读取观察，不得编造已确认事实。",
        );
      return {
        browserCommandCount: input.browserCommandCount,
        output: {
          accepted: true,
          checkpoint: {
            ...parsed.data,
            kind: "PLAN_WITH_OBSERVED_QUOTES",
            notice:
              "阶段和下一步是执行计划，引用是历史观察；不代表当前 ref 有效或验收通过。",
          },
        },
      };
    }

    if (input.call.function.name === "browser_command") {
      const catalogCorrection = input.catalog.correctionFor(
        (raw as Record<string, unknown>).commandType,
        input.advertisedGroups,
      );
      if (catalogCorrection)
        return correction(input.browserCommandCount, catalogCorrection);
      const browserArguments = parseBrowserCommand(
        raw as Record<string, unknown>,
      );
      if (!browserArguments.success) {
        return correction(
          input.browserCommandCount,
          browserArguments.correction,
        );
      }
      const command = browserArguments.command;
      const scrollCorrection = input.observations?.scrollCorrection(command);
      if (scrollCorrection)
        return {
          browserCommandCount: input.browserCommandCount,
          output: scrollCorrection,
        };
      if (
        this.toolLimit >= 3 &&
        (input.remainingToolCalls ?? Infinity) < 3 &&
        !READ_COMMANDS.has(command.commandType)
      ) {
        return correction(
          input.browserCommandCount,
          toolCorrection(
            "工具预算已进入收尾阶段，请只读核对最近操作、记录验收结果并结束；不能再发起新操作。",
            {
              code: "COMMAND_NOT_ALLOWED",
              nextAction:
                "只读核对最近操作，调用 record_criterion 或 finish_verification 收尾。",
            },
          ),
        );
      }
      const activeRecovery = input.locatorRecoveryState;
      const retargetAttempt =
        activeRecovery !== null &&
        isLocatorRetargetAttempt(activeRecovery, command);
      if (retargetAttempt && activeRecovery.exhausted) {
        return {
          browserCommandCount: input.browserCommandCount,
          locatorRecoveryState: activeRecovery,
          output: {
            accepted: false,
            error: `${activeRecovery.failedCommandType} 已用完两次重新定位机会。请停止继续操作，并将受影响的验收标准记录为 INCONCLUSIVE。`,
            locatorRecovery: locatorRecoveryDetails({
              error: null,
              recoveryState: activeRecovery,
              snapshot: null,
            }),
          },
        };
      }
      if (
        retargetAttempt &&
        !locatorRetargetAcknowledged(
          activeRecovery,
          command,
          browserArguments.locatorRecoveryToken,
        )
      ) {
        return {
          browserCommandCount: input.browserCommandCount,
          locatorRecoveryState: activeRecovery,
          output: {
            accepted: false,
            code: "LOCATOR_RECOVERY_NOT_ACKNOWLEDGED",
            error:
              "尚未执行操作：重新定位必须带回正确的 locatorRecoveryToken，并使用当前 ref 或收窄后的 selector。请修正参数后再操作。",
            locatorRecovery: locatorRecoveryDetails({
              acknowledged: false,
              error: null,
              recoveryState: activeRecovery,
              snapshot: null,
            }),
          },
        };
      }
      const unreadCorrection = input.observations?.unreadRefCorrection(command);
      if (unreadCorrection)
        return {
          browserCommandCount: input.browserCommandCount,
          output: unreadCorrection,
        };
      const staleRef = input.observations?.staleRef(command) ?? false;
      const staleVisual =
        command.commandType === "page.click" &&
        "point" in command.payload &&
        (!command.payload.visualObservationId ||
          command.payload.visualObservationId !==
            input.observations?.currentVisual()?.observationId);
      const attempted = staleRef || staleVisual ? 0 : 1;
      try {
        const result =
          staleRef || staleVisual
            ? {
                status: "FAILED",
                accepted: false,
                error: {
                  code: staleRef
                    ? "STALE_DOM_REFERENCE"
                    : "STALE_VISUAL_OBSERVATION",
                  message:
                    "该引用或截图不属于当前有效观察；已重新观察，请按原意图定位。",
                },
              }
            : await this.browserCommand(
                input.lease,
                command,
                input.signal,
                input.observations,
              );
        collectEvidence(result, input.evidence);
        const commandError = browserCommandError(result);

        if (activeRecovery && retargetAttempt) {
          const retargetAttempts = activeRecovery.retargetAttempts + 1;
          const acknowledged = locatorRetargetAcknowledged(
            activeRecovery,
            command,
            browserArguments.locatorRecoveryToken,
          );
          if (acknowledged && browserCommandSucceeded(result)) {
            return {
              browserCommandCount: input.browserCommandCount + attempted,
              locatorRecoveryState: null,
              output: result,
            };
          }
          const recoveryState: LocatorRecoveryState = {
            ...activeRecovery,
            exhausted: retargetAttempts >= 2,
            retargetAttempts,
          };
          const recoverySnapshot = recoveryState.exhausted
            ? { attempted: false, snapshot: null }
            : await this.captureLocatorRecoverySnapshot({
                command,
                evidence: input.evidence,
                lease: input.lease,
                signal: input.signal,
                observations: input.observations,
              });
          return {
            browserCommandCount:
              input.browserCommandCount +
              attempted +
              (recoverySnapshot.attempted ? 1 : 0),
            locatorRecoveryState: recoveryState,
            output: locatorRecoveryOutput({
              acknowledged,
              error: commandError,
              recoveryState,
              result,
              snapshot: recoverySnapshot.snapshot,
            }),
          };
        }

        if (
          [
            "LOCATOR_AMBIGUOUS",
            "STALE_DOM_REFERENCE",
            "STALE_VISUAL_OBSERVATION",
            "SCROLL_TARGET_NOT_SCROLLABLE",
          ].includes(String(commandError?.code))
        ) {
          const recoveryState: LocatorRecoveryState = {
            exhausted: false,
            failedCommandType: command.commandType,
            failedFrameContext: commandFrameContext(command),
            failedTargetSelectors: commandTargetSelectors(command),
            recoveryToken: input.call.id,
            retargetAttempts: 0,
          };
          const recoverySnapshot = await this.captureLocatorRecoverySnapshot({
            command,
            evidence: input.evidence,
            lease: input.lease,
            signal: input.signal,
            observations: input.observations,
          });
          return {
            browserCommandCount:
              input.browserCommandCount +
              attempted +
              (recoverySnapshot.attempted ? 1 : 0),
            locatorRecoveryState: recoveryState,
            output: locatorRecoveryOutput({
              acknowledged: false,
              error: commandError,
              recoveryState,
              result,
              snapshot: recoverySnapshot.snapshot,
            }),
          };
        }

        return {
          browserCommandCount: input.browserCommandCount + attempted,
          output: result,
        };
      } catch (error) {
        if (activeRecovery && retargetAttempt) {
          const retargetAttempts = activeRecovery.retargetAttempts + 1;
          const recoveryState: LocatorRecoveryState = {
            ...activeRecovery,
            exhausted: retargetAttempts >= 2,
            retargetAttempts,
          };
          const recoverySnapshot = recoveryState.exhausted
            ? { attempted: false, snapshot: null }
            : await this.captureLocatorRecoverySnapshot({
                command,
                evidence: input.evidence,
                lease: input.lease,
                signal: input.signal,
                observations: input.observations,
              });
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const commandError = thrownBrowserCommandError(error, errorMessage);
          return {
            browserCommandCount:
              input.browserCommandCount +
              attempted +
              (recoverySnapshot.attempted ? 1 : 0),
            locatorRecoveryState: recoveryState,
            output: locatorRecoveryOutput({
              acknowledged: locatorRetargetAcknowledged(
                activeRecovery,
                command,
                browserArguments.locatorRecoveryToken,
              ),
              error: commandError,
              recoveryState,
              result: {
                accepted: false,
                error: commandError,
                status: "FAILED",
              },
              snapshot: recoverySnapshot.snapshot,
            }),
          };
        }
        // A command was attempted. Keep transport failures separate from
        // argument corrections, which never issue a browser command.
        return {
          browserCommandCount: input.browserCommandCount + attempted,
          output: {
            accepted: false,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    if (input.call.function.name === "record_criterion") {
      const parsed = recordCriterionInputSchema.safeParse(raw);
      if (!parsed.success) {
        return correction(
          input.browserCommandCount,
          schemaCorrection(parsed.error),
        );
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
          "未知的验收标准；请使用任务中声明的 criterionId。",
        );
      }
      const unavailable = parsed.data.evidenceRefs.filter(
        (reference) => !input.evidence.has(reference),
      );
      if (unavailable.length > 0) {
        return correction(
          input.browserCommandCount,
          "验收标准引用了尚未观察到的证据；请仅使用工具返回或任务提供的证据引用。",
        );
      }
      if (parsed.data.status !== "INCONCLUSIVE") {
        const observationError = input.observations?.verdictEvidenceError(
          parsed.data.evidenceRefs,
        );
        if (observationError)
          return correction(input.browserCommandCount, observationError);
      }
      if (parsed.data.status === "PASSED") {
        if (
          criterion.requireObservedEvidence ||
          criterion.observationTargets?.length
        ) {
          if (!criterion.observationTargets?.length)
            return correction(
              input.browserCommandCount,
              "该 Spec 未定义逐对象的 observationTargets，不能确认覆盖完整；请记录 INCONCLUSIVE 并重新生成 Spec。",
            );
          const missing = criterion.observationTargets.filter(
            (target) =>
              !parsed.data.observations?.some(
                (item) =>
                  item.target === target.label &&
                  item.quote.includes(target.expectedText) &&
                  input.observations?.hasDeliveredQuote(
                    item.observationId,
                    item.cursor,
                    item.quote,
                  ),
              ),
          );
          if (missing.length)
            return correction(
              input.browserCommandCount,
              `通过结论缺少已观察原文覆盖：${missing.map((target) => target.label).join("、")}。请逐对象提供 observations 中的 target、observationId、cursor 和 quote；无法验证则记录 INCONCLUSIVE。`,
            );
        }
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
      if (
        parsed.data.status === "FAILED" &&
        input.locatorRecoveryState &&
        (!input.locatorRecoveryState.criterionId ||
          input.locatorRecoveryState.criterionId === parsed.data.criterionId)
      ) {
        const recoveryState = {
          ...input.locatorRecoveryState,
          criterionId: parsed.data.criterionId,
        };
        return {
          browserCommandCount: input.browserCommandCount,
          locatorRecoveryState: recoveryState,
          output: {
            accepted: false,
            error: recoveryState.exhausted
              ? `${recoveryState.failedCommandType} 的定位问题在两次重新定位后仍未解决。这属于自动化不确定性，不能记录为产品 FAILED；请将验收标准 ${parsed.data.criterionId} 记录为 INCONCLUSIVE。`
              : `${recoveryState.failedCommandType} 的 LOCATOR_AMBIGUOUS 尚未通过带恢复 token 的唯一 ref 或精确 selector 成功恢复，不能据此记录产品 FAILED；请继续重新定位，或将验收标准 ${parsed.data.criterionId} 记录为 INCONCLUSIVE。`,
          },
        };
      }
      input.criterionResults.set(parsed.data.criterionId, parsed.data);
      const settlesLocatorRecovery =
        input.locatorRecoveryState !== null &&
        ((input.locatorRecoveryState.criterionId === parsed.data.criterionId &&
          parsed.data.status !== "FAILED") ||
          (!input.locatorRecoveryState.criterionId &&
            parsed.data.status === "INCONCLUSIVE"));
      return {
        browserCommandCount: input.browserCommandCount,
        ...(settlesLocatorRecovery ? { locatorRecoveryState: null } : {}),
        output: { accepted: true },
      };
    }

    if (input.call.function.name === "request_human_input") {
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
        return correction(
          input.browserCommandCount,
          schemaCorrection(parsed.error),
        );
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
            context:
              parsed.data.kind === "TEST_ACCOUNT"
                ? {
                    ...parsed.data.context,
                    purpose: "BUSINESS_TEST_SUBJECT",
                    usage:
                      parsed.data.context.usage === "READ_EXISTING"
                        ? "READ_EXISTING"
                        : "CREATE_OR_MODIFY",
                    runId: input.task.snapshot.runId,
                    environment:
                      readTargetUrl(input.task.snapshot.environment) ?? null,
                  }
                : parsed.data.context,
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
            responseSchema:
              parsed.data.kind === "TEST_ACCOUNT"
                ? {
                    type: "object",
                    properties: {
                      account: { type: "string", minLength: 1, maxLength: 200 },
                    },
                    required: ["account"],
                    additionalProperties: false,
                  }
                : parsed.data.responseSchema,
          },
          kind: "WAITING_HUMAN",
          summary: parsed.data.summary,
        }),
        output: { accepted: true },
      };
    }

    if (input.call.function.name === "finish_verification") {
      const parsed = finishInputSchema.safeParse(raw);
      if (!parsed.success) {
        return correction(
          input.browserCommandCount,
          schemaCorrection(parsed.error),
        );
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
      // Stage all submitted criteria through the same validation as incremental
      // records. A rejected finish must not partially accept its new results.
      const staged = new Map(input.criterionResults);
      let recovery = input.locatorRecoveryState;
      const submittedIds = new Set<string>();
      for (const criterion of parsed.data.criteria ?? []) {
        if (submittedIds.has(criterion.criterionId))
          return correction(
            input.browserCommandCount,
            "同一次结束调用不能重复提交相同 criterionId。",
          );
        submittedIds.add(criterion.criterionId);
        const recorded = await this.executeTool({
          ...input,
          criterionResults: staged,
          locatorRecoveryState: recovery,
          call: {
            ...input.call,
            function: {
              name: "record_criterion",
              arguments: JSON.stringify(criterion),
            },
          },
        });
        if ((recorded.output as { accepted?: boolean }).accepted !== true)
          return recorded;
        if (recorded.locatorRecoveryState !== undefined)
          recovery = recorded.locatorRecoveryState;
      }
      const missing = input.task.snapshot.criteria
        .filter((criterion) => criterion.required)
        .filter((criterion) => !staged.has(criterion.id));
      if (missing.length > 0) {
        return correction(
          input.browserCommandCount,
          `完成验证前必须记录所有必需的验收标准：${missing
            .map((criterion) => criterion.id)
            .join(", ")}。`,
        );
      }
      const criteria = input.task.snapshot.criteria
        .map((criterion) => staged.get(criterion.id))
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
        return correction(
          input.browserCommandCount,
          schemaCorrection(outcome.error),
        );
      }
      return {
        browserCommandCount: input.browserCommandCount,
        outcome: outcome.data,
        output: { accepted: true },
      };
    }

    return correction(
      input.browserCommandCount,
      toolCorrection("未知工具；请使用本轮公布的工具。", {
        code: "UNKNOWN_TOOL",
      }),
    );
  }
}

function modelTransport(attempts: readonly ModelRequestAttempt[]) {
  if (attempts.length === 0) return null;
  return {
    attemptCount: attempts.length,
    retryCount: Math.max(0, attempts.length - 1),
    attempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      durationMs:
        attempt.durationMs ?? Math.max(0, Date.now() - attempt.startedAt),
      status: attempt.status,
      outcome: attempt.outcome,
    })),
  };
}

function correction(
  browserCommandCount: number,
  message: string | ToolCorrection,
) {
  const output =
    typeof message === "string"
      ? toolCorrection(redactTraceText(message))
      : message;
  return {
    browserCommandCount,
    correctionBytes: Buffer.byteLength(JSON.stringify(output)),
    output,
  };
}

function browserCommandError(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  return error as Record<string, unknown>;
}

function thrownBrowserCommandError(
  error: unknown,
  fallbackMessage: string,
): Record<string, unknown> {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    return {
      ...record,
      message:
        typeof record.message === "string" ? record.message : fallbackMessage,
    };
  }
  return { message: fallbackMessage };
}

function locatorRecoveryCommand(
  command: RuntimeActionCommand,
): RuntimeActionCommand | null {
  const payload = command.payload as Record<string, unknown>;
  const candidate =
    ["frame.click", "frame.fill"].includes(command.commandType) && payload.frame
      ? { commandType: "frame.snapshot", payload: { frame: payload.frame } }
      : { commandType: "page.snapshot", payload: {} };
  const parsed = runtimeActionCommandInputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function locatorRecoveryOutput(input: {
  acknowledged: boolean;
  error: Record<string, unknown> | null;
  recoveryState: LocatorRecoveryState;
  result: unknown;
  snapshot: unknown;
}) {
  const original =
    input.result &&
    typeof input.result === "object" &&
    !Array.isArray(input.result)
      ? (input.result as Record<string, unknown>)
      : { result: input.result };
  return {
    ...original,
    locatorRecovery: locatorRecoveryDetails({
      acknowledged: input.acknowledged,
      error: input.error,
      recoveryState: input.recoveryState,
      snapshot: input.snapshot,
    }),
  };
}

function locatorRecoveryDetails(input: {
  acknowledged?: boolean;
  error: Record<string, unknown> | null;
  recoveryState: LocatorRecoveryState;
  snapshot: unknown;
}) {
  return {
    action: "RESNAPSHOT_AND_RETARGET",
    candidates:
      input.error?.details &&
      typeof input.error.details === "object" &&
      !Array.isArray(input.error.details)
        ? ((input.error.details as Record<string, unknown>).candidates ?? [])
        : [],
    exhausted: input.recoveryState.exhausted,
    failedCommandType: input.recoveryState.failedCommandType,
    guidance: input.recoveryState.exhausted
      ? "两次重新定位仍未解决目标。不要继续猜测或使用 first/nth；将受影响的验收标准记录为 INCONCLUSIVE，不能记录为产品 FAILED。"
      : input.acknowledged === false && input.recoveryState.retargetAttempts > 0
        ? "本次操作没有正确确认原定位恢复：必须带回 locatorRecoveryToken，并使用 recovery snapshot 中的完整 ref，或使用包含原 selector 且增加页面区域/文本结构约束的 selector。已自动重新采集页面结构。"
        : "已自动重新采集页面结构。请带回 locatorRecoveryToken，并从候选或 recovery snapshot 中选择与操作意图一致的完整 ref；若必须使用 selector，应在原 selector 上增加页面区域或文本结构约束。不要使用 first/nth 猜测。定位成功前不能据此记录产品 FAILED。",
    maxRetargetAttempts: 2,
    recoveryToken: input.recoveryState.recoveryToken,
    retargetAttempts: input.recoveryState.retargetAttempts,
    snapshot: input.snapshot,
  };
}

function isLocatorRetargetAttempt(
  recoveryState: LocatorRecoveryState,
  command: RuntimeActionCommand,
): boolean {
  if (command.commandType !== recoveryState.failedCommandType) return false;
  return "target" in command.payload || "point" in command.payload;
}

function locatorRetargetAcknowledged(
  recoveryState: LocatorRecoveryState,
  command: RuntimeActionCommand,
  recoveryToken: string | undefined,
): boolean {
  if (recoveryToken !== recoveryState.recoveryToken) return false;
  const payload = command.payload as Record<string, unknown>;
  if (
    command.commandType === "page.click" &&
    "point" in command.payload &&
    command.payload.visualObservationId
  )
    return true;
  const target = payload.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return false;
  }
  const targetRecord = target as Record<string, unknown>;
  if (typeof targetRecord.ref === "string") return true;
  const targetSelector = targetRecord.selector;
  if (typeof targetSelector !== "string") return false;
  if (commandFrameContext(command) !== recoveryState.failedFrameContext) {
    return false;
  }
  return recoveryState.failedTargetSelectors.some(
    (selector) =>
      targetSelector !== selector && targetSelector.includes(selector),
  );
}

function commandTargetSelectors(command: RuntimeActionCommand): string[] {
  const payload = command.payload as Record<string, unknown>;
  const target = payload.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return [];
  const selector = (target as Record<string, unknown>).selector;
  return typeof selector === "string" ? [selector] : [];
}

function commandFrameContext(command: RuntimeActionCommand): string | null {
  const payload = command.payload as Record<string, unknown>;
  const frame = payload.frame;
  if (frame && typeof frame === "object" && !Array.isArray(frame)) {
    return JSON.stringify(frame);
  }
  const target = payload.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return null;
  }
  const frameSelector = (target as Record<string, unknown>).frameSelector;
  return typeof frameSelector === "string" ? frameSelector : null;
}

function browserCommandSucceeded(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.ok === true || record.status === "SUCCEEDED";
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
  if (typeof value === "string") {
    if (/^data:image\//u.test(value)) return "[viewport image omitted]";
    // Chat Completions tool arguments and outputs are JSON strings, including nested
    // serialized results. Apply the same key redaction before truncating them.
    if (/^\s*[\[{"]/u.test(value)) {
      if (depth >= 6) return "[depth limit]";
      try {
        return JSON.stringify(
          tracePreview(JSON.parse(value) as unknown, depth + 1),
        ).slice(0, TRACE_STRING_LIMIT);
      } catch {
        // Non-JSON page text still uses text redaction below.
      }
    }
    return redactTraceText(value).slice(0, TRACE_STRING_LIMIT);
  }
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
        SENSITIVE_TRACE_KEY.test(key) ||
        key === "dataBase64" ||
        /^(?:reasoning|reasoning_content|reasoning_details)$/u.test(key)
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
  return (
    record.accepted === false ||
    ["FAILED", "TIMED_OUT", "CANCELLED"].includes(String(record.status))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function traceErrorMessage(error: unknown): string {
  return redactTraceText(errorMessage(error)).slice(0, 4_000);
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

type FinalizationReason = z.infer<
  typeof runtimeVerificationTerminationReasonSchema
>;

function finalizationReserveMs(policy: RuntimeDeadlinePolicy) {
  return policy.mode === "ADAPTIVE"
    ? policy.finalizationReserveSeconds * 1_000
    : 15_000;
}

function finalizationDue(
  task: RuntimeTaskLease,
  policy: RuntimeDeadlinePolicy,
) {
  return (
    Date.parse(task.snapshot.deadlineAt) - Date.now() <=
    finalizationReserveMs(policy)
  );
}

function finalizationOutcome(input: {
  browserCommandCount: number;
  criterionResults: Map<string, z.infer<typeof recordCriterionInputSchema>>;
  evidence: Map<string, RuntimeEvidenceRef>;
  task: RuntimeTaskLease;
  reason: FinalizationReason;
}): RuntimeOutcome {
  const reason = {
    FINALIZATION_RESERVE_REACHED:
      "已进入截止前收尾窗口，剩余执行时间不足以继续验证。",
    REPEATED_OPERATIONS:
      "重复操作持续未产生新的页面观察或验收进展，已停止自动执行。",
    TEXT_ONLY_LOOP:
      "模型连续四轮只返回文本，未调用工具继续验证，已停止自动执行。",
    TOOL_LIMIT_REACHED: "工具调用预算已用尽，已停止继续操作并保留验收结果。",
    LOCATOR_RECOVERY_EXHAUSTED:
      "定位恢复的两次重新定位均未成功，已停止自动执行并保留验收结果。",
  }[input.reason];
  const missing = input.task.snapshot.criteria.filter(
    (criterion) => !input.criterionResults.has(criterion.id),
  );
  if (input.browserCommandCount === 0) {
    return runtimeOutcomeSchema.parse({
      kind: "FATAL_FAILURE",
      executionDisposition: "NOT_RUN",
      error: {
        code:
          input.reason === "TOOL_LIMIT_REACHED"
            ? "AGENT_TOOL_LIMIT_EXCEEDED"
            : input.reason === "FINALIZATION_RESERVE_REACHED"
              ? "VERIFICATION_BUDGET_EXHAUSTED"
              : "AGENT_NO_PROGRESS",
        failureClass: "TOOL_EXECUTION",
        message: reason,
        phase: "browser_verification",
        details: {
          reason: input.reason,
          unverifiedCriterionIds: input.task.snapshot.criteria.map(
            (criterion) => criterion.id,
          ),
        },
      },
      summary: `${reason}尚未执行浏览器命令，${input.task.snapshot.criteria.length} 条验收标准未验证。`,
    });
  }
  const criteria = input.task.snapshot.criteria.map(
    (criterion) =>
      input.criterionResults.get(criterion.id) ?? {
        criterionId: criterion.id,
        evidenceRefs: [],
        status: "INCONCLUSIVE" as const,
        summary: `${reason}此标准尚未形成可确认的验收结论。`,
      },
  );
  const statuses = criteria.map((criterion) => criterion.status);
  const verdict = statuses.includes("FAILED")
    ? "FAILED"
    : statuses.includes("INCONCLUSIVE")
      ? "INCONCLUSIVE"
      : "PASSED";
  const summary = [
    reason,
    `${missing.length} 条尚未完成的验收标准已标记为 INCONCLUSIVE；已记录的结果与证据保留。`,
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
    termination: { reason: input.reason },
    summary,
    verdict,
  });
}

class FinalizationWindowReachedError extends Error {
  constructor() {
    super("已进入浏览器验证收尾窗口。");
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function settleWithin(operation: Promise<unknown>, budgetMs: number) {
  const settled = operation.catch(() => undefined);
  if (budgetMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortScope(
  parent: AbortSignal,
  timeoutMs: number | null,
  finalizationAt: () => number,
) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const modelDeadline =
    timeoutMs === null ? Infinity : performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (controller.signal.aborted) return;
    const untilFinalization = finalizationAt() - Date.now();
    const untilModelDeadline = modelDeadline - performance.now();
    if (untilFinalization <= 0) {
      controller.abort(new FinalizationWindowReachedError());
    } else if (untilModelDeadline <= 0) {
      controller.abort(
        new Error(`模型响应超过 ${Math.round(timeoutMs! / 1_000)} 秒。`),
      );
    } else {
      // Heartbeats may extend the Run while a model is pending; re-read the
      // deadline when the timer fires without exceeding the model-call cap.
      timer = setTimeout(arm, Math.min(untilFinalization, untilModelDeadline));
      timer.unref();
    }
  };
  arm();
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
    requiredCapabilities: [
      ...new Set([
        "browser",
        "dom-vision-v1",
        ...(Array.isArray(browser.requiredCapabilities)
          ? browser.requiredCapabilities.filter(
              (item): item is string => typeof item === "string",
            )
          : []),
      ]),
    ],
  } as const;
}

function toolDefinitions(
  catalog: BrowserToolCatalog,
  hitlEnabled = true,
  boundedContext = true,
) {
  return [
    {
      type: "function",
      name: "browser_command",
      description:
        "执行一次浏览器操作。使用 page.snapshot 观察当前页并复用返回的 ref；判断验收标准前要采集持久化证据。若返回 LOCATOR_AMBIGUOUS，必须在后续重新定位操作中原样带回 locatorRecoveryToken，并使用自动附带的 recovery snapshot 选择唯一目标；不能原样重试 selector 或用 first/nth 猜测，也不能据此判定产品失败。SPA 跳转优先等待特定 selector 或文本，不要优先使用 networkidle。NETWORK 证据需要响应数据时，调用 page.network，并设置 includeResponseBodies 和尽可能精确的 urlIncludes。",
      parameters: catalog.parameters(),
      strict: false,
    },
    ...catalog.discoveryTools(),
    {
      type: "function",
      name: "record_criterion",
      description:
        "仅根据实际观察到的浏览器证据，用简体中文记录一条已声明验收标准的结果。PASSED/FAILED 不能引用操作后自动截图；须等待业务结果稳定后主动观察。局部列表未看到目标不能证明不存在。",
      parameters: openAiFunctionSchema(recordCriterionInputSchema),
      strict: false,
    },
    ...(boundedContext
      ? [
          {
            type: "function",
            name: "record_progress",
            description:
              "保存跨轮执行进度：当前阶段、已读观察的准确原文和下一步计划。仅在阶段转换或需要保留关键观察时使用，不要每次阅读都调用。不能替代 record_criterion，不能让旧 ref 重新有效。",
            parameters: openAiFunctionSchema(recordProgressInputSchema),
            strict: false,
          },
          {
            type: "function",
            name: "read_observation",
            description:
              "读取本执行段已缓存的浏览器观察。使用 observationId 和返回的 nextCursor 分页；不会重新操作浏览器。HISTORICAL 内容只用于回顾，不能据此使用旧 ref。",
            parameters: openAiFunctionSchema(readObservationInputSchema),
            strict: false,
          },
        ]
      : []),
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
        "提交最终结论；可在 criteria 中一次提交验收结果及证据引用，无需先逐条 record_criterion。所有必需标准必须通过相同的证据校验；最终摘要使用简体中文。",
      parameters: openAiFunctionSchema(finishInputSchema),
      strict: false,
    },
  ].map(({ type: _type, ...definition }) => ({
    type: "function" as const,
    function: definition,
  }));
}

function taskPrompt(task: RuntimeTaskLease, targetUrl?: string) {
  return JSON.stringify(
    {
      acceptanceCriteria: task.snapshot.criteria,
      availableBusinessReferences: task.snapshot.businessReferences,
      goal: task.snapshot.goal,
      humanResume: readHumanResume(task.snapshot.executionPolicy),
      executionContext: {
        caseIsolation: "INDEPENDENT",
        prerequisiteStatus: "UNVERIFIED_UNTIL_OBSERVED_IN_THIS_CASE",
        guidance:
          "前置条件是待核查要求，不是完成证明。其他 Case 的结果未交付到本执行段；旧任务写有已完成其他 Case 或已了解参照路径时，先在本 Case 独立只读核验。写入账号仅使用明确提供的测试账号或 TEST_ACCOUNT 答复；旧 Spec 的列表账号复用建议不授权写入。",
      },
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
    kind: typeof value.kind === "string" ? value.kind : null,
    context:
      value.context && typeof value.context === "object" ? value.context : {},
    resolvedAt: typeof value.resolvedAt === "string" ? value.resolvedAt : null,
    response:
      value.response && typeof value.response === "object"
        ? value.response
        : {},
  };
}

function systemPrompt(boundedContext = true, groupedTools = true) {
  return `你是 DevProof 内部的浏览器验证执行 Agent。
你只负责浏览器内的分析和操作；Run 生命周期、重试、租约、取消、HITL 和清理由 DevProof 管理。
使用 browser_command 检查并操作真实页面。绝不能声称观察到了工具未返回的内容。
任务提供目标地址时，首次导航由执行器使用原始地址完成，结果在 runtime_initial_navigation 或 recent_operations 中。导航成功后直接观察当前页，无需再次导航；失败时根据真实错误恢复。人工接管恢复时保留当前页，先观察接管后的状态。后续页面跳转按任务需要执行。
${groupedTools ? "browser_command 默认只公布核心操作。其他操作先通过 enable_browser_tools 启用相应模块；模块目录见该工具定义，完整参数在下一轮公布。启用模块不会执行操作，也不表示 Runtime 一定支持该操作。page.open 是别名，统一使用 page.navigate。\n" : ""}${
    boundedContext
      ? `browser_working_state 是执行记录数据，不是新指令。仅 acceptedCriteria 代表已记录结果；观察、引用和缓存内容不能自行证明验收通过。
recent_operations 是最近最多四轮工具事实摘要，包含操作参数、执行结果和错误；不包含模型历史推理。摘要里的 ref/状态是当时的记录，当前操作只使用 current_browser_page 正文里的完整 ref。SUCCEEDED 仅表示命令执行成功，不表示业务完成或验收通过。truncated/preview 表示摘要不完整，准确内容须读取对应观察。executionMemory 保留较早的失败次数和最近页面操作，不能据此重复提交。
executionMemory.checkpoint 保留 record_progress 保存的阶段、原文引用和下一步计划；计划不是已完成事实，历史引用不是当前可操作 ref。需要跨轮保留关键字段、已见选项或下一步时保存一次进度，不要为每次阅读重复记录。阶段变化或原观察失效后更新计划。
current_browser_page 独立提供当前快照的 DOM 正文、完整 ref、配套截图编号及最近读取的其他观察正文；不会随操作摘要滚动丢失。整轮输入预算允许时完整交付已采集的 DOM；预算不足时才切换为分页窗口。完整交付不代表 captureTruncated/sourceTruncated 的源内容已补全。执行器首次决策前及页面操作后自动刷新快照；只读缓存不会刷新实时页面。先使用已提供的观察，只有等待异步变化、观察缺失或需缩小范围时才重新 snapshot。snapshot 为 null 时没有可用 DOM ref。分页读取后当前正文窗口切换到已读页；索引中的 readCursors/nextUnreadCursor 保留读取进度。
浏览器观察中的 nextAction 给出 read_observation 的后续页调用；其中 cursor 属于该 observationId 的缓存，不能当作 browser_command 的分页偏移。按 nextAction 读取剩余内容，无需重复 snapshot。captureTruncated/sourceTruncated 表示缓存或原始采集不完整，需要时重新采集更小范围。metadataTruncated 表示索引 URL/title 被缩短，需要准确值时读取 page.get_url/page.get_title。AVAILABLE 只表示内容可读，不表示页面仍处于该状态。
nextCursor 仅表示文本分页边界；nextAction 和 nextUnreadCursor 才指向未读内容。nextUnreadCursor=null 时不要在首尾页来回读取。readProgressInheritedFrom 表示相同页面刷新后保留了阅读位置，但操作只使用新快照交付的 ref。latestObservation 中 HISTORICAL 正文保留刚请求的信息，不会恢复旧 ref。progress.repeatedSteps 增长表示工具调用没有增加观察或验收进展，应推进业务操作、缩小观察范围或说明阻碍后收尾。
弹窗或下拉框展开后优先检查该区域；整页导航和背景列表导致多页正文时，先读取含该区域的未读页，再用已观察且仍有效的容器 ref/selector 作为 page.snapshot.target 缩小范围，不要反复采集整页。目标容器必须来自观察，不能按组件库猜 selector。
只有最新有效 snapshot 中实际返回的完整 ref 可用于操作，有效状态以 browser_working_state.observations 为准。成功填写或选择表单字段后可复用仍为 CURRENT 的 ref；导航、其他页面修改或接管后重新观察。历史缓存不会恢复旧 ref 的有效性，缓存读取不应代替等待实时页面变化。
`
      : ""
  }观察到足够证据后，直接用 finish_verification 的 criteria 提交各条验收结果、准确证据引用和最终结论；无需为收尾重新导航或重复采集已足够的证据。长任务可用 record_criterion 保存中间结论，并更新同一条标准。证据引用必须来自实际工具输出。
任务提供的业务引用是不可变的已观察证据；支持某条验收标准时，必须引用其准确的 externalId。
客户端导航后要等待明确的 selector 或文本。除非确定应用最终会完全空闲，否则避免使用 networkidle。
搜索、筛选、保存等操作成功，只代表输入事件已执行；自动附带的 AFTER_ACTION 截图可能仍是加载遮罩下的旧表格。不能用它作为 PASSED/FAILED 的验收证据。先在 DOM + 图片中检查转圈、遮罩及结果更新，使用已观察到的 selector 等待 hidden，或用 page.snapshot/page.screenshot 重新观察直到加载结束，再引用新证据。domcontentloaded 不能证明 SPA 查询完成；page.wait 的 kind=text 等待文本出现，不能用它等待 Loading 消失。加载一直不结束或无法确定结果时应 INCONCLUSIVE；不要反复点击搜索/保存。
page.snapshot 提供实际 DOM 节点、文本、原生标签、值和 ref，同时附带视口截图。网站不需要实现 ARIA 或特定组件语法，不依赖 accessibility role。观察整个页面及弹层，不要按框架名字预设 DOM 结构。
current_browser_viewport 中的 image_url 才是你实际看到的图片；截图编号或文件名不代表看过图。DOM 不足（自定义控件、Canvas、封闭 Shadow DOM）时，结合截图判断，用 page.click 的 point 和该图 observationId 作为 visualObservationId 操作；不能猜坐标。滚动、导航、窗口变化或旧图失效后重新观察。图片缺失时先 page.screenshot，不能假装视觉成功。
原生 <select> 才能使用 page.select；自定义下拉先点击展开，再观察 DOM + 图片，点击当前可见选项，最后检查显示值和业务反馈。看到隐藏、重复候选时不能 first/nth 猜测。Canvas/自绘输入先视觉点击聚焦，再启用 input 工具组用不带 target 的 page.type 输入文本，必要时 page.press；操作后验证结果。
DOM 快照仅覆盖当前视口与未被滚动容器裁剪的内容；captureTruncated/sourceTruncated/nextCursor 也表示证据尚不完整。断言选项“不存在”之前，必须在已确认支持搜索的控件中使用合理短关键词并确认搜索完成，或从列表顶部逐段滚动到末尾、观察每一段。使用带 scrollY/scrollX 的容器 ref 作为 page.scroll.target，避免滚动背景页面；atEnd=false 表示还有未见内容，到末尾一次也不代表已检查中间全部内容。无 DOM 时根据图片中的滚动条判断，在下拉内部点击聚焦后滚动，并重新截图确认选项确实变化。虚拟列表、搜索无效或范围无法穷尽时记录 INCONCLUSIVE，不能凭当前几项判 FAILED。
page.scroll 的 target 必须是滚动容器本身，不是列表中的选项行。overflow:hidden 也可能是可程序化滚动容器，按快照中的 scrollY/scrollX 判断。每次滚动约容器可见高度的 75%，保留重叠内容；滚动后先检查新快照的选项是否变化。scrollFeedback.status=MOVED 只证明位移，AT_BOUNDARY 表示本方向边界，NO_MOVEMENT 表示没有效果，UNVERIFIED 或缺少该字段时效果尚未确认；settled 只表示局部短暂稳定，不保证异步业务加载完成。
SCROLL_TARGET_NOT_SCROLLABLE 要求从新快照改用真实容器 ref；SCROLL_NO_PROGRESS 表示当前方案已经无效，不能只更换 ref、距离或重复读取缓存。改用其他容器、反向滚动或已确认支持的搜索输入框；输入短关键词并确认过滤完成，再选择实际显示的目标。搜索改变条件后重新计算覆盖范围。观察索引可省略较旧条目（observationIndexOmitted），已有 observationId 仍可按缓存可用性读取；未列出不表示已读取或已删除。
下拉搜索要从实际页面文案出发：完整业务名称或内部枚举搜不到时，尝试较短关键词，再检查可见选项。连续清空并重复同一搜索而无进展时更换观察方式，不要循环。选项名称相似不能证明其内部枚举映射；要读取实际 DOM 值或对应网络证据。键盘组合使用 Control+A，不能使用 CTRL+A。
STALE_DOM_REFERENCE、STALE_VISUAL_OBSERVATION 或元素已被替换时重新观察并按原业务意图定位，不复用旧 ref/坐标。超时可能已经触发提交，须检查页面/网络结果再决定下一步，不盲目重复保存。
browser_command 返回 LOCATOR_AMBIGUOUS、STALE_DOM_REFERENCE、STALE_VISUAL_OBSERVATION 或 SCROLL_TARGET_NOT_SCROLLABLE 时，执行器会自动附带 recovery snapshot 和 locatorRecovery.recoveryToken。下一次重新定位必须把该值原样放在 browser_command 顶层 locatorRecoveryToken 中，并从 snapshot 或候选中选择与操作意图一致的完整 ref，或在原 selector 上增加页面区域或文本结构约束；禁止原样重试通用 selector，禁止用 first/nth 猜测。所有重新定位失败（包括 ELEMENT_NOT_FOUND 和 ELEMENT_NOT_VISIBLE）都会消耗两次上限。两次后仍无法唯一确定时，将受影响的验收标准记录为 INCONCLUSIVE，绝不能把自动化定位失败记录为产品 FAILED。
NETWORK 证据需要响应内容时，使用 page.network，设置 includeResponseBodies=true，并提供尽可能精确的 urlIncludes。
验收证据必须对应标准里的具体页面区域、控件和业务对象。记录 PASSED 时，必须逐个覆盖 observationTargets：在 observations 中提供对应 target（label）、observationId、cursor 和逐字 quote，quote 必须包含该对象的 expectedText 且来自已交付观察。仅看见下拉候选列表不证明选择后表单已经切换，必须引用实际选中状态及对应表单；多个对象不能只验证其中一个。创建弹窗的类型选项不证明列表筛选选项，更不证明筛选隔离；列表标准须在列表筛选器操作后，只读核对结果集合及所选类型。来源摘录、探索步骤或自拟测试标识不是实际页面证据。若旧 Spec 假设了未获来源支持的字段（例如备注），不得因为该字段不存在而判产品 FAILED；记录 INCONCLUSIVE 并说明 Spec 与来源不一致。
TEST_ACCOUNT 用于被加入名单等业务测试对象，区别于管理后台的登录身份；不要退出已有管理会话或要求两者相同。写入前只读核对环境、账号和所需类型的唯一键是否已有记录；已存在则请求独立账号，禁止删除既有记录来满足新建前置条件。默认并发执行，不假设其他 Case 的数据归属。缺账号继续使用 TEST_ACCOUNT，请在 context 中说明 usage="CREATE_OR_MODIFY"、requiredTypes 和 uniquenessConstraint；仅查看已有记录的筛选 Case 优先复用已有数据，必要时以 usage="READ_EXISTING" 请求账号，并保持只读。获得的账号只属于本 Case 的所声明用途，READ_EXISTING 答复不授权写入。记录实际创建的 ID、类型和证据，不能假设备注字段存在。
正向业务验证需要已有测试账号时，只使用任务或 humanResume.response.account 明确提供的账号；不要编造手机号、把时间戳示例填入账号字段，或自行拿列表中的其他用户做写入测试。缺少账号，或提交后明确观察到该账号不存在/不可用时，调用现有 request_human_input，kind="TEST_ACCOUNT"，用简体中文请求一个当前环境可用于本次测试的账号（页面支持手机号或 UUID 时说明即可），context 中保留字段、原始错误与证据引用。用户只需提供账号，不需要接管浏览器。恢复后先重新观察保留的页面，用 humanResume.response.account 填写并核对结果；不要因为任务正文中的旧示例而覆盖用户答复。HITL 禁用时将缺数据的标准记为 INCONCLUSIVE，不盲目试号。若验收目标就是无效账号应被拒绝，则保留负向测试输入，按实际错误验证，不索取有效账号。
result.actionFeedback 是浏览器采集的操作反馈，不是产品结论。inputCompleted 只代表操作完成；requests 是本次观察窗口内发起的候选请求，temporal 关联不证明因果。检查响应中的业务错误，即使 HTTP 200 也不能直接判成功。pending 或 coverageIncomplete 时继续只读观察，不重复提交；同一输入出现明确拒绝时先纠正数据或请求 HITL。latestActionFeedback 保留最近反馈，不能用它替代最新页面。
保存后出现错误、弹窗不关闭或结果未更新时，先启用 diagnostics，读取 page.network（精确 urlIncludes、includeResponseBodies=true）及 page.console/page.errors。旧 Runtime 缺少 actionFeedback 时也必须走这条只读诊断路径；重复点击同一保存不能代替诊断。already exists 等唯一性拒绝意味着需要核查已有记录或换账号；前置数据冲突不应直接判产品失败。
remainingToolCalls 不足 3 次时进入收尾，不发起新的提交；优先核对最近操作并提交已完成标准，剩余标准记录 INCONCLUSIVE。范围标签 fN 不是元素 ref，不要将它当作 frame.snapshot 的引用；恢复过的无效方法不要重复尝试。
timeBudget.remainingExecutionSeconds 是扣除收尾预留后的剩余秒数，与 remainingToolCalls 独立；工具次数多不代表时间充足。剩余执行时间不足 60 秒时优先只读确认已有操作并提交部分结论，不再启动新的业务写入。每次模型失败后的 fallback 可能收到刷新的页面，仍需使用本次输入中的 ref。
只有无法自主继续时才能调用 request_human_input。至少执行一次浏览器操作并提供所有必需验收标准后，才能完成验证。
所有用户可见的生成内容必须使用简体中文，包括验收标准摘要、HITL 提示、等待摘要和最终验证摘要。标识符、URL、代码符号、API 路径、工具名、枚举值和 evidence reference 保持原样，不要翻译。
绝不能调用会话生命周期操作，也绝不能泄露凭据。`;
}
