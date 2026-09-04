import { createHash } from "node:crypto";
import { summarizeCaseScheduling } from "./task-scheduling.js";
export * from "./task-scheduling.js";

import type {
  ExecutionDisposition,
  ProductVerdict,
  RunLifecycle,
  RuntimeFailureClass,
  RuntimeOutcome,
} from "@devproof/agent-runtime-protocol";

export type AttemptStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING_HUMAN"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export type RuntimeTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING_HUMAN"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export interface RetryPolicy {
  maxAttempts: number;
  retryOn: RuntimeFailureClass[];
}

export interface OutcomeProjection {
  attemptStatus: AttemptStatus;
  executionDisposition: ExecutionDisposition | null;
  lifecycle: RunLifecycle;
  nextAttemptScheduled: boolean;
  taskStatus: RuntimeTaskStatus;
  verdict: ProductVerdict | null;
}

export function effectiveRetryPolicy(input: {
  browserAvailabilityPolicy?: "WAIT" | "FAIL_FAST";
  outcome: RuntimeOutcome;
  retryPolicy: RetryPolicy;
}): RetryPolicy {
  if (
    input.browserAvailabilityPolicy === "FAIL_FAST" &&
    (input.outcome.kind === "RETRYABLE_FAILURE" ||
      input.outcome.kind === "FATAL_FAILURE") &&
    input.outcome.error.failureClass === "BROWSER_RUNTIME"
  ) {
    return {
      ...input.retryPolicy,
      retryOn: input.retryPolicy.retryOn.filter(
        (failureClass) => failureClass !== "BROWSER_RUNTIME",
      ),
    };
  }
  return input.retryPolicy;
}

export function projectRuntimeOutcome(input: {
  attemptNumber: number;
  outcome: RuntimeOutcome;
  retryPolicy: RetryPolicy;
}): OutcomeProjection {
  const { attemptNumber, outcome, retryPolicy } = input;

  if (outcome.kind === "VERIFICATION_COMPLETED") {
    return {
      attemptStatus: "SUCCEEDED",
      executionDisposition: "EXECUTED",
      lifecycle: "COMPLETED",
      nextAttemptScheduled: false,
      taskStatus: "SUCCEEDED",
      verdict: outcome.verdict,
    };
  }

  if (outcome.kind === "WAITING_HUMAN") {
    return {
      attemptStatus: "WAITING_HUMAN",
      executionDisposition: "BLOCKED",
      lifecycle: "WAITING_HUMAN",
      nextAttemptScheduled: false,
      taskStatus: "WAITING_HUMAN",
      verdict: null,
    };
  }

  const shouldRetry =
    outcome.kind === "RETRYABLE_FAILURE" &&
    attemptNumber < retryPolicy.maxAttempts &&
    retryPolicy.retryOn.includes(outcome.error.failureClass);

  return {
    attemptStatus:
      outcome.error.failureClass === "TIMEOUT" ? "TIMED_OUT" : "FAILED",
    executionDisposition: shouldRetry ? null : outcome.executionDisposition,
    lifecycle: shouldRetry
      ? "QUEUED"
      : outcome.error.failureClass === "TIMEOUT"
        ? "TIMED_OUT"
        : "COMPLETED",
    nextAttemptScheduled: shouldRetry,
    taskStatus:
      outcome.error.failureClass === "TIMEOUT" ? "TIMED_OUT" : "FAILED",
    verdict: null,
  };
}

export const TERMINAL_RUN_LIFECYCLES = new Set<RunLifecycle>([
  "COMPLETED",
  "CANCELLED",
  "TIMED_OUT",
]);

export const SPECIFICATION_GENERATOR = {
  kind: "DETERMINISTIC",
  version: "issue-spec-v1",
} as const;

export type TaskStageProjectionStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING_INPUT"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "SKIPPED";

export interface TaskExecutionProjectionInput {
  analysisStatus: TaskStageProjectionStatus;
  cancelRequested: boolean;
  caseExecutions: Array<{
    dispatchAttempts: number;
    dispatchMaxAttempts: number;
    scheduling?: unknown;
    dispatchStatus:
      "PENDING" | "DISPATCHING" | "LINKED" | "FAILED" | "CANCELLED";
    run: {
      executionDisposition: ExecutionDisposition | null;
      lifecycle: RunLifecycle;
      verdict: ProductVerdict | null;
    } | null;
  }>;
  executionStatus: TaskStageProjectionStatus;
  targetAvailable: boolean;
  timedOut?: boolean;
}

