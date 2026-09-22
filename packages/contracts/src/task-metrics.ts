export type UsageCoverage = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
export interface TokenMetric {
  known: string | null;
  reportedCalls: number;
  missingCalls: number;
}
export interface ModelUsageSummary {
  key: string;
  model: string;
  configurationName: string | null;
  scope: "EXECUTION" | "ACCEPTANCE_REVIEW";
  calls: number;
  failedCalls: number;
  interruptedCalls: number;
  runningCalls: number;
  input: TokenMetric;
  output: TokenMetric;
  cacheRead: TokenMetric;
  total: TokenMetric;
  coverage: UsageCoverage;
  cacheHitRate: number | null;
  cacheCoveredCalls: number;
  requestDurationMs: number;
}
export type TaskActivity =
  | "MODEL"
  | "TOOL"
  | "PLATFORM"
  | "RECOVERY"
  | "QUEUE"
  | "HUMAN"
  | "DEPENDENCY"
  | "BACKOFF"
  | "PARALLEL"
  | "MIXED_WAIT"
  | "UNKNOWN";
export interface TaskTimingBucket {
  activity: TaskActivity;
  durationMs: number;
  percentage: number | null;
}
export type TaskRuntimeKind = "SPEC_ANALYSIS" | "BROWSER";
export type RuntimeApplicability =
  "MEASURED" | "PARTIAL" | "NOT_APPLICABLE" | "NOT_STARTED";
/** Exclusive wall clock for one runtime. `percentage` uses task elapsedMs; `buckets` use `occupiedMs`. */
export interface TaskRuntimeTiming {
  runtime: TaskRuntimeKind;
  applicability: RuntimeApplicability;
  occupiedMs: number;
  percentage: number | null;
  activeMs: number;
  waitingMs: number;
  unknownMs: number;
  buckets: TaskTimingBucket[];
  cumulative: {
    modelMs: number;
    toolMs: number;
    platformMs: number;
    recoveryMs: number;
  };
}
/** Time in neither runtime, or time counted once because both runtimes apply. */
export interface TaskRuntimeResidual {
  occupiedMs: number;
  percentage: number | null;
  activeMs: number;
  waitingMs: number;
  unknownMs: number;
  buckets: TaskTimingBucket[];
}
export interface TaskMetrics {
  taskId: string;
  asOf: string;
  computedAt: string;
  refreshPending: boolean;
  version: number;
  elapsedMs: number | null;
  activeMs: number;
  waitingMs: number;
  timingQuality: "ESTIMATED" | "PARTIAL" | "UNAVAILABLE";
  buckets: TaskTimingBucket[];
  models: ModelUsageSummary[];
  totals: {
    input: TokenMetric;
    output: TokenMetric;
    cacheRead: TokenMetric;
    total: TokenMetric;
    coverage: UsageCoverage;
    calls: number;
  };
  reviewStatus: string | null;
  reviewDurationMs: number;
  phases: Array<{
    phase: string;
    startedAt: string | null;
    finishedAt: string | null;
    status: string;
  }>;
  /** Omitted when version is below 2. Order is SPEC_ANALYSIS, BROWSER. */
  runtimes?: TaskRuntimeTiming[];
  unassigned?: TaskRuntimeResidual;
  overlap?: TaskRuntimeResidual;
}
export interface TaskMetricCall {
  id: string;
  runId: string | null;
  attemptNumber: number | null;
  stage: string;
  model: string;
  configurationName: string | null;
  scope: "EXECUTION" | "ACCEPTANCE_REVIEW";
  startedAt: string | null;
  durationMs: number | null;
  outcome: string;
  inputTokens: string | null;
  outputTokens: string | null;
  cacheReadTokens: string | null;
  issues: string[];
  /** Derived from `stage`, not from a span column. Review calls stay null. */
  runtime: TaskRuntimeKind | null;
}
export interface TaskMetricSpan {
  id: string;
  lane: string;
  label: string;
  activity: TaskActivity;
  startedAt: string;
  finishedAt: string | null;
  estimated: boolean;
  /** `inferSpanRuntime` result. Null is unassigned, including review spans. */
  runtime: TaskRuntimeKind | null;
}
