import { describe, expect, it } from "vitest";
import { TaskMetricsService } from "./task-metrics.service.js";
import {
  normalizeUsage,
  projectRuntimeTiming,
  summarizeModels,
  timingBuckets,
  usageTotals,
  type RuntimeProjection,
  type RuntimeProjectionInput,
  type UsageFact,
} from "./task-metrics.js";

const call = (overrides: Partial<UsageFact> = {}): UsageFact => ({
  configurationId: "config",
  configurationName: "gateway",
  requestedModel: "alias",
  responseModel: "actual",
  scope: "EXECUTION",
  outcome: "SUCCEEDED",
  inputTokens: 1000n,
  outputTokens: 100n,
  cacheReadTokens: 600n,
  durationMs: 300n,
  ...overrides,
});
describe("task token accounting", () => {
  it("counts cached input once and keeps a numeric allowlist", () => {
    const parsed = normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 600 },
      total_tokens: 1100,
      secret: "never persist",
    });
    expect(parsed).toMatchObject({
      inputTokens: 1000n,
      outputTokens: 100n,
      cacheReadTokens: 600n,
      issues: [],
    });
    expect(parsed.rawUsage).not.toHaveProperty("secret");
    expect(usageTotals([call()]).total.known).toBe("1100");
  });
  it("distinguishes missing, zero, unsafe integers and contradictory usage", () => {
    expect(normalizeUsage({}).inputTokens).toBeNull();
    expect(normalizeUsage({ prompt_tokens: 0 }).inputTokens).toBe(0n);
    expect(
      normalizeUsage({ prompt_tokens: Number.MAX_SAFE_INTEGER + 1 }).issues,
    ).toContain("INVALID_prompt_tokens");
    expect(
      normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 101 })
        .cacheReadTokens,
    ).toBeNull();
    expect(
      normalizeUsage({ prompt_tokens: 100, input_tokens: 50 }).inputTokens,
    ).toBeNull();
    expect(
      normalizeUsage({
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 60,
        prompt_cache_miss_tokens: 50,
      }).issues,
    ).toContain("CACHE_SUM_CONFLICT");
    expect(
      normalizeUsage({
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 60,
        prompt_tokens_details: { cached_tokens: 50 },
      }).cacheReadTokens,
    ).toBeNull();
  });
  it("weights cache hit rate only over covered input and preserves missing calls", () => {
    const [m] = summarizeModels(
      [
        call({ inputTokens: 100n, cacheReadTokens: 100n }),
        call({ inputTokens: 900n, cacheReadTokens: 0n }),
        call({
          cacheReadTokens: null,
          inputTokens: null,
          outputTokens: null,
          outcome: "FAILED",
        }),
      ],
      true,
    );
    expect(m).toMatchObject({
      calls: 3,
      cacheHitRate: 10,
      cacheCoveredCalls: 2,
      coverage: "PARTIAL",
      failedCalls: 1,
    });
    expect(m!.cacheRead).toEqual({
      known: "100",
      reportedCalls: 2,
      missingCalls: 1,
    });
    expect(
      usageTotals([call({ inputTokens: null, outputTokens: null })]).total
        .known,
    ).toBeNull();
  });
  it("keeps model configurations and review usage separate and sums beyond JS safe integers", () => {
    const calls = [
      call({ inputTokens: BigInt(Number.MAX_SAFE_INTEGER) }),
      call({
        inputTokens: BigInt(Number.MAX_SAFE_INTEGER),
        configurationId: "other",
      }),
      call({ scope: "ACCEPTANCE_REVIEW" }),
    ];
    expect(summarizeModels(calls, true)).toHaveLength(3);
    expect(usageTotals(calls).input.known).toBe("18014398509482982");
  });
});
const span = (
  activity: string,
  start: number,
  end: number | null,
  lane = "a",
) => ({
  activity,
  lane,
  startedAt: new Date(start * 1000),
  finishedAt: end === null ? null : new Date(end * 1000),
});
describe("exclusive task elapsed time", () => {
  it("partitions parallel model/tool work without double counting", () => {
    const buckets = timingBuckets(0, 60000, [
      span("QUEUE", 0, 10),
      span("MODEL", 10, 40),
      span("TOOL", 20, 50, "b"),
      span("PLATFORM", 50, 60),
    ]);
    expect(
      Object.fromEntries(buckets.map((b) => [b.activity, b.durationMs])),
    ).toEqual({
      QUEUE: 10000,
      MODEL: 10000,
      PARALLEL: 20000,
      TOOL: 10000,
      PLATFORM: 10000,
    });
    expect(buckets.reduce((s, b) => s + (b.percentage ?? 0), 0)).toBeCloseTo(
      100,
    );
  });
  it("deduplicates same-category and nested tool spans, ignores waits while another lane works", () => {
    expect(
      timingBuckets(0, 10000, [
        span("MODEL", 0, 10),
        span("MODEL", 0, 10, "b"),
        span("HUMAN", 0, 10, "c"),
      ]),
    ).toEqual([{ activity: "MODEL", durationMs: 10000, percentage: 100 }]);
    expect(
      timingBuckets(0, 10000, [
        span("PLATFORM", 0, 10),
        span("TOOL", 0, 10),
        span("TOOL", 1, 8),
      ]),
    ).toEqual([{ activity: "TOOL", durationMs: 10000, percentage: 100 }]);
  });
  it("retains gaps and interrupted requests as unknown, but extends live durable waits", () => {
    expect(timingBuckets(0, 10000, [span("MODEL", 0, null)])).toEqual([
      { activity: "UNKNOWN", durationMs: 10000, percentage: 100 },
    ]);
    expect(
      timingBuckets(0, 10000, [
        span("QUEUE", 0, null),
        span("HUMAN", 0, null, "b"),
      ])[0]?.activity,
    ).toBe("MIXED_WAIT");
    expect(timingBuckets(0, 0, [])).toEqual([]);
    expect(timingBuckets(100, 0, [])).toEqual([]);
  });
  it("clips intervals at completion and excludes later work", () => {
    const b = timingBuckets(0, 10000, [
      span("MODEL", -10, 5),
      span("TOOL", 9, 20),
      span("MODEL", 20, 30),
    ]);
    expect(b.reduce((s, r) => s + r.durationMs, 0)).toBe(10000);
    expect(b.find((r) => r.activity === "UNKNOWN")?.durationMs).toBe(4000);
  });
});