export interface TaskExecutionProjection {
  currentStage: "SPEC_ANALYSIS" | "SPEC_EXECUTION";
  executionDisposition: ExecutionDisposition | null;
  executionStageStatus: TaskStageProjectionStatus;
  lifecycle:
    | "QUEUED"
    | "RUNNING"
    | "WAITING_INPUT"
    | "WAITING_HUMAN"
    | "COMPLETED"
    | "CANCELLED"
    | "TIMED_OUT";
  verdict: ProductVerdict | null;
  waitingReason: string | null;
}

/** Projects one user-visible task from its durable stages and child runs. */
export function projectTaskExecution(
  input: TaskExecutionProjectionInput,
): TaskExecutionProjection {
  if (input.cancelRequested) {
    return taskProjection(
      "SPEC_EXECUTION",
      "CANCELLED",
      "CANCELLED",
      null,
      null,
    );
  }
  if (input.timedOut) {
    return taskProjection("SPEC_EXECUTION", "TIMED_OUT", "FAILED", null, null);
  }
  if (input.analysisStatus === "PENDING") {
    return taskProjection(
      "SPEC_ANALYSIS",
      "QUEUED",
      input.executionStatus,
      null,
      null,
    );
  }
  if (input.analysisStatus === "RUNNING") {
    return taskProjection(
      "SPEC_ANALYSIS",
      "RUNNING",
      input.executionStatus,
      null,
      null,
    );
  }
  if (input.analysisStatus === "FAILED") {
    return taskProjection(
      "SPEC_ANALYSIS",
      "COMPLETED",
      input.executionStatus,
      "NOT_RUN",
      null,
    );
  }
  if (input.analysisStatus === "CANCELLED") {
    return taskProjection(
      "SPEC_ANALYSIS",
      "CANCELLED",
      "CANCELLED",
      null,
      null,
    );
  }
  if (!input.targetAvailable || input.executionStatus === "WAITING_INPUT") {
    return {
      ...taskProjection(
        "SPEC_EXECUTION",
        "WAITING_INPUT",
        "WAITING_INPUT",
        null,
        null,
      ),
      waitingReason: "DEPLOYMENT_TARGET_REQUIRED",
    };
  }

  const caseExecutions = input.caseExecutions;
  const runs = caseExecutions.flatMap((item) =>
    item.dispatchStatus === "LINKED" && item.run ? [item.run] : [],
  );
  if (runs.some((run) => run.lifecycle === "WAITING_HUMAN")) {
    return taskProjection(
      "SPEC_EXECUTION",
      "WAITING_HUMAN",
      "RUNNING",
      null,
      null,
    );
  }
  const dispatchActive = caseExecutions.some(
    (item) =>
      ["PENDING", "DISPATCHING"].includes(item.dispatchStatus) ||
      (item.dispatchStatus === "FAILED" &&
        item.dispatchAttempts < item.dispatchMaxAttempts),
  );
  const runsActive = runs.some(
    (run) => !TERMINAL_RUN_LIFECYCLES.has(run.lifecycle),
  );
  if (!caseExecutions.length || dispatchActive || runsActive) {
    const scheduling = summarizeCaseScheduling(caseExecutions);
    return {
      ...taskProjection("SPEC_EXECUTION", "RUNNING", "RUNNING", null, null),
      waitingReason: scheduling.reason,
    };
  }

  const fullyLinked = caseExecutions.every(
    (item) => item.dispatchStatus === "LINKED" && item.run,
  );
  const fullyExecuted =
    fullyLinked &&
    runs.length === caseExecutions.length &&
    runs.every((run) => run.executionDisposition === "EXECUTED");
  if (!fullyExecuted) {
    return taskProjection(
      "SPEC_EXECUTION",
      "COMPLETED",
      "FAILED",
      runs.length ? "BLOCKED" : "NOT_RUN",
      null,
    );
  }

  const verdict = runs.some((run) => run.verdict === "FAILED")
    ? "FAILED"
    : runs.some((run) => run.verdict === "INCONCLUSIVE" || run.verdict === null)
      ? "INCONCLUSIVE"
      : "PASSED";
  return taskProjection(
    "SPEC_EXECUTION",
    "COMPLETED",
    "SUCCEEDED",
    "EXECUTED",
    verdict,
  );
}

