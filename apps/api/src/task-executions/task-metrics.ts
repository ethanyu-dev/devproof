import { numericModelUsage } from "@devproof/agent-runtime-protocol";
import type {
  ModelUsageSummary,
  TaskActivity,
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
}
const waits = new Set([
  "QUEUE",
  "HUMAN",
  "DEPENDENCY",
  "BACKOFF",
  "MIXED_WAIT",
]);
const work = new Set(["MODEL", "TOOL", "PLATFORM", "RECOVERY"]);
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
    const lanes = new Map<string, Set<string>>();
    for (const span of active.keys()) {
      if (!lanes.has(span.lane)) lanes.set(span.lane, new Set());
      lanes.get(span.lane)!.add(span.activity);
    }
    const activities = new Set<string>();
    for (const kinds of lanes.values()) {
      // Structural preparation spans contain model/tool activity in the same lane.
      if (kinds.has("MODEL") || kinds.has("TOOL")) kinds.delete("PLATFORM");
      for (const kind of kinds) activities.add(kind);
    }
    const running = [...activities].filter((a) => work.has(a));
    const waiting = [...activities].filter((a) => waits.has(a));
    const category = (
      activities.has("UNKNOWN")
        ? "UNKNOWN"
        : running.length > 1
          ? "PARALLEL"
          : (running[0] ??
            (waiting.length > 1 ? "MIXED_WAIT" : (waiting[0] ?? "UNKNOWN")))
    ) as TaskActivity;
    totals.set(category, (totals.get(category) ?? 0) + sorted[i + 1]! - at);
  }
  let remaining = 1000;
  return [...totals].map(([activity, durationMs], i, all) => {
    const tenths =
      end === start
        ? 0
        : i === all.length - 1
          ? remaining
          : Math.min(
              remaining,
              Math.round((durationMs / (end - start)) * 1000),
            );
    remaining -= tenths;
    return {
      activity,
      durationMs,
      percentage: end === start ? null : tenths / 10,
    };
  });
}
