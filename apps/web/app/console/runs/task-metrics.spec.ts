import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  RuntimeApplicability,
  TaskMetrics,
  TaskRuntimeKind,
  TaskRuntimeResidual,
  TaskRuntimeTiming,
  TaskTimingBucket,
  TokenMetric,
} from "@devproof/contracts";
import { TaskRuntimeSplit } from "./task-metrics";

const tokens: TokenMetric = { known: "0", reportedCalls: 0, missingCalls: 0 };
const modelBucket: TaskTimingBucket = {
  activity: "MODEL",
  durationMs: 40_000,
  percentage: 100,
};

function residual(
  occupiedMs: number,
  percentage: number | null,
  buckets: TaskTimingBucket[] = [],
): TaskRuntimeResidual {
  return {
    occupiedMs,
    percentage,
    activeMs: 0,
    waitingMs: occupiedMs,
    unknownMs: 0,
    buckets,
  };
}
function timing(
  runtime: TaskRuntimeKind,
  applicability: RuntimeApplicability,
  occupiedMs = 0,
  percentage: number | null = 0,
  buckets: TaskTimingBucket[] = [],
): TaskRuntimeTiming {
  return {
    runtime,
    applicability,
    occupiedMs,
    percentage,
    activeMs: occupiedMs,
    waitingMs: 0,
    unknownMs: 0,
    buckets,
    cumulative: { modelMs: 0, toolMs: 0, platformMs: 0, recoveryMs: 0 },
  };
}
function metrics(overrides: Partial<TaskMetrics> = {}): TaskMetrics {
  return {
    taskId: "task",
    asOf: "2026-09-22T00:00:00.000Z",
    computedAt: "2026-09-22T00:00:00.000Z",
    refreshPending: false,
    version: 2,
    elapsedMs: 100_000,
    activeMs: 40_000,
    waitingMs: 60_000,
    timingQuality: "PARTIAL",
    buckets: [{ activity: "MODEL", durationMs: 40_000, percentage: 40 }],
    models: [],
    totals: {
      input: tokens,
      output: tokens,
      cacheRead: tokens,
      total: tokens,
      coverage: "COMPLETE",
      calls: 0,
    },
    reviewStatus: "SUCCEEDED",
    reviewDurationMs: 9_000,
    phases: [],
    runtimes: [
      timing("SPEC_ANALYSIS", "MEASURED", 40_000, 40, [modelBucket]),
      timing("BROWSER", "MEASURED", 50_000, 50, [
        { activity: "TOOL", durationMs: 50_000, percentage: 100 },
      ]),
    ],
    unassigned: residual(10_000, 10, [
      { activity: "QUEUE", durationMs: 10_000, percentage: 100 },
    ]),
    overlap: residual(0, 0),
    ...overrides,
  };
}
function render(value: TaskMetrics) {
  return renderToStaticMarkup(
    createElement(TaskRuntimeSplit, { metrics: value }),
  );
}
function section(html: string, label: string) {
  return html.match(
    new RegExp(`aria-label="${label}"[\\s\\S]*?</section>`),
  )?.[0];
}

