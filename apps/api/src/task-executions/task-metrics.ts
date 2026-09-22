import { numericModelUsage } from "@devproof/agent-runtime-protocol";
import type {
  ModelUsageSummary,
  RuntimeApplicability,
  TaskActivity,
  TaskRuntimeKind,
  TaskRuntimeResidual,
  TaskRuntimeTiming,
  TaskTimingBucket,
  TokenMetric,
} from "@devproof/contracts";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const number = (v: unknown): bigint | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;

export function normalizeUsage(value: unknown) {
  const raw = obj(value),
    issues: string[] = [];
  const read = (key: string) => {
    const result = number(raw[key]);
    if (raw[key] !== undefined && result === null)
      issues.push(`INVALID_${key}`);
    return result;
  };
  const prompt = read("prompt_tokens"),
    input = read("input_tokens");
  const completion = read("completion_tokens"),
    output = read("output_tokens");
  const inputTokens = prompt ?? input,
    outputTokens = completion ?? output;
  if (prompt !== null && input !== null && prompt !== input)
    issues.push("INPUT_CONFLICT");
  if (completion !== null && output !== null && completion !== output)
    issues.push("OUTPUT_CONFLICT");
  const nestedRaw =
    obj(raw.prompt_tokens_details).cached_tokens ??
    obj(raw.input_tokens_details).cached_tokens;
  const nested = number(nestedRaw),
    hit = read("prompt_cache_hit_tokens"),
    miss = read("prompt_cache_miss_tokens");
  if (nestedRaw !== undefined && nested === null) issues.push("INVALID_CACHE");
  let cacheReadTokens = hit ?? nested;
  if (hit !== null && nested !== null && hit !== nested) {
    issues.push("CACHE_CONFLICT");
    cacheReadTokens = null;
  }
  if (
    cacheReadTokens !== null &&
    inputTokens !== null &&
    cacheReadTokens > inputTokens
  ) {
    issues.push("CACHE_EXCEEDS_INPUT");
    cacheReadTokens = null;
  }
  if (
    hit !== null &&
    miss !== null &&
    inputTokens !== null &&
    hit + miss !== inputTokens
  ) {
    issues.push("CACHE_SUM_CONFLICT");
    cacheReadTokens = null;
  }
  const total = read("total_tokens");
  if (
    total !== null &&
    inputTokens !== null &&
    outputTokens !== null &&
    total !== inputTokens + outputTokens
  )
    issues.push("TOTAL_CONFLICT");
  return {
    inputTokens: issues.includes("INPUT_CONFLICT") ? null : inputTokens,
    outputTokens: issues.includes("OUTPUT_CONFLICT") ? null : outputTokens,
    cacheReadTokens,
    rawUsage: numericModelUsage(value),
    issues,
  };
}