function taskProjection(
  currentStage: TaskExecutionProjection["currentStage"],
  lifecycle: TaskExecutionProjection["lifecycle"],
  executionStageStatus: TaskStageProjectionStatus,
  executionDisposition: ExecutionDisposition | null,
  verdict: ProductVerdict | null,
): TaskExecutionProjection {
  return {
    currentStage,
    executionDisposition,
    executionStageStatus,
    lifecycle,
    verdict,
    waitingReason: null,
  };
}

export interface SpecificationGenerationContext {
  issue: {
    description: string;
    id: string;
    identifier: string;
    labels: string[];
    priority: number | null;
    state: string;
    title: string;
    url: string;
  };
  knowledge: Array<{
    content: string;
    id: string;
    title: string;
    updatedAt: string | null;
    url: string | null;
  }>;
  pullRequests: Array<{
    body: string;
    changedFiles: string[];
    deploymentUrl: string | null;
    isPrimary: boolean;
    number: number;
    repository: string;
    title: string;
    url: string;
  }>;
  resolution: {
    completeness: "COMPLETE" | "PARTIAL";
    diagnostics: unknown[];
  };
}

export interface GeneratedSpecificationCase {
  authRole: string;
  evidence: Array<{
    description: string;
    kind:
      | "SCREENSHOT"
      | "DOM"
      | "NETWORK"
      | "CONSOLE"
      | "BUSINESS_REFERENCE"
      | "ARTIFACT";
  }>;
  expected: string[];
  name: string;
  preconditions: string[];
  rationale: string;
  steps: Array<{ action: string; order: number }>;
}

export interface GeneratedBusinessTestSpecification {
  cases: GeneratedSpecificationCase[];
  summary: string;
}

/** Deterministically turns one normalized source snapshot into executable cases. */
export function generateBusinessTestSpec(
  context: SpecificationGenerationContext,
): GeneratedBusinessTestSpecification {
  const primaryPullRequest = selectPrimaryPullRequest(context);
  const sourceTexts = [
    context.issue.description,
    ...context.pullRequests.flatMap((pullRequest) => [
      pullRequest.title,
      pullRequest.body,
    ]),
    ...context.knowledge.map((item) => item.content),
  ];
  const extracted = unique(
    sourceTexts.flatMap((source) => extractBusinessExpectations(source)),
  ).slice(0, 10);
  const expectations = extracted.length
    ? extracted
    : [`用户可以完成「${context.issue.title}」，且结果符合 Issue 描述。`];
  const changedAreas = unique(
    context.pullRequests
      .flatMap((pullRequest) => pullRequest.changedFiles)
      .map(changedBusinessArea)
      .filter((area): area is string => area !== null),
  ).slice(0, 3);
  const comparisonSources = [
    "Issue",
    ...(context.pullRequests.length ? ["Pull Request"] : []),
    ...(context.knowledge.length ? ["知识库规则"] : []),
  ].join("、");

  const cases = expectations.map((expected, index) => {
    const preconditions = [
      `与 ${context.issue.identifier} 关联的变更已处于可验证状态`,
      `使用具备「${context.issue.title}」业务流程所需权限的测试身份`,
    ];
    if (primaryPullRequest?.deploymentUrl) {
      preconditions[0] = `GitHub PR ${primaryPullRequest.repository}#${primaryPullRequest.number} 的部署产物可访问`;
    }
    if (context.knowledge[0]) {
      preconditions.push(
        `以知识库「${context.knowledge[0].title}」中的规则作为判断依据`,
      );
    }
    const scopeHint = changedAreas.length
      ? `，重点覆盖 ${changedAreas.join("、")}`
      : "";
    return {
      authRole: "default",
      evidence: inferEvidence(expected),
      expected: [expected],
      name: truncate(
        `${context.issue.identifier} · ${caseName(expected, index)}`,
        500,
      ),
      preconditions,
      rationale: truncate(
        `由 ${context.issue.identifier} 的验收描述自动生成${scopeHint}；结论必须绑定可追溯证据。`,
        5_000,
      ),
      steps: [
        {
          action: `进入与「${context.issue.title}」相关的业务入口`,
          order: 1,
        },
        {
          action: `执行能够触发以下业务结果的主路径：${expected.replace(/^(?:Then|那么|则)\s*[:：]?\s*/iu, "")}`,
          order: 2,
        },
        {
          action: `记录关键业务结果，并与 ${comparisonSources} 逐项核对`,
          order: 3,
        },
      ],
    } satisfies GeneratedSpecificationCase;
  });

  const sources = [
    "Linear Issue",
    ...(context.pullRequests.length === 1
      ? ["GitHub PR"]
      : context.pullRequests.length > 1
        ? [`${context.pullRequests.length} 个 GitHub PR`]
        : []),
    ...(context.knowledge.length
      ? [`${context.knowledge.length} 条知识库内容`]
      : []),
  ];
  return {
    cases,
    summary: truncate(
      `围绕「${context.issue.title}」生成 ${cases.length} 个业务验证场景。` +
        `生成依据：${sources.join("、")}。` +
        (changedAreas.length
          ? `代码变更主要涉及 ${changedAreas.join("、")}。`
          : ""),
      5_000,
    ),
  };
}