const sec = (value: number) => value * 1000;
const project = (
  overrides: Partial<RuntimeProjectionInput> = {},
): RuntimeProjection =>
  projectRuntimeTiming({
    taskId: "task",
    start: 0,
    end: sec(30),
    analysisStageStatus: "RUNNING",
    attempts: [],
    runs: [],
    spans: [],
    usages: [],
    ...overrides,
  });
const slices = (result: RuntimeProjection) =>
  result.segments.map((segment) => ({
    start: segment.start / 1000,
    end: segment.end / 1000,
    activity: segment.activity,
    runtime: segment.runtime,
  }));
const part = (
  result: RuntimeProjection,
  runtime: "SPEC_ANALYSIS" | "BROWSER" | "UNASSIGNED" | "OVERLAP",
) =>
  runtime === "UNASSIGNED"
    ? result.unassigned
    : runtime === "OVERLAP"
      ? result.overlap
      : result.runtimes.find((item) => item.runtime === runtime)!;
const marginal = (result: RuntimeProjection) => {
  const totals: Record<string, number> = {};
  for (const item of [...result.runtimes, result.unassigned, result.overlap])
    for (const bucket of item.buckets)
      totals[bucket.activity] =
        (totals[bucket.activity] ?? 0) + bucket.durationMs;
  return totals;
};
describe("exclusive runtime occupancy", () => {
  it("splits an empty gap at mask edges", () => {
    const result = project({
      end: sec(30),
      runs: [{ id: "run", createdAt: sec(10), finishedAt: sec(20) }],
    });
    expect(slices(result)).toEqual([
      { start: 0, end: 10, activity: "UNKNOWN", runtime: "UNASSIGNED" },
      { start: 10, end: 20, activity: "UNKNOWN", runtime: "BROWSER" },
      { start: 20, end: 30, activity: "UNKNOWN", runtime: "UNASSIGNED" },
    ]);
    expect(part(result, "BROWSER").occupiedMs).toBe(sec(10));
    expect(result.ok).toBe(true);
    expect(marginal(result)).toEqual({ UNKNOWN: sec(30) });
  });
  it("counts analysis work over a browser queue as overlap and resumes the queue", () => {
    const result = project({
      runs: [{ id: "run", createdAt: sec(10), finishedAt: sec(30) }],
      spans: [
        {
          id: "state:execution_runs:run:1",
          lane: "run",
          label: "QUEUED",
          activity: "QUEUE",
          startedAt: sec(10),
          finishedAt: sec(30),
        },
        {
          id: "model:call",
          lane: "attempt",
          label: "model",
          activity: "MODEL",
          startedAt: sec(16),
          finishedAt: sec(24),
        },
      ],
      usages: [
        {
          id: "call",
          ownerId: "attempt",
          stage: "SPEC_ANALYSIS",
          scope: "EXECUTION",
          runId: null,
        },
      ],
    });
    expect(slices(result)).toEqual([
      { start: 0, end: 10, activity: "UNKNOWN", runtime: "UNASSIGNED" },
      { start: 10, end: 16, activity: "QUEUE", runtime: "BROWSER" },
      { start: 16, end: 24, activity: "MODEL", runtime: "OVERLAP" },
      { start: 24, end: 30, activity: "QUEUE", runtime: "BROWSER" },
    ]);
    expect(part(result, "UNASSIGNED").occupiedMs).toBe(sec(10));
    expect(part(result, "BROWSER").occupiedMs).toBe(sec(12));
    expect(part(result, "OVERLAP").occupiedMs).toBe(sec(8));
    expect(part(result, "SPEC_ANALYSIS").occupiedMs).toBe(0);
    expect(marginal(result)).toEqual({
      UNKNOWN: sec(10),
      QUEUE: sec(12),
      MODEL: sec(8),
    });
    expect(result.ok).toBe(true);
  });
  it("keeps TEST_ACCOUNTS_REQUIRED as mixed wait inside the browser runtime", () => {
    const spans = [
      {
        id: "state:task_case_executions:case:1",
        lane: "case",
        label: "TEST_ACCOUNTS_REQUIRED",
        activity: "QUEUE",
        startedAt: 0,
        finishedAt: sec(10),
      },
      {
        id: "state:task_executions:task:1",
        lane: "task",
        label: "TEST_ACCOUNTS_REQUIRED",
        activity: "HUMAN",
        startedAt: 0,
        finishedAt: sec(10),
      },
    ];
    const result = project({
      end: sec(10),
      analysisStageStatus: "SKIPPED",
      spans,
    });
    expect(slices(result)).toEqual([
      { start: 0, end: 10, activity: "MIXED_WAIT", runtime: "BROWSER" },
    ]);
    expect(spans.map((span) => span.activity)).toEqual(["QUEUE", "HUMAN"]);
    expect(part(result, "BROWSER").applicability).toBe("MEASURED");
    expect(part(result, "SPEC_ANALYSIS").applicability).toBe("NOT_APPLICABLE");
  });
  it("leaves deterministic and pre-claim queues unassigned", () => {
    const queue = {
      id: "state:task_executions:task:1",
      lane: "task",
      label: "QUEUED",
      activity: "QUEUE",
      startedAt: 0,
      finishedAt: sec(10),
      runtime: "SPEC_ANALYSIS",
    };
    const preClaim = project({
      end: sec(10),
      attempts: [
        {
          id: "attempt",
          stageType: "SPEC_ANALYSIS",
          executor: null,
          createdAt: 0,
          finishedAt: null,
        },
      ],
      spans: [queue],
    });
    expect(part(preClaim, "SPEC_ANALYSIS").applicability).toBe("NOT_STARTED");
    expect(slices(preClaim)).toEqual([
      { start: 0, end: 10, activity: "QUEUE", runtime: "UNASSIGNED" },
    ]);
    const claimed = project({
      ...preClaim,
      end: sec(10),
      attempts: [
        {
          id: "attempt",
          stageType: "SPEC_ANALYSIS",
          executor: "AGENT_RUNTIME",
          createdAt: 0,
          finishedAt: null,
        },
      ],
      spans: [queue],
    });
    expect(part(claimed, "SPEC_ANALYSIS")).toMatchObject({
      applicability: "MEASURED",
      occupiedMs: sec(10),
    });
    expect(slices(claimed)[0]?.runtime).toBe("SPEC_ANALYSIS");
    const deterministic = project({
      end: sec(10),
      attempts: [
        {
          id: "attempt",
          stageType: "SPEC_ANALYSIS",
          executor: "DETERMINISTIC",
          createdAt: 0,
          finishedAt: sec(10),
        },
      ],
      spans: [
        queue,
        {
          id: "model:call",
          lane: "attempt",
          label: "model",
          activity: "MODEL",
          startedAt: 0,
          finishedAt: sec(10),
          runtime: "SPEC_ANALYSIS",
        },
      ],
      usages: [
        {
          id: "call",
          ownerId: "attempt",
          stage: "SPEC_ANALYSIS",
          scope: "EXECUTION",
          runId: null,
        },
      ],
    });
    expect(part(deterministic, "SPEC_ANALYSIS")).toMatchObject({
      applicability: "NOT_APPLICABLE",
      occupiedMs: 0,
    });
    expect(
      slices(deterministic).every((item) => item.runtime === "UNASSIGNED"),
    ).toBe(true);
    const historical = project({
      end: sec(10),
      attempts: [
        {
          id: "attempt",
          stageType: "SPEC_ANALYSIS",
          executor: null,
          createdAt: 0,
          finishedAt: sec(10),
        },
      ],
      spans: [queue],
    });
    expect(part(historical, "SPEC_ANALYSIS").applicability).toBe("NOT_STARTED");
    expect(part(historical, "SPEC_ANALYSIS").occupiedMs).toBe(0);
  });
  it("includes an agent analysis input wait and not a deterministic one", () => {
    const wait = {
      id: "state:task_executions:task:1",
      lane: "task",
      label: "ANALYSIS_INPUT_REQUIRED",
      activity: "HUMAN",
      startedAt: sec(30),
      finishedAt: sec(50),
      runtime: "SPEC_ANALYSIS",
    };
    const agent = project({
      end: sec(50),
      attempts: [
        {
          id: "attempt",
          stageType: "SPEC_ANALYSIS",
          executor: "AGENT_RUNTIME",
          createdAt: 0,
          finishedAt: sec(30),
        },
      ],
      spans: [wait],
    });
    expect(slices(agent)).toContainEqual({
      start: 30,
      end: 50,
      activity: "HUMAN",
      runtime: "SPEC_ANALYSIS",
    });
    const deterministic = project({
      end: sec(50),
      attempts: [
        {
          id: "attempt",
          stageType: "SPEC_ANALYSIS",
          executor: "DETERMINISTIC",
          createdAt: 0,
          finishedAt: sec(30),
        },
      ],
      spans: [wait],
    });
    expect(slices(deterministic)).toContainEqual({
      start: 30,
      end: 50,
      activity: "HUMAN",
      runtime: "UNASSIGNED",
    });
    expect(part(deterministic, "SPEC_ANALYSIS").occupiedMs).toBe(0);
  });
  it("leaves the dispatch gap before the first run unassigned", () => {
    const result = project({
      end: sec(100),
      attempts: [
        {
          id: "attempt",
          stageType: "SPEC_ANALYSIS",
          executor: "AGENT_RUNTIME",
          createdAt: 0,
          finishedAt: sec(30),
        },
      ],
      runs: [{ id: "run", createdAt: sec(70), finishedAt: sec(100) }],
      spans: [
        {
          id: "state:task_executions:task:1",
          lane: "task",
          label: "PROFILE_LOGIN_REQUIRED",
          activity: "HUMAN",
          startedAt: sec(30),
          finishedAt: sec(60),
        },
      ],
    });
    expect(slices(result)).toEqual([
      { start: 0, end: 30, activity: "UNKNOWN", runtime: "SPEC_ANALYSIS" },
      { start: 30, end: 60, activity: "HUMAN", runtime: "UNASSIGNED" },
      { start: 60, end: 70, activity: "UNKNOWN", runtime: "UNASSIGNED" },
      { start: 70, end: 100, activity: "UNKNOWN", runtime: "BROWSER" },
    ]);
    expect(part(result, "BROWSER").applicability).toBe("MEASURED");
  });
  it("keeps in-run recovery unknown until a queue span exists", () => {
    const run = [{ id: "run", createdAt: 0, finishedAt: sec(30) }];
    const before = project({ end: sec(30), runs: run });
    expect(slices(before)).toEqual([
      { start: 0, end: 30, activity: "UNKNOWN", runtime: "BROWSER" },
    ]);
    const after = project({
      end: sec(30),
      runs: run,
      spans: [
        {
          id: "state:task_case_executions:case:1",
          lane: "run",
          label: "LEASE_RECOVERY",
          activity: "QUEUE",
          startedAt: sec(10),
          finishedAt: sec(20),
        },
      ],
    });
    expect(slices(after)).toEqual([
      { start: 0, end: 10, activity: "UNKNOWN", runtime: "BROWSER" },
      { start: 10, end: 20, activity: "QUEUE", runtime: "BROWSER" },
      { start: 20, end: 30, activity: "UNKNOWN", runtime: "BROWSER" },
    ]);
  });
  it("treats scheduled auth and profile holds as browser queue", () => {
    const result = project({
      end: sec(5),
      analysisStageStatus: "SUCCEEDED",
      spans: [
        {
          id: "state:task_case_executions:case:auth",
          lane: "case-auth",
          label: "AUTH_REQUIRED",
          activity: "QUEUE",
          startedAt: 0,
          finishedAt: sec(5),
        },
        {
          id: "state:task_case_executions:case:profile",
          lane: "case-profile",
          label: "PROFILE_RESERVED",
          activity: "QUEUE",
          startedAt: 0,
          finishedAt: sec(5),
        },
      ],
    });
    expect(slices(result)).toEqual([
      { start: 0, end: 5, activity: "QUEUE", runtime: "BROWSER" },
    ]);
    const profile = project({
      end: sec(5),
      spans: [
        {
          id: "state:task_executions:task:1",
          lane: "task",
          label: "DEPLOYMENT_TARGET_REQUIRED",
          activity: "HUMAN",
          startedAt: 0,
          finishedAt: sec(5),
          runtime: "BROWSER",
        },
      ],
    });
    expect(slices(profile)[0]).toMatchObject({
      activity: "HUMAN",
      runtime: "UNASSIGNED",
    });
  });
  it("measures a direct run and does not treat a compatibility lane as browser", () => {
    const direct = project({
      end: sec(10),
      analysisStageStatus: "SKIPPED",
      runs: [{ id: "run", createdAt: 0, finishedAt: sec(10) }],
    });
    expect(part(direct, "SPEC_ANALYSIS")).toMatchObject({
      applicability: "NOT_APPLICABLE",
      occupiedMs: 0,
    });
    expect(part(direct, "BROWSER")).toMatchObject({
      applicability: "MEASURED",
      occupiedMs: sec(10),
    });
    const adopted = project({
      taskId: "same",
      end: sec(30),
      analysisStageStatus: "SKIPPED",
      runs: [{ id: "same", createdAt: sec(-10), finishedAt: sec(20) }],
      spans: [
        {
          id: "tool:inside",
          lane: "same",
          label: "click",
          activity: "TOOL",
          startedAt: sec(5),
          finishedAt: sec(8),
        },
        {
          id: "tool:outside",
          lane: "same",
          label: "click",
          activity: "TOOL",
          startedAt: sec(22),
          finishedAt: sec(25),
        },
      ],
    });
    expect(adopted.elapsedMs).toBe(sec(30));
    expect(part(adopted, "SPEC_ANALYSIS").applicability).toBe("NOT_APPLICABLE");
    expect(part(adopted, "BROWSER").applicability).toBe("MEASURED");
    expect(slices(adopted)).toEqual([
      { start: 0, end: 5, activity: "UNKNOWN", runtime: "BROWSER" },
      { start: 5, end: 8, activity: "TOOL", runtime: "BROWSER" },
      { start: 8, end: 20, activity: "UNKNOWN", runtime: "BROWSER" },
      { start: 20, end: 22, activity: "UNKNOWN", runtime: "UNASSIGNED" },
      { start: 22, end: 25, activity: "TOOL", runtime: "UNASSIGNED" },
      { start: 25, end: 30, activity: "UNKNOWN", runtime: "UNASSIGNED" },
    ]);
    expect(part(adopted, "BROWSER").occupiedMs).toBe(sec(20));
  });
  it("does not let acceptance review extend elapsed time or occupancy", () => {
    const base = {
      end: sec(100),
      attempts: [
        {
          id: "attempt",
          stageType: "SPEC_ANALYSIS",
          executor: "AGENT_RUNTIME" as const,
          createdAt: 0,
          finishedAt: sec(10),
        },
      ],
      spans: [
        {
          id: "model:exec",
          lane: "attempt",
          label: "model",
          activity: "MODEL",
          startedAt: 0,
          finishedAt: sec(10),
        },
      ],
      usages: [
        {
          id: "exec",
          ownerId: "attempt",
          stage: "SPEC_ANALYSIS",
          scope: "EXECUTION",
          runId: null,
        },
      ],
    };
    const without = project(base);
    const withReview = project({
      ...base,
      spans: [
        ...base.spans,
        {
          id: "model:review",
          lane: "review",
          label: "review",
          activity: "MODEL",
          scope: "ACCEPTANCE_REVIEW",
          startedAt: sec(5),
          finishedAt: sec(130),
        },
      ],
    });
    expect(withReview.elapsedMs).toBe(without.elapsedMs);
    expect(withReview.segments).toEqual(without.segments);
    expect(part(withReview, "SPEC_ANALYSIS").occupiedMs).toBe(
      part(without, "SPEC_ANALYSIS").occupiedMs,
    );
    expect(withReview.elapsedMs).toBe(sec(100));
  });
  it("does not give a rounding tenth to a zero-length tag", () => {
    const result = project({
      end: sec(3),
      attempts: [
        {
          id: "attempt",
          stageType: "SPEC_ANALYSIS",
          executor: "AGENT_RUNTIME",
          createdAt: 0,
          finishedAt: sec(1),
        },
      ],
      runs: [{ id: "run", createdAt: sec(1), finishedAt: sec(2) }],
    });
    expect(part(result, "SPEC_ANALYSIS").percentage).toBeCloseTo(33.3);
    expect(part(result, "BROWSER").percentage).toBeCloseTo(33.3);
    expect(part(result, "UNASSIGNED").percentage).toBeCloseTo(33.4);
    expect(part(result, "OVERLAP").percentage).toBe(0);
    expect(part(result, "OVERLAP").buckets).toEqual([]);
    expect(part(result, "SPEC_ANALYSIS").buckets[0]?.percentage).toBe(100);
    expect(
      ["SPEC_ANALYSIS", "BROWSER", "UNASSIGNED", "OVERLAP"].reduce(
        (sum, tag) =>
          sum +
          (part(
            result,
            tag as "SPEC_ANALYSIS" | "BROWSER" | "UNASSIGNED" | "OVERLAP",
          ).percentage ?? 0),
        0,
      ),
    ).toBeCloseTo(100);
  });
  it("does not rebuild a failed revision on the next read", async () => {
    const computedAt = new Date(Date.now() - 60_000);
    const summary = {
      version: 1,
      runtimeAttribution: "FAILED",
      runtimeAttributionRevision: "7",
      taskId: "task",
      asOf: computedAt.toISOString(),
      computedAt: computedAt.toISOString(),
      refreshPending: false,
      elapsedMs: 5,
      activeMs: 0,
      waitingMs: 0,
      timingQuality: "UNAVAILABLE",
      buckets: [],
      models: [],
      totals: {
        calls: 0,
        input: { known: "0", reportedCalls: 0, missingCalls: 0 },
        output: { known: "0", reportedCalls: 0, missingCalls: 0 },
        cacheRead: { known: "0", reportedCalls: 0, missingCalls: 0 },
        total: { known: "0", reportedCalls: 0, missingCalls: 0 },
        coverage: "COMPLETE",
      },
      reviewStatus: null,
      reviewDurationMs: 0,
      phases: [],
    };
    let reads = 0;
    const increments: string[] = [];
    const service = new TaskMetricsService(
      {
        taskExecution: {
          findFirst: async () => {
            reads += 1;
            return {
              lifecycle: "RUNNING",
              metrics: {
                computedAt,
                dirty: false,
                revision: 7n,
                summary,
                historyBackfilled: true,
              },
            };
          },
        },
      } as never,
      { increment: (name: string) => increments.push(name) } as never,
    );
    const first = await service.summary("team", "task");
    const second = await service.summary("team", "task");
    expect(first).toBe(summary);
    expect(second.version).toBe(1);
    expect(second.runtimes).toBeUndefined();
    expect(reads).toBe(2);
    expect(increments).toEqual([]);
    const mismatched = new TaskMetricsService(
      {
        taskExecution: {
          findFirst: async () => ({
            lifecycle: "RUNNING",
            metrics: {
              computedAt,
              dirty: false,
              revision: 8n,
              summary,
              historyBackfilled: true,
            },
          }),
        },
      } as never,
      { increment: () => undefined } as never,
    );
    await expect(mismatched.summary("team", "task")).rejects.toThrow();
  });
});
