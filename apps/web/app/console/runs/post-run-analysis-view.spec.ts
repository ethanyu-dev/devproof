import { describe, expect, it } from "vitest";

import {
  aggregateAnalysisEvents,
  analysisEventMatches,
  mergePostRunAnalysisEventPage,
} from "./post-run-analysis-view";
import type { PostRunAnalysisEvent } from "./task-types";

describe("post-run analysis event presentation", () => {
  it("merges model start and completion into one meaningful turn", () => {
    const groups = aggregateAnalysisEvents([
      event(10, "analysis.model.started", {
        callId: "call-1",
        model: "xai/grok-4.6",
        turn: 12,
      }),
      event(11, "analysis.model.completed", {
        action: "READ_EVIDENCE",
        callId: "call-1",
        durationMs: 7_100,
        model: "xai/grok-4.6",
        purpose: "核验异常相关证据",
        turn: 12,
        usage: { input_tokens: 4_990, output_tokens: 195 },
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      meta: "xai/grok-4.6 · 7.1 秒 · 4,990 输入 / 195 输出",
      summary: "核验异常相关证据",
      title: "第 12 轮模型分析完成",
    });
    expect(groups[0]?.events).toHaveLength(2);
  });

  it("groups adjacent evidence reads and filters technical categories", () => {
    const evidence = event(20, "analysis.evidence.read", {
      attemptNumber: 2,
      commandType: "CLICK",
      evidenceRef: "browser-command://failed-1",
      runId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
    });
    expect(aggregateAnalysisEvents([evidence])[0]).toMatchObject({
      summary:
        "已核验证据 browser-command://failed-1（CLICK · Run 9be3dc23 · Attempt #2）。",
    });
    const groups = aggregateAnalysisEvents([
      event(19, "analysis.evidence.served", {
        evidenceRef: "browser-command://failed-1",
      }),
      evidence,
      event(21, "analysis.evidence.served", {
        evidenceRef: "browser-command://failed-2",
      }),
      event(22, "analysis.evidence.read", {
        evidenceRef: "browser-command://failed-2",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      meta: "2 次读取 · 2 条证据",
      title: "批量核验证据",
    });
    expect(analysisEventMatches(evidence, "EVIDENCE")).toBe(true);
    expect(analysisEventMatches(evidence, "MODEL")).toBe(false);
    expect(
      analysisEventMatches(
        event(23, "analysis.report.validation_failed", {}),
        "ERROR",
      ),
    ).toBe(true);
  });

  it("rejects an event page from a stale category or analysis", () => {
    const current = {
      analysisId: "analysis-1",
      category: "ERROR" as const,
      events: [event(30, "analysis.model.failed", {})],
      hasMore: true,
      nextBeforeSequence: "30",
    };
    const incoming = {
      analysisId: "analysis-1",
      category: "MODEL" as const,
      events: [event(20, "analysis.model.completed", {})],
      hasMore: false,
      nextBeforeSequence: "20",
    };

    expect(
      mergePostRunAnalysisEventPage(current, incoming, {
        analysisId: "analysis-1",
        category: "ERROR",
      }),
    ).toBe(current);
    expect(
      mergePostRunAnalysisEventPage(null, incoming, {
        analysisId: "analysis-2",
        category: "MODEL",
      }),
    ).toBeNull();
  });
});

function event(
  sequence: number,
  kind: string,
  payload: unknown,
): PostRunAnalysisEvent {
  return {
    actor: "AGENT_RUNTIME",
    kind,
    occurredAt: `2026-09-01T05:40:${sequence}.000Z`,
    payload,
    sequence: String(sequence),
  };
}