export function selectPrimaryPullRequest(
  context: SpecificationGenerationContext,
) {
  return (
    context.pullRequests.find(
      (pullRequest) => pullRequest.isPrimary && pullRequest.deploymentUrl,
    ) ??
    context.pullRequests.find((pullRequest) => pullRequest.deploymentUrl) ??
    context.pullRequests.find((pullRequest) => pullRequest.isPrimary) ??
    context.pullRequests[0] ??
    null
  );
}

export function testGenerationContextHash(
  context: SpecificationGenerationContext,
) {
  return createHash("sha256").update(canonicalJson(context)).digest("hex");
}

export function specificationDefinitionHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function extractBusinessExpectations(source: string): string[] {
  if (!source.trim()) return [];
  const results: string[] = [];
  for (const rawLine of source.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed)) continue;
    const listItem = /^(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/u.test(trimmed);
    const normalized = trimmed
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/u, "")
      .replace(/^(?:AC|验收标准|预期结果?)\s*[:：-]\s*/iu, "")
      .trim();
    const expectation =
      /(?:应该|应当|必须|不得|禁止|可以|能够|显示|返回|保存|创建|更新|删除|完成|成功|失败|Given\b|When\b|Then\b|Expect(?:ed)?\b|Should\b|Must\b)/iu.test(
        normalized,
      );
    if (
      normalized.length >= 6 &&
      normalized.length <= 500 &&
      (listItem || expectation)
    ) {
      const sentence = normalized.replace(/[\s,，;；:：、]+$/u, "");
      results.push(/[。.!！?？]$/u.test(sentence) ? sentence : `${sentence}。`);
    }
  }
  return results;
}

function inferEvidence(
  expectation: string,
): GeneratedSpecificationCase["evidence"] {
  const evidence: GeneratedSpecificationCase["evidence"] = [];
  if (
    /(?:接口|请求|响应|状态码|支付|订单|network|api|request|response)/iu.test(
      expectation,
    )
  ) {
    evidence.push({
      description: "保存关键请求、响应与业务标识，证明后端结果与预期一致",
      kind: "NETWORK",
    });
  }
  if (
    /(?:页面|按钮|表单|列表|提示|文案|展示|显示|ui|page|button|form)/iu.test(
      expectation,
    )
  ) {
    evidence.push(
      { description: "保存关键状态的页面截图", kind: "SCREENSHOT" },
      { description: "保存能够证明状态和值的 DOM 快照", kind: "DOM" },
    );
  }
  evidence.push({
    description: "关联 Issue、Pull Request 或知识库中的对应业务规则",
    kind: "BUSINESS_REFERENCE",
  });
  return uniqueBy(evidence, (item) => item.kind);
}

function caseName(expectation: string, index: number) {
  const compact = expectation
    .replace(/^(?:Given|When|Then|假如|当|那么|应当|应该)\s*[:：]?\s*/iu, "")
    .replace(/[。.!！?？]$/u, "")
    .trim();
  return truncate(compact || `业务场景 ${index + 1}`, 450);
}

function changedBusinessArea(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  const ignored = new Set([
    "src",
    "app",
    "apps",
    "packages",
    "lib",
    "components",
  ]);
  return (
    parts.find((part) => !ignored.has(part.toLowerCase())) ?? parts[0] ?? null
  );
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function unique(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}
