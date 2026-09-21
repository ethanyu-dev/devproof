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
}
export interface TaskMetricSpan {
  id: string;
  lane: string;
  label: string;
  activity: TaskActivity;
  startedAt: string;
  finishedAt: string | null;
  estimated: boolean;
}