export interface UsageFact {
  configurationId: string | null;
  configurationName: string | null;
  requestedModel: string;
  responseModel: string | null;
  scope: string;
  outcome: string;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  cacheReadTokens: bigint | null;
  durationMs: bigint | null;
}
export function tokenMetric(values: (bigint | null)[]): TokenMetric {
  const known = values.filter((v): v is bigint => v !== null);
  return {
    known: known.length
      ? known.reduce((a, b) => a + b, 0n).toString()
      : values.length
        ? null
        : "0",
    reportedCalls: known.length,
    missingCalls: values.length - known.length,
  };
}
export function usageTotals(calls: UsageFact[]) {
  const total = tokenMetric(
    calls.map((c) =>
      c.inputTokens !== null && c.outputTokens !== null
        ? c.inputTokens + c.outputTokens
        : null,
    ),
  );
  return {
    calls: calls.length,
    input: tokenMetric(calls.map((c) => c.inputTokens)),
    output: tokenMetric(calls.map((c) => c.outputTokens)),
    cacheRead: tokenMetric(calls.map((c) => c.cacheReadTokens)),
    total,
    coverage: (!total.missingCalls
      ? "COMPLETE"
      : total.reportedCalls
        ? "PARTIAL"
        : "UNAVAILABLE") as ModelUsageSummary["coverage"],
  };
}
export function summarizeModels(
  calls: UsageFact[],
  terminal: boolean,
): ModelUsageSummary[] {
  const groups = new Map<string, UsageFact[]>();
  for (const c of calls) {
    const key = JSON.stringify([
      c.scope,
      c.configurationId ?? c.configurationName,
      c.responseModel ?? c.requestedModel,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()]
    .map(([key, rows]) => {
      const first = rows[0]!;
      const covered = rows.filter(
        (c) => c.inputTokens !== null && c.cacheReadTokens !== null,
      );
      const input = covered.reduce((sum, c) => sum + c.inputTokens!, 0n),
        cache = covered.reduce((sum, c) => sum + c.cacheReadTokens!, 0n);
      return {
        key,
        model: first.responseModel ?? first.requestedModel,
        configurationName: first.configurationName,
        scope: first.scope as ModelUsageSummary["scope"],
        ...usageTotals(rows),
        failedCalls: rows.filter((c) => c.outcome === "FAILED").length,
        interruptedCalls: rows.filter(
          (c) =>
            c.outcome === "INTERRUPTED" ||
            (terminal && c.scope === "EXECUTION" && c.outcome === "RUNNING"),
        ).length,
        runningCalls: rows.filter(
          (c) =>
            c.outcome === "RUNNING" && !(terminal && c.scope === "EXECUTION"),
        ).length,
        cacheHitRate: input ? Number((cache * 100000n) / input) / 1000 : null,
        cacheCoveredCalls: covered.length,
        requestDurationMs: rows.reduce(
          (sum, c) => sum + Number(c.durationMs ?? 0n),
          0,
        ),
      };
    })
    .sort((a, b) => b.requestDurationMs - a.requestDurationMs);
}

export interface TimingSpan {
  activity: string;
  lane: string;
  startedAt: Date;
  finishedAt: Date | null;
  runtime?: TaskRuntimeKind | null;
}
const waits = new Set([
  "QUEUE",
  "HUMAN",
  "DEPENDENCY",
  "BACKOFF",
  "MIXED_WAIT",
]);
const work = new Set(["MODEL", "TOOL", "PLATFORM", "RECOVERY"]);
const activeActivities = new Set([
  "MODEL",
  "TOOL",
  "PLATFORM",
  "RECOVERY",
  "PARALLEL",
]);
export type RuntimeTag = TaskRuntimeKind | "OVERLAP" | "UNASSIGNED";
const runtimeOrder: RuntimeTag[] = [
  "SPEC_ANALYSIS",
  "BROWSER",
  "UNASSIGNED",
  "OVERLAP",
];

function exclusiveActivity(active: Iterable<TimingSpan>): TaskActivity {
  const lanes = new Map<string, Set<string>>();
  for (const span of active) {
    if (!lanes.has(span.lane)) lanes.set(span.lane, new Set());
    lanes.get(span.lane)!.add(span.activity);
  }
  const activities = new Set<string>();
  for (const kinds of lanes.values()) {
    // Structural preparation spans contain model/tool activity in the same lane.
    if (kinds.has("MODEL") || kinds.has("TOOL")) kinds.delete("PLATFORM");
    for (const kind of kinds) activities.add(kind);
  }
  const running = [...activities].filter((item) => work.has(item));
  const waiting = [...activities].filter((item) => waits.has(item));
  return (
    activities.has("UNKNOWN")
      ? "UNKNOWN"
      : running.length > 1
        ? "PARALLEL"
        : (running[0] ??
          (waiting.length > 1 ? "MIXED_WAIT" : (waiting[0] ?? "UNKNOWN")))
  ) as TaskActivity;
}

function bucketShares(
  total: number,
  entries: Array<[TaskActivity, number]>,
): TaskTimingBucket[] {
  const positive = entries.filter(([, duration]) => duration > 0);
  let remaining = 1000;
  return positive.map(([activity, durationMs], index) => {
    const tenths = !(total > 0)
      ? 0
      : index === positive.length - 1
        ? remaining
        : Math.min(remaining, Math.round((durationMs / total) * 1000));
    remaining -= tenths;
    return {
      activity,
      durationMs,
      percentage: total > 0 ? tenths / 10 : null,
    };
  });
}

export function timingBuckets(
  start: number,
  end: number,
  spans: TimingSpan[],
): TaskTimingBucket[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return [];
  const points = new Map<number, Array<{ span: TimingSpan; delta: number }>>();
  points.set(start, []);
  points.set(end, []);
  for (const span of spans) {
    // Unclosed worker spans have no measured duration. Durable waits remain live.
    if (!span.finishedAt && !waits.has(span.activity)) continue;
    const from = Math.max(start, span.startedAt.getTime()),
      to = Math.min(end, span.finishedAt?.getTime() ?? end);
    if (to <= from) continue;
    points.set(from, [...(points.get(from) ?? []), { span, delta: 1 }]);
    points.set(to, [...(points.get(to) ?? []), { span, delta: -1 }]);
  }
  const active = new Map<TimingSpan, number>(),
    totals = new Map<TaskActivity, number>();
  const sorted = [...points.keys()].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length - 1; i++) {
    const at = sorted[i]!;
    for (const { span, delta } of points.get(at)!) {
      const count = (active.get(span) ?? 0) + delta;
      if (count) active.set(span, count);
      else active.delete(span);
    }
    const category = exclusiveActivity(active.keys());
    totals.set(category, (totals.get(category) ?? 0) + sorted[i + 1]! - at);
  }
  if (end === start) return [];
  return bucketShares(end - start, [...totals]);
}

export interface InferenceUsage {
  stage: string;
  scope: string;
  runId: string | null;
}
export interface InferenceContext {
  taskId: string;
  attemptIds: ReadonlySet<string>;
  runIds: ReadonlySet<string>;
  usages: ReadonlyMap<string, InferenceUsage>;
  deterministicAnalysis: boolean;
}

/** Sole span attribution used by rebuild, timeline, and call detail. */
export function inferSpanRuntime(
  span: {
    id: string;
    lane: string;
    label: string;
    scope?: string;
    intervention?: boolean;
  },
  ctx: InferenceContext,
): TaskRuntimeKind | null {
  if (span.scope === "ACCEPTANCE_REVIEW") return null;
  if (span.intervention) return "BROWSER";
  if (span.id === "initial" || span.id.startsWith("state:task_executions:"))
    return null;
  // Case rows stay browser even when the reason is PROFILE_RESERVED.
  if (
    span.id.startsWith("state:execution_runs:") ||
    span.id.startsWith("state:task_case_executions:")
  )
    return "BROWSER";
  if (
    span.label === "DEPLOYMENT_TARGET_REQUIRED" ||
    span.label.startsWith("PROFILE_")
  )
    return null;
  if (span.id.startsWith("model:")) {
    const usage = ctx.usages.get(span.id.slice("model:".length));
    if (usage?.scope === "EXECUTION" && usage.stage === "SPEC_ANALYSIS")
      return ctx.deterministicAnalysis ? null : "SPEC_ANALYSIS";
    if (usage && (usage.runId != null || usage.stage === "SPEC_EXECUTION"))
      return "BROWSER";
  }
  // Compatibility runs set task.id = run.id, so a bare lane match is not browser.
  if (span.lane !== ctx.taskId && ctx.attemptIds.has(span.lane))
    return ctx.deterministicAnalysis ? null : "SPEC_ANALYSIS";
  if (span.lane !== ctx.taskId && ctx.runIds.has(span.lane)) return "BROWSER";
  return null;
}

export interface RuntimeAttemptFact {
  id: string;
  stageType: string;
  executor: string | null;
  createdAt: number;
  finishedAt: number | null;
}
export interface RuntimeRunFact {
  id: string;
  createdAt: number;
  finishedAt: number | null;
}
export interface RuntimeSpanFact {
  id: string;
  lane: string;
  label: string;
  activity: string;
  scope?: string;
  startedAt: number;
  finishedAt: number | null;
  intervention?: boolean;
}
export interface RuntimeUsageFact extends InferenceUsage {
  id: string;
  ownerId: string;
}
export interface RuntimeProjectionInput {
  taskId: string;
  start: number;
  end: number;
  analysisStageStatus: string | null;
  attempts: RuntimeAttemptFact[];
  runs: RuntimeRunFact[];
  spans: RuntimeSpanFact[];
  usages: RuntimeUsageFact[];
}
export interface RuntimeSegment {
  start: number;
  end: number;
  activity: TaskActivity;
  runtime: RuntimeTag;
}
export interface RuntimeProjection {
  elapsedMs: number | null;
  buckets: TaskTimingBucket[];
  segments: RuntimeSegment[];
  runtimes: TaskRuntimeTiming[];
  unassigned: TaskRuntimeResidual;
  overlap: TaskRuntimeResidual;
  ok: boolean;
  occupiedMs: number;
}

function analysisAttempts(input: RuntimeProjectionInput) {
  return input.attempts.filter(
    (attempt) => attempt.stageType === "SPEC_ANALYSIS",
  );
}

function historicalAgentIds(input: RuntimeProjectionInput) {
  const ids = new Set<string>();
  for (const attempt of analysisAttempts(input)) {
    if (attempt.executor != null) continue;
    const spanned = input.spans.some(
      (span) =>
        span.lane === attempt.id &&
        span.lane !== input.taskId &&
        span.scope !== "ACCEPTANCE_REVIEW" &&
        (span.activity === "MODEL" ||
          span.activity === "TOOL" ||
          span.id.startsWith("model:") ||
          span.id.startsWith("tool:")),
    );
    const linked = input.usages.some(
      (usage) =>
        usage.ownerId === attempt.id &&
        usage.stage === "SPEC_ANALYSIS" &&
        usage.scope === "EXECUTION",
    );
    if (spanned || linked) ids.add(attempt.id);
  }
  return ids;
}

function analysisApplicability(
  input: RuntimeProjectionInput,
  historical: ReadonlySet<string>,
): RuntimeApplicability {
  const attempts = analysisAttempts(input);
  if (attempts.some((attempt) => attempt.executor === "AGENT_RUNTIME"))
    return "MEASURED";
  if (attempts.some((attempt) => historical.has(attempt.id))) return "PARTIAL";
  if (
    attempts.length > 0 &&
    attempts.every((attempt) => attempt.executor === "DETERMINISTIC")
  )
    return "NOT_APPLICABLE";
  if (
    input.analysisStageStatus === "SKIPPED" ||
    input.analysisStageStatus == null
  )
    return "NOT_APPLICABLE";
  return "NOT_STARTED";
}

function tagShares(elapsed: number, occupied: Record<RuntimeTag, number>) {
  const shares = {} as Record<RuntimeTag, number | null>;
  if (!(elapsed > 0)) {
    for (const tag of runtimeOrder) shares[tag] = null;
    return shares;
  }
  const positive = runtimeOrder.filter((tag) => (occupied[tag] ?? 0) > 0);
  let remaining = 1000;
  const lastPositive = positive[positive.length - 1];
  for (const tag of runtimeOrder) {
    const duration = occupied[tag] ?? 0;
    if (duration <= 0 || lastPositive === undefined) {
      shares[tag] = 0;
      continue;
    }
    const tenths =
      tag === lastPositive
        ? remaining
        : Math.min(remaining, Math.round((duration / elapsed) * 1000));
    remaining -= tenths;
    shares[tag] = tenths / 10;
  }
  return shares;
}

function pausedByAgent(
  span: RuntimeSpanFact,
  attempts: RuntimeAttemptFact[],
  agentIds: ReadonlySet<string>,
) {
  if (span.label !== "ANALYSIS_INPUT_REQUIRED") return false;
  const ended = attempts.filter(
    (attempt) =>
      attempt.finishedAt !== null && attempt.finishedAt <= span.startedAt,
  );
  const latest = ended.reduce(
    (max, attempt) => Math.max(max, attempt.finishedAt ?? 0),
    Number.NEGATIVE_INFINITY,
  );
  return ended.some(
    (attempt) => attempt.finishedAt === latest && agentIds.has(attempt.id),
  );
}

function classifyRuntime(
  active: TimingSpan[],
  masks: TaskRuntimeKind[],
): RuntimeTag {
  const working = new Set<TaskRuntimeKind>();
  const waiting = new Set<TaskRuntimeKind>();
  for (const span of active) {
    if (span.runtime !== "SPEC_ANALYSIS" && span.runtime !== "BROWSER")
      continue;
    if (work.has(span.activity)) working.add(span.runtime);
    else waiting.add(span.runtime);
  }
  const covered = new Set(masks);
  if (working.size > 1) return "OVERLAP";
  if (working.size === 1) {
    const [runtime] = working;
    if ([...waiting, ...covered].some((item) => item !== runtime))
      return "OVERLAP";
    return runtime!;
  }
  const idle = new Set<TaskRuntimeKind>([...waiting, ...covered]);
  if (idle.size > 1) return "OVERLAP";
  if (idle.size === 1) return [...idle][0]!;
  return "UNASSIGNED";
}

export function projectRuntimeTiming(
  input: RuntimeProjectionInput,
): RuntimeProjection {
  const elapsedMs =
    Number.isFinite(input.start) &&
    Number.isFinite(input.end) &&
    input.end >= input.start
      ? input.end - input.start
      : null;
  const attempts = analysisAttempts(input);
  const historical = historicalAgentIds(input);
  const deterministic =
    attempts.length > 0 &&
    attempts.every((attempt) => attempt.executor === "DETERMINISTIC");
  const runIds = new Set(input.runs.map((run) => run.id));
  const ctx: InferenceContext = {
    taskId: input.taskId,
    attemptIds: new Set(attempts.map((attempt) => attempt.id)),
    runIds,
    usages: new Map(input.usages.map((usage) => [usage.id, usage])),
    deterministicAnalysis: deterministic,
  };
  const execution = input.spans.filter(
    (span) => span.scope !== "ACCEPTANCE_REVIEW",
  );
  const timed: TimingSpan[] = execution.map((span) => ({
    activity: span.activity,
    lane: span.lane,
    startedAt: new Date(span.startedAt),
    finishedAt: span.finishedAt === null ? null : new Date(span.finishedAt),
    runtime: inferSpanRuntime(span, ctx),
  }));
  const agent = attempts.filter(
    (attempt) =>
      attempt.executor === "AGENT_RUNTIME" || historical.has(attempt.id),
  );
  const masks: Array<{ runtime: TaskRuntimeKind; from: number; to: number }> =
    [];
  const close = (finishedAt: number | null) => finishedAt ?? input.end;
  if (elapsedMs !== null) {
    for (const attempt of agent)
      masks.push({
        runtime: "SPEC_ANALYSIS",
        from: attempt.createdAt,
        to: close(attempt.finishedAt),
      });
    const agentIds = new Set(agent.map((attempt) => attempt.id));
    for (const span of execution)
      if (pausedByAgent(span, attempts, agentIds))
        masks.push({
          runtime: "SPEC_ANALYSIS",
          from: span.startedAt,
          to: close(span.finishedAt),
        });
    for (const run of input.runs)
      masks.push({
        runtime: "BROWSER",
        from: run.createdAt,
        to: close(run.finishedAt),
      });
    for (const span of execution)
      if (
        span.id.startsWith("state:task_case_executions:") &&
        !runIds.has(span.lane)
      )
        masks.push({
          runtime: "BROWSER",
          from: span.startedAt,
          to: close(span.finishedAt),
        });
  }
  const caseWait = execution.some(
    (span) =>
      span.id.startsWith("state:task_case_executions:") &&
      !runIds.has(span.lane),
  );
  const applicability = {
    SPEC_ANALYSIS: analysisApplicability(input, historical),
    BROWSER: (input.runs.length > 0 || caseWait
      ? "MEASURED"
      : "NOT_STARTED") as RuntimeApplicability,
  };
  const segments =
    elapsedMs === null ? [] : sweep(input.start, input.end, timed, masks);
  const activityTotals = new Map<TaskActivity, number>();
  const occupied = {
    SPEC_ANALYSIS: 0,
    BROWSER: 0,
    UNASSIGNED: 0,
    OVERLAP: 0,
  } as Record<RuntimeTag, number>;
  const activities = {
    SPEC_ANALYSIS: new Map<TaskActivity, number>(),
    BROWSER: new Map<TaskActivity, number>(),
    UNASSIGNED: new Map<TaskActivity, number>(),
    OVERLAP: new Map<TaskActivity, number>(),
  };
  const partition = {
    SPEC_ANALYSIS: { activeMs: 0, waitingMs: 0, unknownMs: 0 },
    BROWSER: { activeMs: 0, waitingMs: 0, unknownMs: 0 },
    UNASSIGNED: { activeMs: 0, waitingMs: 0, unknownMs: 0 },
    OVERLAP: { activeMs: 0, waitingMs: 0, unknownMs: 0 },
  };
  for (const segment of segments) {
    const dt = segment.end - segment.start;
    activityTotals.set(
      segment.activity,
      (activityTotals.get(segment.activity) ?? 0) + dt,
    );
    occupied[segment.runtime] = (occupied[segment.runtime] ?? 0) + dt;
    const totals = activities[segment.runtime];
    totals?.set(segment.activity, (totals.get(segment.activity) ?? 0) + dt);
    const part = partition[segment.runtime];
    if (!part) continue;
    if (activeActivities.has(segment.activity)) part.activeMs += dt;
    else if (waits.has(segment.activity)) part.waitingMs += dt;
    else part.unknownMs += dt;
  }
  const buckets =
    elapsedMs === null || elapsedMs === 0
      ? []
      : bucketShares(elapsedMs, [...activityTotals]);
  const shares =
    elapsedMs === null
      ? tagShares(0, occupied)
      : tagShares(elapsedMs, occupied);
  const residual = (tag: "UNASSIGNED" | "OVERLAP"): TaskRuntimeResidual => ({
    occupiedMs: occupied[tag] ?? 0,
    percentage: shares[tag] ?? null,
    ...(partition[tag] ?? { activeMs: 0, waitingMs: 0, unknownMs: 0 }),
    buckets: bucketShares(occupied[tag] ?? 0, [...(activities[tag] ?? [])]),
  });
  const cumulative = {
    SPEC_ANALYSIS: { modelMs: 0, toolMs: 0, platformMs: 0, recoveryMs: 0 },
    BROWSER: { modelMs: 0, toolMs: 0, platformMs: 0, recoveryMs: 0 },
  };
  if (elapsedMs !== null)
    for (const span of timed) {
      if (!span.runtime || !work.has(span.activity) || !span.finishedAt)
        continue;
      const from = Math.max(input.start, span.startedAt.getTime());
      const to = Math.min(input.end, span.finishedAt.getTime());
      if (to <= from) continue;
      const key = `${span.activity.toLowerCase()}Ms` as
        "modelMs" | "toolMs" | "platformMs" | "recoveryMs";
      const counts = cumulative[span.runtime];
      if (counts) counts[key] += to - from;
    }
  const runtimes: TaskRuntimeTiming[] = (
    ["SPEC_ANALYSIS", "BROWSER"] as const
  ).map((runtime) => ({
    runtime,
    applicability: applicability[runtime],
    occupiedMs: occupied[runtime] ?? 0,
    percentage: shares[runtime] ?? null,
    ...(partition[runtime] ?? { activeMs: 0, waitingMs: 0, unknownMs: 0 }),
    buckets: bucketShares(occupied[runtime] ?? 0, [
      ...(activities[runtime] ?? []),
    ]),
    cumulative: cumulative[runtime] ?? {
      modelMs: 0,
      toolMs: 0,
      platformMs: 0,
      recoveryMs: 0,
    },
  }));
  const unassigned = residual("UNASSIGNED");
  const overlap = residual("OVERLAP");
  const occupiedMs = runtimeOrder.reduce(
    (sum, tag) => sum + (occupied[tag] ?? 0),
    0,
  );
  return {
    elapsedMs,
    buckets,
    segments: mergeSegments(segments),
    runtimes,
    unassigned,
    overlap,
    occupiedMs,
    ok: invariantHolds(elapsedMs, buckets, runtimes, unassigned, overlap),
  };
}

function mergeSegments(segments: RuntimeSegment[]) {
  const merged: RuntimeSegment[] = [];
  for (const segment of segments) {
    const last = merged.at(-1);
    if (
      last &&
      last.end === segment.start &&
      last.activity === segment.activity &&
      last.runtime === segment.runtime
    )
      last.end = segment.end;
    else merged.push({ ...segment });
  }
  return merged;
}

function sweep(
  start: number,
  end: number,
  spans: TimingSpan[],
  masks: Array<{ runtime: TaskRuntimeKind; from: number; to: number }>,
): RuntimeSegment[] {
  const points = new Map<
    number,
    Array<
      | { kind: "span"; span: TimingSpan; delta: number }
      | { kind: "mask"; runtime: TaskRuntimeKind; delta: number }
    >
  >();
  const add = (
    at: number,
    event:
      | { kind: "span"; span: TimingSpan; delta: number }
      | {
          kind: "mask";
          runtime: TaskRuntimeKind;
          delta: number;
        },
  ) => points.set(at, [...(points.get(at) ?? []), event]);
  points.set(start, []);
  points.set(end, []);
  for (const span of spans) {
    if (!span.finishedAt && !waits.has(span.activity)) continue;
    const from = Math.max(start, span.startedAt.getTime());
    const to = Math.min(end, span.finishedAt?.getTime() ?? end);
    if (to <= from) continue;
    add(from, { kind: "span", span, delta: 1 });
    add(to, { kind: "span", span, delta: -1 });
  }
  for (const mask of masks) {
    const from = Math.max(start, mask.from);
    const to = Math.min(end, mask.to);
    if (to <= from) continue;
    add(from, { kind: "mask", runtime: mask.runtime, delta: 1 });
    add(to, { kind: "mask", runtime: mask.runtime, delta: -1 });
  }
  const active = new Map<TimingSpan, number>();
  const covered = new Map<TaskRuntimeKind, number>();
  const segments: RuntimeSegment[] = [];
  const sorted = [...points.keys()].sort((a, b) => a - b);
  for (let index = 0; index < sorted.length - 1; index++) {
    const at = sorted[index]!;
    for (const event of points.get(at)!) {
      if (event.kind === "span") {
        const count = (active.get(event.span) ?? 0) + event.delta;
        if (count) active.set(event.span, count);
        else active.delete(event.span);
      } else {
        const count = (covered.get(event.runtime) ?? 0) + event.delta;
        if (count > 0) covered.set(event.runtime, count);
        else covered.delete(event.runtime);
      }
    }
    const next = sorted[index + 1]!;
    if (next <= at) continue;
    segments.push({
      start: at,
      end: next,
      activity: exclusiveActivity(active.keys()),
      // A mask counts only when it covers this whole half-open slice.
      runtime: classifyRuntime([...active.keys()], [...covered.keys()]),
    });
  }
  return segments;
}

function invariantHolds(
  elapsedMs: number | null,
  buckets: TaskTimingBucket[],
  runtimes: TaskRuntimeTiming[],
  unassigned: TaskRuntimeResidual,
  overlap: TaskRuntimeResidual,
) {
  if (!(elapsedMs !== null && elapsedMs > 0)) return true;
  const parts = [...runtimes, unassigned, overlap];
  if (buckets.reduce((sum, bucket) => sum + bucket.durationMs, 0) !== elapsedMs)
    return false;
  if (parts.reduce((sum, part) => sum + part.occupiedMs, 0) !== elapsedMs)
    return false;
  for (const part of parts) {
    if (
      part.buckets.reduce((sum, bucket) => sum + bucket.durationMs, 0) !==
      part.occupiedMs
    )
      return false;
    if (part.activeMs + part.waitingMs + part.unknownMs !== part.occupiedMs)
      return false;
  }
  const names = new Set<TaskActivity>();
  for (const bucket of buckets) names.add(bucket.activity);
  for (const part of parts)
    for (const bucket of part.buckets) names.add(bucket.activity);
  for (const activity of names) {
    const global =
      buckets.find((bucket) => bucket.activity === activity)?.durationMs ?? 0;
    const split = parts.reduce(
      (sum, part) =>
        sum +
        (part.buckets.find((bucket) => bucket.activity === activity)
          ?.durationMs ?? 0),
      0,
    );
    if (global !== split) return false;
  }
  const sumBy = (pick: (part: TaskRuntimeResidual) => number) =>
    parts.reduce((sum, part) => sum + pick(part), 0);
  const globalBy = (activities: Set<string>) =>
    buckets
      .filter((bucket) => activities.has(bucket.activity))
      .reduce((sum, bucket) => sum + bucket.durationMs, 0);
  return (
    sumBy((part) => part.activeMs) === globalBy(activeActivities) &&
    sumBy((part) => part.waitingMs) === globalBy(waits) &&
    sumBy((part) => part.unknownMs) === globalBy(new Set(["UNKNOWN"]))
  );
}

export function runtimeAttributionFailed(
  summary: unknown,
  revision: bigint | number | string,
) {
  if (!summary || typeof summary !== "object") return false;
  const row = summary as Record<string, unknown>;
  return (
    row.runtimeAttribution === "FAILED" &&
    String(row.runtimeAttributionRevision) === String(revision)
  );
}