describe("task runtime occupancy", () => {
  it.each([
    {
      runtime: "SPEC_ANALYSIS" as const,
      applicability: "MEASURED" as const,
      text: "按执行者记录",
      occupiedMs: 40_000,
      percentage: 40,
    },
    {
      runtime: "SPEC_ANALYSIS" as const,
      applicability: "PARTIAL" as const,
      text: "执行者未记录，边界来自已有模型/工具调用",
      occupiedMs: 40_000,
      percentage: 40,
    },
    {
      runtime: "SPEC_ANALYSIS" as const,
      applicability: "NOT_APPLICABLE" as const,
      text: "分析阶段已跳过、阶段不存在，或只有确定性生成",
      occupiedMs: 0,
      percentage: 0,
    },
    {
      runtime: "SPEC_ANALYSIS" as const,
      applicability: "NOT_STARTED" as const,
      text: "尚未开始 Spec 分析",
      occupiedMs: 0,
      percentage: 0,
    },
    {
      runtime: "BROWSER" as const,
      applicability: "NOT_STARTED" as const,
      text: "尚未进入浏览器执行",
      occupiedMs: 0,
      percentage: 0,
    },
  ])(
    "renders $applicability for $runtime without copying timing quality",
    ({ runtime, applicability, text, occupiedMs, percentage }) => {
      const buckets = occupiedMs > 0 ? [modelBucket] : [];
      const html = render(
        metrics({
          timingQuality: "PARTIAL",
          runtimes: [
            timing(
              "SPEC_ANALYSIS",
              runtime === "SPEC_ANALYSIS" ? applicability : "MEASURED",
              runtime === "SPEC_ANALYSIS" ? occupiedMs : 40_000,
              runtime === "SPEC_ANALYSIS" ? percentage : 40,
              runtime === "SPEC_ANALYSIS" ? buckets : [modelBucket],
            ),
            timing(
              "BROWSER",
              runtime === "BROWSER" ? applicability : "MEASURED",
              runtime === "BROWSER" ? occupiedMs : 50_000,
              runtime === "BROWSER" ? percentage : 50,
              runtime === "BROWSER"
                ? buckets
                : [{ activity: "TOOL", durationMs: 50_000, percentage: 100 }],
            ),
          ],
        }),
      );
      const label =
        runtime === "SPEC_ANALYSIS" ? "Spec 分析 Runtime" : "浏览器 Runtime";
      const block = section(html, label);
      expect(block).toContain(text);
      expect(block).toContain(`占任务总耗时 ${percentage}%`);
      expect(block).not.toContain("时间记录不完整");
      expect(block).not.toContain("运行节点时间采用估计对齐");
      expect(html).not.toContain("验收");
      if (occupiedMs > 0) {
        expect(block).toContain("条内百分比的分母是该占用，不是任务总耗时。");
        expect(block).toContain("width:100%");
        expect(block).not.toContain(`width:${percentage}%`);
      } else {
        expect(block).not.toContain("条内百分比的分母是该占用");
      }
    },
  );

  it("shows unassigned time and hides a zero overlap", () => {
    const html = render(metrics());
    const unassigned = section(html, "未归属");
    expect(unassigned).toContain(
      "身份准备、确定性 Spec 生成、尚未领取的分析排队",
    );
    expect(unassigned).toContain("活动是“未能归因”，不是未归属，也不是排队。");
    expect(unassigned).toContain("条内百分比的分母是该占用，不是任务总耗时。");
    expect(unassigned).toContain("width:100%");
    expect(unassigned).not.toContain("width:10%");
    expect(html).toContain("阶段起止不是 Runtime 占用。");
    expect(html).not.toContain('aria-label="重叠"');
  });

  it("shows overlap only when both runtimes occupy the same time", () => {
    const html = render(
      metrics({
        overlap: residual(8_000, 8, [
          { activity: "MODEL", durationMs: 8_000, percentage: 100 },
        ]),
      }),
    );
    const overlap = section(html, "重叠");
    expect(overlap).toContain("占任务总耗时 8%");
    expect(overlap).toContain(
      "两个 Runtime 同时在工作，或一个 Runtime 的工作盖住另一个 Runtime 的等待。",
    );
    expect(overlap).toContain("同一 Runtime 里的并行用例不算重叠。");
    expect(overlap).toContain("width:100%");
    expect(overlap).not.toContain("width:8%");
  });

  it.each([
    { name: "version 1", value: metrics({ version: 1 }) },
    {
      name: "failed attribution",
      value: metrics({
        version: 1,
        runtimes: undefined,
        unassigned: undefined,
        overlap: undefined,
      }),
    },
    {
      name: "version 2 without a split",
      value: metrics({
        runtimes: undefined,
        unassigned: undefined,
        overlap: undefined,
      }),
    },
  ])("does not invent zeros when $name", ({ value }) => {
    expect(render(value)).toBe("");
  });
});
