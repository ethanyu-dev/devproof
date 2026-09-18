import {
  archiveStepContext,
  withStepIntent,
  withoutStepIntent,
  executionArguments,
  redactContext,
} from "./step-context.js";
import { BoundEvidence } from "./bound-evidence.js";
import {
  bindObservationInputSchema,
  readBindingsInputSchema,
  readEvidenceImagesInputSchema,
  visualComparisonInputSchema,
} from "@devproof/agent-runtime-protocol";
import {
  accountInputSlots,
  accountInputResponseSchema,
  businessAccountRequestSchema,
  resolveBusinessAccountRequest,
  accountRequestKindError,
} from "@devproof/agent-runtime-protocol";
import { randomUUID } from "node:crypto";

import {
  browserExecutionCriterion,
  executionStateSchema,
  executionRecordDeltaSchema,
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
import {
  isInvalidModelToolSchema,
  openAiFunctionSchema,
} from "./model-tool-schema.js";
import { hasProvidedTestAccount, taskTestAccount } from "./test-account.js";
import {
  ExecutionJournal,
  executionProgressSchema,
} from "./execution-journal.js";
import {
  DATA_PRECONDITION,
  prepareDataPrecondition,
} from "./data-precondition.js";
import { ModelHealth } from "./model-health.js";

import type {
  ActiveLease,
  ControlPlaneClient,
} from "./control-plane.client.js";
import {
  criterionSubmissionSchema,
  resolveCriterionEvidence,
} from "./criterion-evidence.js";
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
  DEFAULT_MODEL_CALL_SECONDS,
  modelFunctionCalls,
  type ModelCompletion,
  type ModelClientFactory,
  type ModelFunctionCall,
  type ModelMessage,
  type ModelRequestAttempt,
} from "./model-types.js";

