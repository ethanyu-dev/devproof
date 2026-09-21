import { describe, expect, it } from "vitest";
import {
  normalizeUsage,
  summarizeModels,
  timingBuckets,
  usageTotals,
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