interface ToolExecutionResult {
  browserCommandCount: number;
  recordedCriteria?: boolean;
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
const observeSubjectInputSchema = z
  .object({
    criterionId: z.string().min(1).max(160),
    subject: z.string().min(1).max(500),
    observationId: z.string().uuid(),
    scopeRef: z.string().min(1).max(160),
    identityRef: z.string().min(1).max(160),
    stateRef: z.string().min(1).max(160),
  })
  .strict();
const recordProgressInputSchema = z
  .object({
    phase: z.string().trim().min(1).max(120),
    citations: z
      .array(z.object({ ref: z.string().min(1).max(160) }).strict())
      .min(1)
      .max(20)
      .optional(),
    observations: z
      .array(
        z
          .object({
            observationId: z.string().uuid(),
            cursor: z.number().int().nonnegative(),
            quote: z.string().trim().min(1).max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(6)
      .optional(),
    bindingIds: z.array(z.string().uuid()).min(1).max(20).optional(),
    executionState: executionStateSchema
      .partial()
      .extend({
        phase: executionProgressSchema.shape.phase,
        step: executionProgressSchema.shape.step,
        records: z
          .array(
            executionRecordDeltaSchema.extend({
              evidenceRefs: z
                .array(z.string().min(1).max(500))
                .max(20)
                .default([]),
            }),
          )
          .max(50)
          .optional(),
      })
      .optional(),
    nextAction: z.string().trim().min(1).max(500),
  })
  .strict();
const finishInputSchema = z.object({
  criteria: z.array(z.unknown()).max(100).optional(),
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
    onCheckpoint?: (policy: Record<string, unknown>) => void,
  ): Promise<RuntimeOutcome> {
    const recoveryPolicy = { ...task.snapshot.executionPolicy };
    signal.throwIfAborted();
    const targetUrl = readTargetUrl(task.snapshot.environment);
    const browserPolicy = readBrowserPolicy(task.snapshot.executionPolicy);
    await this.acquireBrowserWithPolicy(task, lease, signal, {
      availabilityPolicy: browserPolicy.availabilityPolicy,
      profile: browserPolicy.profile,
      requiredCapabilities: [...browserPolicy.requiredCapabilities],
      ...(targetUrl ? { targetUrl } : {}),
    });
    this.modelHealth.restore(task.snapshot.executionPolicy.modelCooldowns);
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
      task.snapshot.executionPolicy.formSequences === true,
      task.snapshot.criteria.some((c) => c.observationContract) &&
        task.snapshot.executionPolicy.combinedObservation !== false,
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
    const bound = new BoundEvidence(
      task.snapshot.criteria,
      task.snapshot.runId,
      task.snapshot.attemptId,
    );
    const observations = new BrowserObservations(
      undefined,
      context.bounded,
      bound,
      {
        focus: task.snapshot.executionPolicy.observationFocus !== false,
        delta: task.snapshot.executionPolicy.observationDelta === true,
        combined: task.snapshot.executionPolicy.combinedObservation !== false,
      },
    );
    const journal = new ExecutionJournal(task.snapshot.executionPolicy);
    const segmentId = `${task.taskId}:${lease.fencingToken}`;
    const segmentStartedAt = Date.now();
    let preferredModel = modelCandidates[0]!;
    // A schema rejection is deterministic for this execution's tool contract.
    // Do not probe that provider again after every successful browser action.
    const schemaRejectedCandidates = new Set<
      (typeof modelCandidates)[number]
    >();
    let lastModelSchemaError: unknown;
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
    const evidence = new Map<string, RuntimeEvidenceRef>();
    const savedProgress = task.snapshot.executionPolicy
      .verificationCheckpoint as
      | {
          criteria?: unknown[];
          observations?: unknown[];
          evidence?: unknown[];
          attemptId?: string;
          account?: string;
        }
      | undefined;
    const resumableProgress =
      savedProgress?.attemptId === task.snapshot.attemptId &&
      savedProgress?.account ===
        (taskTestAccount(task.snapshot.goal, task.snapshot.executionPolicy) ??
          journal.state.account);
    for (const item of resumableProgress
      ? (savedProgress?.criteria ?? [])
      : []) {
      const parsed = runtimeCriterionResultSchema.safeParse(item);
      if (
        parsed.success &&
        task.snapshot.criteria.some((c) => c.id === parsed.data.criterionId)
      )
        criterionResults.set(parsed.data.criterionId, parsed.data);
    }
    // Evidence was accepted and persisted by the control plane when checkpointed.
    for (const item of savedProgress?.evidence ?? []) {
      const ref = item as RuntimeEvidenceRef;
      if (ref?.externalId && ref.kind) evidence.set(ref.externalId, ref);
    }
    if (resumableProgress)
      observations.restoreCriterionFacts(savedProgress?.observations ?? []);
    if (bound.enabled) {
      let continuationToken: string | undefined;
      do {
        const restored = (await this.controlPlane.observationOperation(
          lease,
          "read",
          continuationToken ? { continuationToken } : {},
          signal,
        )) as { continuationToken?: string | null };
        bound.ingest(restored);
        collectEvidence(restored, evidence);
        continuationToken = restored.continuationToken ?? undefined;
      } while (continuationToken);
    }
    const checkpoint = async () => {
      const saved = {
        criteria: [...criterionResults.values()],
        observations: observations.retainedCriterionFacts(),
        bindingIds: bound.ids(),
        comparisonReviewIds: bound.reviewIds(),
        ...outcomeEvidence(task, evidence),
      };
      await this.saveJournal(lease, journal, saved);
      recoveryPolicy.executionState = journal.state;
      recoveryPolicy.verificationCheckpoint = {
        ...saved,
        attemptId: task.snapshot.attemptId,
      };
    };
    const remaining = Number(
      task.snapshot.executionPolicy.accountRequestRemainingToolCalls,
    );
    const toolLimit =
      Number.isInteger(remaining) && remaining >= 0
        ? Math.min(this.toolLimit, remaining)
        : this.toolLimit;
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
    let progress = new VerificationProgress();
    let progressRecoveryUsed = false;
    let progressRecovery: { sequence: number; guidance: string } | undefined;
    let cleanupRecoveryUsed = false;
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
      await settleWithin(checkpoint(), finalizationBudgetMs());
      const outcome = finalizationOutcome({
        browserCommandCount,
        criterionResults,
        evidence,
        task,
        reason,
        detail:
          reason === "EVIDENCE_SUBMISSION_FAILED"
            ? progress.evidenceSubmissionError
            : undefined,
      });
      const cleanupNotice = journal.cleanupNotice();
      if (cleanupNotice && outcome.kind === "VERIFICATION_COMPLETED")
        outcome.cleanup = {
          status: "BLOCKED",
          note: cleanupNotice.slice(0, 4000),
        };
      if (cleanupNotice)
        outcome.summary = `${cleanupNotice}\n${outcome.summary}`.slice(0, 8000);
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
      if (
        targetUrl &&
        !readHumanResume(task.snapshot.executionPolicy) &&
        !task.snapshot.executionPolicy.accountRequestCorrection
      ) {
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
      const account = taskTestAccount(
        task.snapshot.goal,
        task.snapshot.executionPolicy,
      );
      if (account && journal.state.account !== account) {
        journal.state.account = account;
        journal.state.accountAliases = [];
      }
      if (account || journal.state.accounts?.length) await checkpoint();
      for (let callCount = 0; callCount < toolLimit;) {
        signal.throwIfAborted();
        if (finalizationDue(task, deadlinePolicy)) {
          return await finalize("FINALIZATION_RESERVE_REACHED");
        }
        if (
          journal.cleanupReserveCalls() > 0 &&
          (toolLimit - callCount <= journal.cleanupReserveCalls() ||
            Date.parse(task.snapshot.deadlineAt) - Date.now() <
              finalizationReserveMs(deadlinePolicy) + 120_000)
        ) {
          journal.state.phase = "CLEANUP";
          journal.state.step =
            "剩余预算有限：停止新增验证，立即按 Spec 清理已跟踪的业务数据并保存证据；无法完成时记录具体对象和受阻原因。";
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
          tools: toolDefinitions(
            catalog,
            hitlPolicy.enabled,
            context.bounded,
            bound.enabled,
            task.snapshot.criteria.some(
              (c) => c.observationContract?.version === 3,
            ),
            task.snapshot.criteria.some(
              (c) => c.observationContract?.version === 2,
            ),
          ),
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
                if (journal.observe(output, evidence)) await checkpoint();
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
                ...(bound.enabled ? { objectEvidence: bound.view() } : {}),
                savedCriterionObservations: observations.criterionFactView(
                  task.snapshot.criteria
                    .filter((c) => !criterionResults.has(c.id))
                    .map((c) => c.id),
                ),
                executionState: journal.modelView(),
                currentGoal: {
                  phase: journal.state.phase,
                  step: journal.state.step,
                  unresolvedCriteria: task.snapshot.criteria
                    .filter((c) => !criterionResults.has(c.id))
                    .map((c) => ({ id: c.id, description: c.description })),
                  guidance:
                    "根据当前页面和已有证据选择本轮目标，在每次工具调用的 stepIntent 中说明准备做什么；目标和计划不是验收结论。",
                },
                acceptedCriteria: [...criterionResults.values()],
                unresolvedCriterionIds: task.snapshot.criteria
                  .filter((item) => !criterionResults.has(item.id))
                  .map((item) => item.id),
                evidenceCount: evidence.size,
                evidenceIndexOmitted: Math.max(0, evidence.size - 200),
                evidence: [...evidence.values()]
                  .slice(-200)
                  .map(({ externalId, kind }) => ({
                    externalId,
                    kind,
                    observationStage: observations.evidenceStage(externalId),
                  })),
                locatorRecovery: locatorRecoveryState,
                observations: observationIndex,
                observationIndexOmitted:
                  observations.index().length - observationIndex.length,
                latestActionFeedback: observations.latestActionFeedback(),
                remainingToolCalls: toolLimit - callCount,
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
                progressRecovery:
                  progressRecovery &&
                  progress.state().sequence <= progressRecovery.sequence
                    ? progressRecovery
                    : undefined,
                browserTools: toolSurface,
                automaticObservationCount,
                pageRefresh,
              },
              observations.currentVisual(),
              currentPage,
              observations.currentPage(),
              bound.referenceImages(),
            );
            if (context.bounded)
              observations.deliverCurrentPage(prepared.currentPage!);
            if (observations.rememberCriterionFacts(task.snapshot.criteria))
              await checkpoint();
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
                  evidenceCount: evidence.size,
                  evidenceIndexOmitted: Math.max(0, evidence.size - 200),
                  evidence: [...evidence.values()]
                    .slice(-200)
                    .map(({ externalId, kind }) => ({ externalId, kind })),
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
        let selectedModelAttempt = 1;
        let lastModelError: unknown;
        const orderedCandidates = [
          preferredModel,
          ...modelCandidates.filter(
            (candidate) => candidate !== preferredModel,
          ),
        ];
        let candidateAttempt = 0;
        for (const {
          candidate,
          modelAttempt,
          maxModelAttempts,
        } of this.modelHealth.attempts(orderedCandidates)) {
          signal.throwIfAborted();
          if (schemaRejectedCandidates.has(candidate)) continue;
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
              contextSnapshot: archiveStepContext(
                {
                  ...structuredClone(requestBase),
                  messages: structuredClone(view.messages),
                  model: candidate.modelId,
                },
                view.metrics,
              ),
              modelCallId,
              attemptNumber: task.snapshot.attemptNumber,
              inputPreview: {
                ...modelInputPreview,
                modelAttempt,
                maxModelAttempts,
              },
              model: candidate.modelId,
              provider: "OPENAI_COMPATIBLE",
              segmentId,
              step,
            },
          });
          const modelAbort = abortScope(
            signal,
            deadlinePolicy.maxModelCallSeconds * 1_000,
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
                  timeoutMs: deadlinePolicy.maxModelCallSeconds * 1_000,
                  onRequestAttempt: (attempt) => requestAttempts.push(attempt),
                },
              ),
              modelAbort.signal,
            );
            signal.throwIfAborted();
            if (finalizationDue(task, deadlinePolicy)) {
              return await finalize("FINALIZATION_RESERVE_REACHED");
            }
            if (bound.enabled) {
              const delivery = bound.deliveredRequest(
                view.messages,
                observations.currentVisual(),
              );
              await this.controlPlane.observationOperation(
                lease,
                "deliver",
                { modelRequestId: modelCallId, ...delivery },
                signal,
              );
            }
            selectedModel = candidate;
            this.modelHealth.success(candidate);
            preferredModel = candidate;
            selectedModelCallId = modelCallId;
            selectedModelStartedAt = modelStartedAt;
            selectedAttempts = requestAttempts;
            selectedModelAttempt = modelAttempt;
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
            const schemaRejected = isInvalidModelToolSchema(responseError);
            if (schemaRejected) {
              schemaRejectedCandidates.add(candidate);
              lastModelSchemaError = responseError;
            }
            const candidateHealth =
              reserveReached || schemaRejected
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
                  modelAttempt,
                  maxModelAttempts,
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
              lastModelSchemaError ??
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
              modelAttempt: selectedModelAttempt,
              transport: modelTransport(selectedAttempts),
            },
            model: selectedModel.modelId,
            outputPreview: tracePreview(response.message),
            decisionOutput: redactContext({
              content: response.message.content,
              tool_calls: response.message.tool_calls ?? [],
            }).value,
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
          if (callCount > toolLimit) break;
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
              journal,
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
              remainingToolCalls: toolLimit - callCount + 1,
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
          let stalled = progress.tool({
            name: call.function.name,
            arguments: executionArguments(call.function.arguments),
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
          const exhaustedId = progress.evidenceSubmissionCriterionId;
          if (
            progress.evidenceSubmissionFailed &&
            exhaustedId &&
            task.snapshot.criteria.some((c) => c.id === exhaustedId)
          ) {
            criterionResults.set(exhaustedId, {
              criterionId: exhaustedId,
              status: "INCONCLUSIVE",
              evidenceRefs: [],
              summary: `该标准三次提交仍无法确认有效证据：${progress.evidenceSubmissionError ?? "证据不完整"}。已停止重复纠正，继续独立验收项。`,
            });
            result.recordedCriteria = true;
            result.output = {
              ...(result.output as Record<string, unknown>),
              recordedStatus: "INCONCLUSIVE",
              nextAction:
                "该标准已保留具体错误并记录无法判定；继续其他独立标准。后续取得有效证据仍可更新。",
            };
            stalled = task.snapshot.criteria.every(
              (c) => !c.required || criterionResults.has(c.id),
            );
          }
          const modelOutput =
            observations && call.function.name === "browser_command"
              ? observations.project(result.output, context.bounded)
              : result.output;
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
          if (
            call.function.name === "record_criterion" ||
            call.function.name === "finish_verification" ||
            result.recordedCriteria ||
            result.outcome
          )
            await checkpoint();
          signal.throwIfAborted();
          if (result.locatorRecoveryState !== undefined) {
            locatorRecoveryState = result.locatorRecoveryState;
          }
          if (result.outcome) {
            recoveryPolicy.accountRequestRemainingToolCalls = Math.max(
              0,
              toolLimit - callCount,
            );
            onCheckpoint?.(recoveryPolicy);
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
          if (
            !stalled &&
            !progressRecoveryUsed &&
            progress.state().repeatedSteps >= 4 &&
            !finalizationDue(task, deadlinePolicy)
          ) {
            progressRecoveryUsed = true;
            progressRecovery = {
              sequence: progress.state().sequence,
              guidance:
                "已连续重复操作且没有新进展。先核对 savedCriterionObservations、objectEvidence 和当前页面：已有足够证据的标准直接记录；名称或状态不符应记录实际差异，不能通过重复搜索改变结果。对未观察的区域推进到该区域；选项出现后应按目标选择或进入下一步骤，不要继续交替输入同样关键词。需要跨轮保留时用 record_progress 保存下一步。若前置条件不满足，记录受影响项为 INCONCLUSIVE 并继续独立项。此次纠偏不增加工具预算、不重置停滞计数，也不授权重放提交或修改原有数据。",
            };
            context.compactForRecovery();
            await this.controlPlane.appendEvent(
              lease,
              "executor.stagnation.recovery_requested",
              {
                progress: progress.state(),
                unresolvedCriterionIds: task.snapshot.criteria
                  .filter((c) => !criterionResults.has(c.id))
                  .map((c) => c.id),
              },
            );
          }
          if (
            stalled &&
            !cleanupRecoveryUsed &&
            journal
              .pendingCleanup()
              .some((r) => r.cleanup?.status === "PENDING") &&
            !finalizationDue(task, deadlinePolicy)
          ) {
            cleanupRecoveryUsed = true;
            journal.state.phase = "CLEANUP";
            journal.state.step =
              "验证已因重复操作停止。仅完成 Spec 清理并记录未完成项，不重复原验证动作。";
            progress = new VerificationProgress();
            await checkpoint();
          } else if (stalled)
            return await finalize(
              progress.evidenceSubmissionFailed
                ? "EVIDENCE_SUBMISSION_FAILED"
                : "REPEATED_OPERATIONS",
            );
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

  private async saveJournal(
    lease: ActiveLease,
    journal: ExecutionJournal,
    verificationCheckpoint?: Record<string, unknown>,
  ) {
    return this.controlPlane.appendEvent(lease, "execution.checkpoint", {
      executionState: journal.state,
      ...(verificationCheckpoint ? { verificationCheckpoint } : {}),
    });
  }

  private async browserCommand(
    lease: ActiveLease,
    command: RuntimeActionCommand,
    signal: AbortSignal,
    observations?: BrowserObservations,
  ) {
    try {
      if (
        command.after &&
        (!observations?.bound?.enabled || !observations.viewFeatures.combined)
      ) {
        const { after: _after, ...single } = command;
        command = single;
      }
      if (
        observations?.bound?.enabled &&
        observations.viewFeatures.combined &&
        !READ_COMMANDS.has(command.commandType) &&
        [
          "page.click",
          "page.fill",
          "page.fill_fields",
          "page.select",
          "page.check",
          "page.uncheck",
          "page.type",
          "page.press",
        ].includes(command.commandType)
      )
        command = {
          ...command,
          after: { observe: "ACTIVE_REGION", timeoutMs: 1500 },
        };
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
    journal?: ExecutionJournal;
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

    raw = withoutStepIntent(raw as Record<string, unknown>);

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

    if (input.call.function.name === "observe_subject") {
      const parsed = observeSubjectInputSchema.safeParse(raw);
      if (!parsed.success)
        return correction(
          input.browserCommandCount,
          schemaCorrection(parsed.error),
        );
      const value = parsed.data;
      const contract = input.task.snapshot.criteria.find(
        (c) => c.id === value.criterionId,
      )?.observationContract;
      const target =
        contract?.version === 3
          ? contract.targets.find((t) => t.identity.text === value.subject)
          : undefined;
      if (!target || target.assertions.length !== 1)
        return correction(
          input.browserCommandCount,
          "请选择本标准声明的业务对象；旧版标准继续使用 bind_observation。",
        );
      return this.executeTool({
        ...input,
        call: {
          ...input.call,
          function: {
            name: "bind_observation",
            arguments: JSON.stringify({
              targetId: target.targetId,
              observationId: value.observationId,
              scopeRef: value.scopeRef,
              entityRef: value.identityRef,
              assertionRefs: {
                [target.assertions[0]!.assertionId]: value.stateRef,
              },
            }),
          },
        },
      });
    }

    const boundTools = {
      bind_observation: ["bind", bindObservationInputSchema],
      read_observation_bindings: ["read", readBindingsInputSchema],
      read_evidence_images: ["images", readEvidenceImagesInputSchema],
      record_visual_comparison: ["compare", visualComparisonInputSchema],
    } as const;
    if (
      input.call.function.name in boundTools &&
      input.observations?.bound?.enabled
    ) {
      const [operation, schema] =
        boundTools[input.call.function.name as keyof typeof boundTools];
      const parsed = schema.safeParse(raw);
      if (!parsed.success)
        return correction(
          input.browserCommandCount,
          schemaCorrection(parsed.error),
        );
      try {
        const response = await this.controlPlane
          .observationOperation(
            input.lease,
            operation,
            operation === "bind"
              ? {
                  ...parsed.data,
                  observationId: input.observations.bindingObservationId(
                    (parsed.data as z.infer<typeof bindObservationInputSchema>)
                      .observationId,
                  ),
                }
              : parsed.data,
            input.signal,
          )
          .catch((error) => {
            input.signal.throwIfAborted();
            if (
              operation !== "bind" ||
              !String(error).includes("OBSERVATION_NOT_AVAILABLE")
            )
              throw error;
            const selection = parsed.data as z.infer<
              typeof bindObservationInputSchema
            >;
            return {
              bindings: [],
              coverage: [
                {
                  targetId: selection.targetId,
                  criterionId: input.task.snapshot.criteria.find((c) =>
                    c.observationContract?.targets.some(
                      (t) => t.targetId === selection.targetId,
                    ),
                  )?.id,
                  observationId: input.observations!.bindingObservationId(
                    selection.observationId,
                  ),
                  error: "OBSERVATION_NOT_AVAILABLE",
                },
              ],
            };
          });
        const memory = input.observations.bound;
        memory.ingest(response);
        collectEvidence(response, input.evidence);
        const output =
          operation === "images"
            ? memory.imageResponse(response)
            : operation === "compare"
              ? memory.review(response)
              : operation === "bind"
                ? memory.bindingResult(
                    (parsed.data as z.infer<typeof bindObservationInputSchema>)
                      .targetId,
                    input.observations.bindingStateKey(
                      (
                        parsed.data as z.infer<
                          typeof bindObservationInputSchema
                        >
                      ).observationId,
                    ),
                    response,
                  )
                : response;
        let recordedCriteria = false;
        if (
          operation === "bind" &&
          (output as { code?: string }).code === "OBSERVATION_BINDING_EXHAUSTED"
        ) {
          const targetId = (
            parsed.data as z.infer<typeof bindObservationInputSchema>
          ).targetId;
          for (const criterion of input.task.snapshot.criteria) {
            const target = criterion.observationContract?.targets.find(
              (t) => t.targetId === targetId,
            );
            if (!target || input.criterionResults.has(criterion.id)) continue;
            input.criterionResults.set(criterion.id, {
              criterionId: criterion.id,
              status: "INCONCLUSIVE",
              summary:
                (output as { error: string }).error === "STATE_TYPE_MISMATCH"
                  ? `对象“${target.label}”的 Spec 状态类型与实际开关不一致，无法按此契约判断。需重新生成布尔状态验收，已停止重复取证并继续独立项。`
                  : `对象“${target.label}”在同一页面三次绑定后仍无法形成有效证据：${(output as { error: string }).error}。已停止该对象的重复取证，继续独立验收项。`,
              evidenceRefs: [],
            });
            recordedCriteria = true;
          }
        }
        return {
          browserCommandCount: input.browserCommandCount,
          output,
          recordedCriteria,
        };
      } catch (error) {
        input.signal.throwIfAborted();
        return correction(input.browserCommandCount, String(error));
      }
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
      const citations = (parsed.data.citations ?? []).map((c) =>
        input.observations!.citation(c.ref),
      );
      if (citations.some((c) => !c))
        return correction(
          input.browserCommandCount,
          "进度节点引用已过期或未交付；使用当前页面 ref，或已读取观察的准确原文。",
        );
      parsed.data.observations = [
        ...(parsed.data.observations ?? []),
        ...citations.flatMap((c) =>
          c
            ? [
                {
                  observationId: c.observationId,
                  cursor: c.cursor,
                  quote: c.quote,
                },
              ]
            : [],
        ),
      ];
      if (
        !(parsed.data.observations ?? []).every((item) =>
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
      if (
        (!parsed.data.observations?.length &&
          !parsed.data.bindingIds?.length) ||
        (parsed.data.bindingIds &&
          !input.observations.bound?.hasDelivered(parsed.data.bindingIds))
      )
        return correction(
          input.browserCommandCount,
          "Progress requires delivered quotes or saved bindingIds.",
        );
      let recordUpdates:
        ReturnType<ExecutionJournal["updatePartial"]> | undefined;
      if (input.journal && parsed.data.executionState) {
        const refsByObservation = new Map<string, string[]>();
        for (const q of parsed.data.observations ?? []) {
          const refs = [
            ...input.observations
              .accountRequestEvidence(q.observationId, q.cursor, q.quote)
              .keys(),
          ].filter((ref) => input.evidence.has(ref));
          refsByObservation.set(q.observationId, [
            ...new Set([
              ...(refsByObservation.get(q.observationId) ?? []),
              ...refs,
            ]),
          ]);
        }
        const verifiedRefs = [
          ...new Set([...refsByObservation.values()].flat()),
        ];
        for (const record of parsed.data.executionState.records ?? []) {
          // Resolve historical observation IDs only after validating delivery.
          record.evidenceRefs = [
            ...new Set(
              record.evidenceRefs.length
                ? record.evidenceRefs.flatMap(
                    (ref) => refsByObservation.get(ref) ?? [ref],
                  )
                : verifiedRefs,
            ),
          ].slice(0, 20);
          if (!record.evidenceRefs.length)
            return correction(
              input.browserCommandCount,
              "业务记录缺少可解析的观察证据，请用 citations 引用实际记录节点。",
            );
        }
        const review = parsed.data.executionState.cleanupReview;
        if (
          review &&
          (!review.evidenceRefs.length ||
            review.evidenceRefs.some((ref) => !input.evidence.has(ref)))
        )
          return correction(
            input.browserCommandCount,
            "清理受阻说明必须引用本次执行的实际证据。",
          );
        if (
          parsed.data.executionState.records?.some((r) =>
            r.evidenceRefs.some((id) => !input.evidence.has(id)),
          )
        )
          return correction(
            input.browserCommandCount,
            "业务状态必须引用本次执行已保存的证据。",
          );
        try {
          recordUpdates = input.journal.updatePartial(
            parsed.data.executionState,
          );
        } catch (error) {
          return correction(input.browserCommandCount, String(error));
        }
        await this.saveJournal(input.lease, input.journal);
      }
      return {
        browserCommandCount: input.browserCommandCount,
        output: {
          accepted: !recordUpdates?.some((r) => !r.accepted),
          ...(recordUpdates
            ? {
                recordUpdates,
                executionState: input.journal?.modelView(),
                ...(recordUpdates.some((r) => !r.accepted)
                  ? {
                      error:
                        "部分记录更新失败；有效更新已保存，请仅修正失败记录。",
                    }
                  : {}),
              }
            : {}),
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
        !READ_COMMANDS.has(command.commandType) &&
        input.journal?.state.phase !== "CLEANUP"
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
      if (
        ["page.snapshot", "page.screenshot", "frame.snapshot"].includes(
          command.commandType,
        )
      )
        input.observations?.bound?.clearImages();
      if (
        command.commandType === "page.fill_fields" &&
        input.task.snapshot.executionPolicy.formSequences !== true
      )
        return correction(
          input.browserCommandCount,
          "FORM_SEQUENCE_DISABLED: use the individual field commands for this execution.",
        );
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
        ((!input.observations?.bound?.canUseCurrentImage() &&
          input.observations?.bound?.enabled) ||
          !command.payload.visualObservationId ||
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
        if (input.journal?.observe(result, input.evidence))
          await this.saveJournal(input.lease, input.journal);
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
      const parsed = criterionSubmissionSchema.safeParse(raw);
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
      const resolved = resolveCriterionEvidence(
        parsed.data,
        criterion,
        input.observations,
        input.evidence,
        typeof input.task.snapshot.executionPolicy.accountRevisionStartedAt ===
          "string"
          ? input.task.snapshot.executionPolicy.accountRevisionStartedAt
          : undefined,
      );
      if (resolved.error)
        return correction(input.browserCommandCount, resolved.error);
      const recordedCriterion = resolved.result;
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
      input.criterionResults.set(parsed.data.criterionId, recordedCriterion);
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
      const ownershipError =
        parsed.data.kind === "TEST_ACCOUNT"
          ? input.journal?.accountRequestError(parsed.data.context)
          : null;
      if (ownershipError)
        return correction(input.browserCommandCount, ownershipError);
      if (input.task.snapshot.executionPolicy.accountRequirements) {
        const kindError = accountRequestKindError(
          parsed.data.kind,
          parsed.data.context,
          parsed.data.responseSchema,
        );
        if (kindError) {
          await this.controlPlane.appendEvent(
            input.lease,
            "executor.accounts.request_rejected",
            { code: "ACCOUNT_KIND_INVALID" },
          );
          return correction(input.browserCommandCount, kindError);
        }
      }
      if (
        parsed.data.kind === "TEST_ACCOUNT" &&
        hasProvidedTestAccount(input.task.snapshot.executionPolicy)
      )
        return correction(
          input.browserCommandCount,
          toolCorrection(
            "用户已提供测试账号。不再请求替换账号。既有记录阻止正向测试时，使用 DATA_PRECONDITION 请求浏览器人工接管和具体记录的处置意见；其他不可用情况记录受影响项无法判定。若这是本次已创建的记录，应继续验证与清理；无效账号负向测试仍按产品预期正常判定。",
            {
              code: "COMMAND_NOT_ALLOWED",
              nextAction:
                "既有记录冲突使用 request_human_input(kind=DATA_PRECONDITION)；其他不可用情况记录受影响项无法判定。",
            },
          ),
        );
      const chineseError =
        requireChineseText(parsed.data.prompt, "request_human_input.prompt") ??
        requireChineseText(parsed.data.summary, "request_human_input.summary");
      if (chineseError) {
        return correction(input.browserCommandCount, chineseError);
      }
      let accountSlots: ReturnType<typeof accountInputSlots> = [];
      let accountRequest: unknown;
      let dataContext: ReturnType<typeof prepareDataPrecondition> | undefined;
      if (parsed.data.kind === DATA_PRECONDITION) {
        try {
          dataContext = prepareDataPrecondition(
            parsed.data.context,
            input.task.snapshot.executionPolicy,
            input.journal,
            input.task.snapshot.criteria.map((c) => c.id),
            input.evidence,
            input.observations,
          );
        } catch (error) {
          return correction(input.browserCommandCount, String(error));
        }
      }
      if (parsed.data.kind === "TEST_ACCOUNT") {
        try {
          if (input.task.snapshot.executionPolicy.accountRequirements) {
            const request = businessAccountRequestSchema.parse(
              parsed.data.context.accountRequest,
            );
            const observed =
              request.mode === "DISCOVERED"
                ? input.observations?.accountRequestEvidence(
                    request.observation.observationId,
                    request.observation.cursor,
                    request.observation.quote,
                  )
                : undefined;
            const evidence = new Map(
              [...(observed ?? [])].flatMap(([ref, value]) => {
                const trusted = input.evidence.get(ref);
                return trusted
                  ? [[ref, { ...value, kind: trusted.kind }] as const]
                  : [];
              }),
            );
            const resolved = resolveBusinessAccountRequest(
              input.task.snapshot.executionPolicy,
              request,
              input.task.snapshot.criteria.map((c) => c.id),
              evidence,
            );
            accountSlots = resolved.slots;
            accountRequest = resolved.request;
          } else
            accountSlots = accountInputSlots(
              input.task.snapshot.executionPolicy,
              parsed.data.responseSchema,
              parsed.data.context,
            );
        } catch (error) {
          await this.controlPlane.appendEvent(
            input.lease,
            "executor.accounts.request_rejected",
            { code: "ACCOUNT_REQUEST_INVALID" },
          );
          return correction(input.browserCommandCount, String(error));
        }
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
                    ...(accountRequest ? { accountRequest } : {}),
                    accountSlots,
                    purpose: "BUSINESS_TEST_SUBJECT",
                    usage: (
                      accountRequest
                        ? accountSlots.every(
                            (slot) => slot.usage === "READ_EXISTING",
                          )
                        : parsed.data.context.usage === "READ_EXISTING"
                    )
                      ? "READ_EXISTING"
                      : "CREATE_OR_MODIFY",
                    runId: input.task.snapshot.runId,
                    environment:
                      readTargetUrl(input.task.snapshot.environment) ?? null,
                  }
                : (dataContext ?? parsed.data.context),
            expiresAt: new Date(
              Math.min(
                Date.now() + hitlPolicy.timeoutSeconds * 1_000,
                deadlinePolicy.mode === "FIXED" ||
                  deadlinePolicy.refundHumanWait
                  ? Number.POSITIVE_INFINITY
                  : Date.parse(input.task.snapshot.deadlineAt),
              ),
            ).toISOString(),
            kind: parsed.data.kind,
            prompt: dataContext
              ? `${parsed.data.prompt}\n\n涉及记录：\n${dataContext.records.map((r) => `- 账号 ${r.account} / 类型 ${r.type} / ID ${r.id}`).join("\n")}\n可在浏览器中处理后交还，也可在处置意见中明确授权 Agent 处理上述记录，例如“可以先删除这些记录开展后续测试”。直接交还不代表授权删除。`
              : parsed.data.prompt,
            responseSchema:
              parsed.data.kind === "TEST_ACCOUNT"
                ? accountInputResponseSchema(accountSlots)
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
      // Valid criteria survive another criterion's rejection or pending cleanup.
      let recovery = input.locatorRecoveryState;
      const submittedIds = new Set<string>();
      const rejected: Array<{ criterionId: string; error: unknown }> = [];
      for (const rawCriterion of parsed.data.criteria ?? []) {
        const checked = criterionSubmissionSchema.safeParse(rawCriterion);
        if (!checked.success) {
          rejected.push({
            criterionId: "invalid",
            error: schemaCorrection(checked.error),
          });
          continue;
        }
        const criterion = checked.data;
        if (submittedIds.has(criterion.criterionId)) {
          rejected.push({
            criterionId: criterion.criterionId,
            error: "同一次结束调用不能重复提交相同 criterionId。",
          });
          continue;
        }
        submittedIds.add(criterion.criterionId);
        const recorded = await this.executeTool({
          ...input,
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
          rejected.push({
            criterionId: criterion.criterionId,
            error: recorded.output,
          });
        if (recorded.locatorRecoveryState !== undefined)
          recovery = recorded.locatorRecoveryState;
      }
      if (rejected.length)
        return {
          browserCommandCount: input.browserCommandCount,
          locatorRecoveryState: recovery,
          recordedCriteria: true,
          output: {
            ...(typeof rejected[0]?.error === "object"
              ? rejected[0].error
              : toolCorrection(String(rejected[0]?.error))),
            accepted: false,
            rejected,
            acceptedCriterionIds: [...input.criterionResults.keys()],
          },
        };
      const unresolvedWrites = input.journal?.unreviewedWriteKeys() ?? [];
      if (unresolvedWrites.length) {
        input.journal!.state.phase = "CLEANUP";
        return correction(
          input.browserCommandCount,
          `仍有 ${unresolvedWrites.length} 笔提交未确认记录归属。查询网络回执与当前记录，补充恢复/清理台账；无法安全核对时，在 executionState.cleanupReview 中写 status=BLOCKED、writeKeys、具体原因 note 与 evidenceRefs。不能将空台账当作没有写入。`,
        );
      }
      if (
        input.journal?.state.pendingRecords.length &&
        !input.journal.state.cleanupReview
      )
        return correction(
          input.browserCommandCount,
          "已观察到提交后的记录，但创建回执尚未确认。请只读查询 page.network（includeResponseBodies=true）补齐回执，再核对记录归属与清理；不要重复提交创建。",
        );
      const pendingCleanup =
        input.journal?.state.records.filter(
          (r) => r.cleanup?.status === "PENDING",
        ) ?? [];
      if (pendingCleanup.length) {
        input.journal!.state.phase = "CLEANUP";
        return correction(
          input.browserCommandCount,
          `请先执行 Spec 清理并记录结果：${pendingCleanup.map((r) => `${r.type ?? "记录"} ${r.id}`).join("、")}。无法安全清理时用 record_progress.executionState 将清理标记 BLOCKED，写明原因与待处理动作；不得仅凭删除点击声明完成。`,
        );
      }
      const staged = input.criterionResults;
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
        ...outcomeEvidence(input.task, input.evidence),
        executionDisposition: "EXECUTED",
        kind: "VERIFICATION_COMPLETED",
        ...(input.journal?.cleanupNotice()
          ? {
              cleanup: {
                status: "BLOCKED",
                note: input.journal.cleanupNotice()!.slice(0, 4000),
              },
            }
          : {}),
        summary: [input.journal?.cleanupNotice(), parsed.data.summary]
          .filter(Boolean)
          .join("\n")
          .slice(0, 8000),
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
  | { mode: "FIXED"; maxModelCallSeconds: number }
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
  const maxModelCallSeconds = boundedInteger(
    value.maxModelCallSeconds,
    60,
    900,
    DEFAULT_MODEL_CALL_SECONDS,
  );
  if (value.mode !== "ADAPTIVE") return { mode: "FIXED", maxModelCallSeconds };
  return {
    finalizationReserveSeconds: boundedInteger(
      value.finalizationReserveSeconds,
      15,
      300,
      60,
    ),
    maxModelCallSeconds,
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

/** Artifacts already live in RunEvidence. Inline metadata is only a convenience;
 * criteria resolve against the complete attempt catalog on the control plane. */
function outcomeEvidence(
  task: RuntimeTaskLease,
  evidence: Map<string, RuntimeEvidenceRef>,
) {
  return {
    evidence: evidence.size <= 200 ? [...evidence.values()] : [],
    ...(task.snapshot.executionPolicy.evidenceCatalog === true
      ? {
          evidenceCatalog: {
            version: 1 as const,
            runId: task.snapshot.runId,
            attemptId: task.snapshot.attemptId,
          },
        }
      : {}),
  };
}

function finalizationOutcome(input: {
  browserCommandCount: number;
  criterionResults: Map<string, z.infer<typeof recordCriterionInputSchema>>;
  evidence: Map<string, RuntimeEvidenceRef>;
  task: RuntimeTaskLease;
  reason: FinalizationReason;
  detail?: string | undefined;
}): RuntimeOutcome {
  const reason = [
    {
      FINALIZATION_RESERVE_REACHED:
        "已进入截止前收尾窗口，剩余执行时间不足以继续验证。",
      EVIDENCE_SUBMISSION_FAILED:
        "同一验收标准的证据提交在两次纠正后仍未通过校验，已停止重复提交。请查看证据引用及缺失类型。",
      REPEATED_OPERATIONS:
        "重复操作持续未产生新的页面观察或验收进展，已停止自动执行。",
      TEXT_ONLY_LOOP:
        "模型连续四轮只返回文本，未调用工具继续验证，已停止自动执行。",
      TOOL_LIMIT_REACHED: "工具调用预算已用尽，已停止继续操作并保留验收结果。",
      LOCATOR_RECOVERY_EXHAUSTED:
        "定位恢复的两次重新定位均未成功，已停止自动执行并保留验收结果。",
    }[input.reason],
    input.detail,
  ]
    .filter(Boolean)
    .join("\n");
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
    ...outcomeEvidence(input.task, input.evidence),
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
  boundEvidence = false,
  businessChecks = false,
  legacyContracts = true,
) {
  return [
    ...(boundEvidence
      ? [
          {
            name: "observe_subject",
            schema: observeSubjectInputSchema,
            description:
              "保存 businessCheck 对象的状态。填写本标准的 subject、同一观察中的最小行/表单/弹窗 scopeRef、实际对象 identityRef 与状态 stateRef。系统读取真实值、校验关系和时机，不能提交自拟实际值。结果进入 objectEvidence；读取结果后即可 record_criterion，不必搬运 bindingIds。",
          },
          {
            name: "bind_observation",
            schema: bindObservationInputSchema,
            description:
              "Resolve an ambiguous observation by selecting observed scope/entity/assertion refs from one capture. observationId accepts the current page's observationId or its captureId; the executor resolves cached IDs. entityRef must identify the actual form control, not its display span or wrapper. API verifies relationships and reads actual values; do not supply invented state.",
          },
          {
            name: "read_observation_bindings",
            schema: readBindingsInputSchema,
            description:
              "Read persisted object facts by bindingIds or returned continuationToken. Historical facts are evidence, not current refs.",
          },
          {
            name: "read_evidence_images",
            schema: readEvidenceImagesInputSchema,
            description:
              "Read at most two saved object screenshots for required visual comparison. They are attached to the next model request; never use them for coordinate actions.",
          },
          {
            name: "record_visual_comparison",
            schema: visualComparisonInputSchema,
            description:
              "After seeing both reference images, record the declared comparison dimensions, subject/reference bindingIds in that order, and the deliveryId returned by read_evidence_images.",
          },
        ]
          .filter(
            (t) =>
              (t.name !== "observe_subject" || businessChecks) &&
              (t.name !== "bind_observation" || legacyContracts),
          )
          .map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: openAiFunctionSchema(t.schema),
            strict: false,
          }))
      : []),
    {
      type: "function",
      name: "browser_command",
      description:
        "执行一次浏览器操作。使用 page.snapshot 观察当前页并复用返回的 ref；判断验收标准前要采集持久化证据。若返回 LOCATOR_AMBIGUOUS，必须在后续重新定位操作中原样带回 locatorRecoveryToken，并使用自动附带的 recovery snapshot 选择唯一目标；不能原样重试 selector 或用 first/nth 猜测，也不能据此判定产品失败。SPA 跳转优先等待特定 selector 或文本，不要优先使用 networkidle。NETWORK 证据需要请求参数或响应数据时，调用 page.network，并设置 includeResponseBodies 和尽可能精确的 urlIncludes。",
      parameters: catalog.parameters(),
      strict: false,
    },
    ...catalog.discoveryTools(),
    {
      type: "function",
      name: "record_criterion",
      description:
        "仅根据实际观察到的浏览器证据，用简体中文记录一条已声明验收标准的结果。页面通过 citations 的 target 和当前 ref 引用节点；请求体字段、JSON 配置和查询参数通过 networkCitations 的 target、observationId、cursor、requestIndex 引用 page.network 已读取的完整请求，requestIndex 从 0 开始。系统绑定真实原文与证据，按字段集合和 JSON 值核对网络目标，无需拼接字段名或改写 JSON。summary 用一句话说明实际操作和结果。PASSED/FAILED 不能引用操作后自动截图；须等待业务结果稳定后主动观察。局部列表未看到目标不能证明不存在。",
      parameters: openAiFunctionSchema(criterionSubmissionSchema),
      strict: false,
    },
    ...(boundedContext
      ? [
          {
            type: "function",
            name: "record_progress",
            description:
              "保存跨轮进度：优先用 citations:[{ref:当前节点}]，系统生成原文和证据引用；也可用 observations 引用已读原文。executionState 只提交本次变化的 phase、step、records 或 cleanupReview，遗漏的记录会保留；更新已有记录优先只传 recordRef 和变更字段，身份与归属由系统继承；逐条返回接受或拒绝结果。账号、回执和归属由系统维护；records[].evidenceRefs 可省略，由本次 citations/observations 解析，不能手写 artifact ID。不能分配或更换测试账号；尚未提供时用 TEST_ACCOUNT，既有记录前置冲突用 DATA_PRECONDITION。仅在阶段转换或需要保留关键观察时使用，不要每次阅读都调用。不能替代 record_criterion，不能让旧 ref 重新有效。",
            parameters: openAiFunctionSchema(
              recordProgressInputSchema.extend({
                executionState: executionProgressSchema
                  .extend({
                    records:
                      recordProgressInputSchema.shape.executionState.unwrap()
                        .shape.records,
                  })
                  .optional(),
              }),
            ),
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
              "需要登录、审批或处置数据前置冲突时暂停并保留浏览器。已有账号的记录冲突用 kind=DATA_PRECONDITION，context={criterionIds,records:[{id?,account,type,citations:[{ref}]}]}，用当前节点 ref 或 observations:[{observationId,cursor,quote}] 自动关联证据，也兼容 evidenceRefs；允许附带截图。没有记录 ID 时省略 id，先请人定位，不能编造；用户可亲自处理或填写处置意见。不得把请求本身视为删除授权。提示和摘要使用简体中文。",
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
      parameters: openAiFunctionSchema(
        finishInputSchema.extend({
          criteria: z.array(criterionSubmissionSchema).max(100).optional(),
        }),
      ),
      strict: false,
    },
  ].map(({ type: _type, ...definition }) => ({
    type: "function" as const,
    function: {
      ...definition,
      parameters: withStepIntent(definition.parameters),
    },
  }));
}

function taskPrompt(task: RuntimeTaskLease, targetUrl?: string) {
  return JSON.stringify({
    acceptanceCriteria: task.snapshot.criteria.map((c) => {
      const criterion = browserExecutionCriterion(c);
      const { observationContract: contract, ...rest } = criterion;
      if (contract?.version !== 3) return criterion;
      return {
        ...rest,
        businessChecks: contract.targets.map((t) => ({
          subject: t.identity.text,
          when: t.phase,
          states: t.assertions.map((a) => ({
            label: a.label,
            ...(a.property ? { property: a.property } : {}),
            ...(a.expected === undefined
              ? { captureOnly: true }
              : { equals: a.expected }),
          })),
        })),
        comparisons: contract.comparisons.map((c) => ({
          comparisonId: c.comparisonId,
          subject: contract.targets.find(
            (t) => t.targetId === c.subjectTargetId,
          )!.identity.text,
          reference: contract.targets.find(
            (t) => t.targetId === c.referenceTargetId,
          )!.identity.text,
          dimensions: c.dimensions,
        })),
      };
    }),
    goal: task.snapshot.goal,
    humanResume: readHumanResume(task.snapshot.executionPolicy),
    humanResolutions: task.snapshot.executionPolicy.humanResolutions ?? [],
    accountRequirements:
      task.snapshot.executionPolicy.accountRequirements ?? null,
    accountRequestCorrection:
      task.snapshot.executionPolicy.accountRequestCorrection ?? null,
    executionContext: {
      authRole: task.snapshot.environment.authRole ?? "default",
      caseIsolation: "INDEPENDENT",
      prerequisiteStatus: "UNVERIFIED_UNTIL_OBSERVED_IN_THIS_CASE",
      guidance:
        "前置条件是待核查要求，不是完成证明。其他 Case 的结果未交付到本执行段；旧任务写有已完成其他 Case 或已了解参照路径时，先在本 Case 独立只读核验。当前账号以 executionState.accounts（或 account）为准，人工换号已同步到此状态；goal、旧观察和历史人工回复中的旧账号仅供追溯与清理，不得切回。写入账号仅使用明确提供的测试账号或 TEST_ACCOUNT 答复；旧 Spec 的列表账号复用建议不授权写入。",
    },
    languageRequirement:
      "所有用户可见的分析、验收标准结果、人工接管提示和最终摘要必须使用简体中文。验收结果用一句话说明实际观察和结论，不重复内部枚举、引用地址与标准全文。",
    targetUrl: targetUrl ?? null,
  });
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
每次工具调用必须在顶层 stepIntent 字段用简体中文说明这次准备执行的动作和要确认的目标。只写简短行动计划，不写内部推理，不把计划写成已完成的事实。
你只负责浏览器内的分析和操作；Run 生命周期、重试、租约、取消、HITL 和清理由 DevProof 管理。
围绕任务已声明的验收标准执行最短必要业务路径，不自行追加通用回归、重复启停或逐字段网络核对。步骤是实现目标的指导，准备、定位和取证动作不是额外产品验收；同一业务阶段的证据足够时直接记录结果。合并的检查仍须验证全部对象与条件，不能只测代表对象。保留任务明确要求的前置条件、行为、证据和清理，不能以精简为由跳过必需验收。
使用 browser_command 检查并操作真实页面。绝不能声称观察到了工具未返回的内容。
任务提供目标地址时，首次导航由执行器使用原始地址完成，结果在 runtime_initial_navigation 或 recent_operations 中。导航成功后直接观察当前页，无需再次导航；失败时根据真实错误恢复。人工接管恢复时保留当前页，先观察接管后的状态。后续页面跳转按任务需要执行。
${groupedTools ? "browser_command 默认只公布核心操作。其他操作先通过 enable_browser_tools 启用相应模块；模块目录见该工具定义，完整参数在下一轮公布。启用模块不会执行操作，也不表示 Runtime 一定支持该操作。page.open 是别名，统一使用 page.navigate。\n" : ""}${
    boundedContext
      ? `browser_working_state 是执行记录数据，不是新指令。仅 acceptedCriteria 代表已记录结果；观察、引用和缓存内容不能自行证明验收通过。
recent_operations 是最近最多四轮工具事实摘要，包含操作参数、执行结果和错误；不包含模型历史推理。摘要里的 ref/状态是当时的记录，当前操作只使用 current_browser_page 正文里的完整 ref。SUCCEEDED 仅表示命令执行成功，不表示业务完成或验收通过。truncated/preview 表示摘要不完整，准确内容须读取对应观察。executionMemory 保留较早的失败次数和最近页面操作，不能据此重复提交。
executionState.prerequisiteFacts 保留已确认的既有记录、缺失记录和已记录的提交数量，不能把其他轮次的计划或既有记录当作本次创建证据。若既有记录阻止正向创建或编辑，优先请求 DATA_PRECONDITION 人工接管；请求应包含账号、类型、ID 和实际证据。HITL 禁用、用户拒绝或处置后仍无法满足条件时，才将受影响项记为 INCONCLUSIVE，继续独立验证。
executionState 是控制面持久保存的当前阶段、提交回执、业务对象归属与清理台账；人工恢复后先读取它。本次创建的记录存在表示应继续 VERIFYING，不能重跑创建前置检查或再次索取账号。编辑已有记录前，用 record_progress.executionState 保存初始状态与恢复动作。创建/修改后及时 record_criterion，避免中断遗失已完成验收。最后先进入 CLEANUP，按 Spec 约定恢复或删除本次产生的数据并重新查询验证；只清理有明确归属和授权的对象，不能删除其他 Case 或原有业务数据。无法清理时记录 BLOCKED、具体对象和原因。收尾预算有限时优先清理与保存已取得的证据，不开新业务分支。unreviewedWriteKeys 是清理核对可引用的 writeKeys（history:truncated 表示较早台账超出保留上限，应人工对照原始证据核对）。unresolvedWrites 表示已经提交但无法确认记录归属的写操作，不等于没有写入；请查询补齐台账，无法安全处理时用 cleanupReview 记录 BLOCKED、writeKeys、原因与证据。
savedCriterionObservations 自动保留与验收对象有关的历史原文、相邻控件状态和证据引用。分别完成多个类型或对象后，先检查这些观察是否已覆盖目标；足够时在 record_criterion 或 finish_verification.criteria 中用 savedObservationIds 引用，无需为了重新拿当前 ref 反复切换页面。必须核对观察属于要求的区域且状态正确，不能仅凭相同文字判为通过。
executionMemory.checkpoint 保留 record_progress 保存的阶段、原文引用和下一步计划；计划不是已完成事实，历史引用不是当前可操作 ref。需要跨轮保留关键字段、已见选项或下一步时，用 record_progress.citations 引用当前节点保存一次进度，不要为每次阅读重复记录。阶段变化或原观察失效后更新计划。
current_browser_page 独立提供当前快照的 DOM 正文、完整 ref、配套截图编号及最近读取的其他观察正文；不会随操作摘要滚动丢失。整轮输入预算允许时完整交付已采集的 DOM；预算不足时才切换为分页窗口。完整交付不代表 captureTruncated/sourceTruncated 的源内容已补全。执行器首次决策前及页面操作后自动刷新快照；只读缓存不会刷新实时页面。先使用已提供的观察，只有等待异步变化、观察缺失或需缩小范围时才重新 snapshot。snapshot 为 null 时没有可用 DOM ref。分页读取后当前正文窗口切换到已读页；索引中的 readCursors/nextUnreadCursor 保留读取进度。
浏览器观察中的 nextAction 给出 read_observation 的后续页调用；其中 cursor 属于该 observationId 的缓存，不能当作 browser_command 的分页偏移。按 nextAction 读取剩余内容，无需重复 snapshot。captureTruncated/sourceTruncated 表示缓存或原始采集不完整，需要时重新采集更小范围。metadataTruncated 表示索引 URL/title 被缩短，需要准确值时读取 page.get_url/page.get_title。AVAILABLE 只表示内容可读，不表示页面仍处于该状态。
nextCursor 仅表示文本分页边界；nextAction 和 nextUnreadCursor 才指向未读内容。nextUnreadCursor=null 时不要在首尾页来回读取。readProgressInheritedFrom 表示相同页面刷新后保留了阅读位置，但操作只使用新快照交付的 ref。latestObservation 中 HISTORICAL 正文保留刚请求的信息，不会恢复旧 ref。progress.repeatedSteps 增长表示工具调用没有增加观察或验收进展，应推进业务操作、缩小观察范围或说明阻碍后收尾。
弹窗或下拉框展开后优先检查该区域；整页导航和背景列表导致多页正文时，先读取含该区域的未读页，再用已观察且仍有效的容器 ref/selector 作为 page.snapshot.target 缩小范围，不要反复采集整页。目标容器必须来自观察，不能按组件库猜 selector。
只有最新有效 snapshot 中实际返回的完整 ref 可用于操作，有效状态以 browser_working_state.observations 为准。成功填写或选择表单字段后可复用仍为 CURRENT 的 ref；导航、其他页面修改或接管后重新观察。历史缓存不会恢复旧 ref 的有效性，缓存读取不应代替等待实时页面变化。
`
      : ""
  }观察到足够证据后，直接用 finish_verification 的 criteria 提交各条验收结果、准确证据引用和最终结论；无需为收尾重新导航或重复采集已足够的证据。每完成创建、修改或查询等业务阶段，就用 record_criterion 保存已有充分证据的标准；不要等全部步骤和清理结束才记录结果。同一条标准可以更新。证据引用必须来自实际工具输出。
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
验收证据必须对应标准里的具体页面区域、控件和业务对象。记录 PASSED 时，优先使用 citations: [{target: observationTargets 中的 label, ref: 当前快照已交付的完整 ref}]。执行器会提取该节点的连续原文并绑定同次观察的 DOM 与截图，无需手抄 observationId、cursor、quote 或 artifact UUID。节点必须属于标准要求的实际区域和状态，匹配文字本身不代表验收通过。旧接口也可使用 observations，但必须逐个覆盖 observationTargets：在 observations 中提供对应 target（label）、observationId、cursor 和逐字 quote，quote 必须包含该对象的 expectedText 或 alternatives 中任一等价文本，且来自已交付观察。同一对象的文本是任选其一，不同 target 则必须全部覆盖。仅看见下拉候选列表不证明选择后表单已经切换，必须引用实际选中状态及对应表单；多个对象不能只验证其中一个。创建弹窗的类型选项不证明列表筛选选项，更不证明筛选隔离；列表标准须在列表筛选器操作后，只读核对结果集合及所选类型。来源摘录、探索步骤或自拟测试标识不是实际页面证据。若旧 Spec 假设了未获来源支持的字段（例如备注），不得因为该字段不存在而判产品 FAILED；记录 INCONCLUSIVE 并说明 Spec 与来源不一致。
executionState.accounts 提供用户填写并按角色分配的账号，slotId 对应 Spec 中的账号角色（role:序号）。同环境同账号同类型的并发写操作由平台排队串行；历史使用不禁止账号复用。按 usage、requiredTypes 和业务约束使用，禁止把账号 A/B、角色名称当作真实账号。开始时先只读核对各角色的账号存在性和业务前置条件；账号已存在目标记录或需要授权修改既有记录时，使用 DATA_PRECONDITION 请求人工处置并保留浏览器，不使用 TEST_ACCOUNT 重复索取账号。账号不存在或不可用且没有可处置记录时，引用实际错误记录受影响项无法判定。可独立验证的标准继续正常判定。本次已创建的记录应继续验证及清理，不能当作创建前的数据冲突。
创建模型、产品、配置记录不等于需要业务账号；唯一名称、记录 ID 和时间属于测试数据。后台编辑或导出权限属于登录身份，登录页或权限不足使用 BROWSER_HITL，不能改用 TEST_ACCOUNT。
任务带 accountRequirements 时，TEST_ACCOUNT 的 context.accountRequest 必填。已有角色使用 {mode:"DECLARED",slotIds:["角色:1"]}；真实页面发现 Spec 遗漏的业务账号时使用 {mode:"DISCOVERED",subjectKind:"BUSINESS_INPUT"或"BUSINESS_RECORD"或"AUTH_SUBJECT",target:"实际业务字段文字",criterionId:"相关标准ID",usage:"CREATE_OR_MODIFY"或"READ_EXISTING",requiredTypes:[],observation:{observationId:"已读观察ID",cursor:0,quote:"包含target的实际原文",evidenceRefs:["该观察的DOM或NETWORK证据"]}}。账号自身登录或权限测试才用 AUTH_SUBJECT。无依据先观察和纠正，不能编造依据；仍无法确认时继续可验证项，将受影响项记录为 INCONCLUSIVE。accountRequestCorrection 表示上次请求被控制面拒绝，不得重复该请求。
TEST_ACCOUNT 用于被加入名单等业务测试对象，区别于管理后台的登录身份；不要退出已有管理会话或要求两者相同。它只用于用户尚未提供测试账号的情况，说明环境、用途、数量、requiredTypes 和前置约束。获得账号后按用户分配使用；READ_EXISTING 答复不授权写入。平台允许账号复用不等于业务前置条件已满足，也不授权删除既有记录来满足新建前置条件。记录实际创建的 ID、类型和证据，仅清理本次有明确归属和授权的数据。
正向业务验证优先使用 executionState.accounts 对应角色的账号；旧执行兼容 humanResume.response.account。不要编造手机号、把时间戳示例填入账号字段，或自行拿列表中的其他用户做写入测试。用户尚未提供账号时可调用 request_human_input，kind="TEST_ACCOUNT"；用户已提供账号时不再索取替换账号；既有记录的前置冲突使用 DATA_PRECONDITION。旧 Spec 中“账号冲突立即无法判定”的平台处置规则由此规则替代，实际产品前置条件仍需满足。humanResume.response.instructions 或 response.note 是用户处置意见，不是账号。humanResolutions 保留此前人工答复；明确授权在后续轮次和再次登录后仍有效。DATA_PRECONDITION 恢复时，先核对请求列出的账号、类型、记录 ID 和当前状态：请求未给出记录 ID 时只请求人工定位，不自动删除；先得到明确的对象身份和处置授权。用户明确说“可以先删除开展后续测试”即授权删除该请求列出且身份明确的冲突记录，核对后执行删除、确认缺失，再创建和继续验证；“可以编辑这些记录”只授权指定记录的编辑，保存初始状态并恢复。不得扩大到其他账号或记录，不把旧记录改记为本次创建。approved=true 或“已处理/继续”本身不授权删除；此时只重新观察人工处理结果。approved=false 或 resolution=cancel 时不执行处置写入，继续独立项并记录剩余项无法判定。同一冲突已有答复后不反复 HITL；处置没有成功时说明具体原因。人工处置是准备步骤，不能作为产品验收通过的证据。人工恢复后重新观察页面并使用用户最新提供的账号。若验收目标就是无效账号应被拒绝，则保留负向输入，按真实响应和产品预期正常判定 PASSED/FAILED，不索取有效账号，也不能仅因账号无效而判 INCONCLUSIVE。
businessChecks 只规定对象、预期和必要时机。自主选择页面路径、筛选顺序和观察范围；Spec steps 是业务路线建议，来源明确的因果先后、默认值、保存后/重开等时机仍必须满足。用 observe_subject 分别保存各对象；选择实际选中控件或记录中的身份单元格，不能选择下拉选项或搜索输入来证明记录身份。两个对象同为“启用”仍须分别取证。系统从真实节点读取状态，拒绝跨行引用。objectEvidence 中事实已交付且完整后，record_criterion/finish_verification 自动引用本标准的已读事实与视觉评审，可省略 bindingIds/comparisonReviewIds；缺失、冲突、未读事实仍不允许通过。对象事实只证明该记录或表单状态，账号、筛选隔离、操作回执仍按业务要求独立核对。
对于旧版 observationContract.version=2，objectEvidence 覆盖表按区域、对象和阶段保存实际状态。使用 bindingIds 引用事实；视觉要求须 read_evidence_images 后 record_visual_comparison，再引用 comparisonReviewIds。READY 不等于 PASSED：核对 evaluation、缺失项和反例。手动修改后的值不能证明默认状态。三类目标齐全后进入比较与提交，不重复选择已验证的对象。ACTIVE_REGION 合并观察只有通过 API 绑定和完整性校验的事实可以验收；历史图片不能用于坐标点击。SCOPE_NOT_OBSERVED 表示尚未进入或观察到所需区域，不是同名节点歧义。下拉选项存在不等于已选中；完成选项检查后继续下一业务步骤。名称不同须记录实际文案，并依据来源判断，不能自行扩充等价名称来让验收通过。
progressRecovery 出现时，执行器已发现连续重复操作。按其中 guidance 核对已有事实、保存可验收结果并调整下一步；不得继续交替输入相同关键词或重读同一旧观察。纠偏只有一次，不增加预算，不授权重新提交业务写入。

result.actionFeedback 是浏览器采集的操作反馈，不是产品结论。inputCompleted 只代表操作完成；requests 是本次观察窗口内发起的候选请求，temporal 关联不证明因果。检查响应中的业务错误，即使 HTTP 200 也不能直接判成功。pending 或 coverageIncomplete 时继续只读观察，不重复提交；同一输入出现明确拒绝时先纠正数据或请求 HITL。latestActionFeedback 保留最近反馈，不能用它替代最新页面。
保存后出现错误、弹窗不关闭或结果未更新时，先启用 diagnostics，读取 page.network（精确 urlIncludes、includeResponseBodies=true）及 page.console/page.errors。旧 Runtime 缺少 actionFeedback 时也必须走这条只读诊断路径；重复点击同一保存不能代替诊断。already exists 等唯一性拒绝要结合创建前检查、本次写入回执和记录归属核对；若是用户提供账号的前置数据问题，记录 INCONCLUSIVE 并说明原因，不循环换号或直接判产品失败。
remainingToolCalls 不足 3 次时进入收尾，不发起新的提交；优先核对最近操作并提交已完成标准，剩余标准记录 INCONCLUSIVE。范围标签 fN 不是元素 ref，不要将它当作 frame.snapshot 的引用；恢复过的无效方法不要重复尝试。
timeBudget.remainingExecutionSeconds 是扣除收尾预留后的剩余秒数，与 remainingToolCalls 独立；工具次数多不代表时间充足。剩余执行时间不足 60 秒时优先只读确认已有操作并提交部分结论，不再启动新的业务写入。每次模型失败后的 fallback 可能收到刷新的页面，仍需使用本次输入中的 ref。
只有无法自主继续时才能调用 request_human_input。至少执行一次浏览器操作并提供所有必需验收标准后，才能完成验证。
所有用户可见的生成内容必须使用简体中文，包括验收标准摘要、HITL 提示、等待摘要和最终验证摘要。标识符、URL、代码符号、API 路径、工具名、枚举值和 evidence reference 保持原样，不要翻译。
绝不能调用会话生命周期操作，也绝不能泄露凭据。`;
}
