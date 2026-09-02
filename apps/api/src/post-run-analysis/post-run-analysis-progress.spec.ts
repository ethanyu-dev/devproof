import { describe, expect, it } from "vitest";

import { buildPostRunAnalysisProgress } from "./post-run-analysis-progress.js";

describe("buildPostRunAnalysisProgress", () => {
  it("summarizes every analysis event instead of relying on the display page", () => {
    const now = new Date("2026-09-01T05:45:00.000Z");
    const occurredAt = new Date("2026-09-01T05:40:00.000Z");
    const progress = buildPostRunAnalysisProgress(
      {
        createdAt: new Date("2026-09-01T05:18:00.000Z"),
        deadlineAt: new Date("2026-09-01T06:10:00.000Z"),
        error: null,
        findings: [],
        finishedAt: null,
        hardDeadlineAt: new Date("2026-09-01T07:18:00.000Z"),
        inputSha256: "a".repeat(64),
        nextAttemptAt: null,
        readyAt: new Date("2026-09-01T05:18:10.000Z"),
        startedAt: occurredAt,
        status: "RUNNING",
        updatedAt: occurredAt,
      },
      [
        event(1, "analysis.started", { queueWaitMs: 1_310_000 }),
        event(2, "analysis.model.started", {
          callId: "call-1",
          model: "xai/grok-4.6",
          turn: 1,
        }),
        event(3, "analysis.model.completed", {
          action: "READ_EVIDENCE",
          callId: "call-1",
          durationMs: 7_000,
          model: "xai/grok-4.6",
          purpose: "核验异常相关证据",
          turn: 1,
          usage: {
            input_tokens: 4_990,
            output_tokens: 195,
            total_tokens: 5_185,
          },
        }),
        event(4, "analysis.evidence.read", {
          evidenceRef: "browser-command://failed-command",
        }),
        event(5, "analysis.report.validation_failed", {
          findingCount: 1,
        }),
      ],
      now,
    );

    expect(progress).toMatchObject({
      activeElapsedMs: 299_000,
      currentMessage: "分析报告校验未通过，正在补充证据或修正定位。",
      currentAttemptElapsedMs: 299_000,
      deadlineRemainingMs: 1_500_000,
      metrics: {
        evidenceReads: 1,
        inputTokens: 4_990,
        modelCalls: 1,
        modelDurationMs: 7_000,
        outputTokens: 195,
        reportValidationFailures: 1,
        uniqueEvidence: 1,
      },
      phase: "REPORTING",
      lifecycleElapsedMs: 1_620_000,
      queueWaitMs: 1_310_000,
      steps: [
        { key: "CAPTURE", label: "采集日志", status: "COMPLETED" },
        { key: "QUEUE", label: "等待调度", status: "COMPLETED" },
        { key: "INDEXING", label: "读取索引", status: "COMPLETED" },
        { key: "EVIDENCE", label: "核验证据", status: "COMPLETED" },
        { key: "REPORTING", label: "生成报告", status: "ACTIVE" },
        { key: "PERSISTING", label: "保存结果", status: "PENDING" },
      ],
    });
  });

  it("describes the execution context of the evidence currently being checked", () => {
    const occurredAt = new Date("2026-09-01T05:40:00.000Z");
    const progress = buildPostRunAnalysisProgress(
      {
        createdAt: occurredAt,
        deadlineAt: new Date("2026-09-01T06:10:00.000Z"),
        error: null,
        findings: [],
        finishedAt: null,
        hardDeadlineAt: new Date("2026-09-01T07:18:00.000Z"),
        inputSha256: "a".repeat(64),
        nextAttemptAt: null,
        readyAt: occurredAt,
        startedAt: occurredAt,
        status: "RUNNING",
        updatedAt: occurredAt,
      },
      [
        event(1, "analysis.evidence.read", {
          attemptNumber: 2,
          commandType: "CLICK",
          evidenceRef: "browser-command://failed-command",
          runId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
        }),
      ],
      new Date("2026-09-01T05:45:00.000Z"),
    );

    expect(progress.currentMessage).toBe(
      "正在核验证据 browser-command://failed-command（CLICK · Run 9be3dc23 · Attempt #2）。",
    );
  });

  it("scopes the active phase and queue timing to the latest attempt", () => {
    const occurredAt = new Date("2026-09-01T05:40:00.000Z");
    const progress = buildPostRunAnalysisProgress(
      {
        createdAt: occurredAt,
        deadlineAt: new Date("2026-09-01T06:10:00.000Z"),
        error: null,
        findings: [],
        finishedAt: null,
        hardDeadlineAt: new Date("2026-09-01T07:18:00.000Z"),
        inputSha256: "a".repeat(64),
        nextAttemptAt: null,
        readyAt: occurredAt,
        startedAt: occurredAt,
        status: "RUNNING",
        updatedAt: occurredAt,
      },
      [
        event(1, "analysis.started", {
          attemptNumber: 1,
          queueWaitMs: 20_000,
        }),
        event(2, "analysis.report.generated", { findingCount: 1 }),
        event(3, "analysis.retry_queued", { attemptNumber: 1 }),
        event(4, "analysis.started", {
          attemptNumber: 2,
          queueWaitMs: 5_000,
        }),
        event(5, "analysis.model.started", {
          callId: "attempt-2-call-1",
          model: "xai/grok-4.6",
          phase: "EVIDENCE_DISCOVERY",
          turn: 1,
        }),
      ],
      new Date("2026-09-01T05:45:00.000Z"),
    );

    expect(progress).toMatchObject({
      activeElapsedMs: 298_000,
      attempts: [
        expect.objectContaining({
          attemptNumber: 1,
          elapsedMs: 2_000,
          status: "RETRYING",
        }),
        expect.objectContaining({
          attemptNumber: 2,
          elapsedMs: 296_000,
          metrics: expect.objectContaining({ modelCalls: 1 }),
          status: "RUNNING",
        }),
      ],
      currentMessage: "正在进行第 1 轮模型分析（xai/grok-4.6）。",
      currentAttemptElapsedMs: 296_000,
      lifecycleElapsedMs: 300_000,
      phase: "EVIDENCE",
      queueWaitMs: 5_000,
      steps: expect.arrayContaining([
        { key: "EVIDENCE", label: "核验证据", status: "ACTIVE" },
        { key: "PERSISTING", label: "保存结果", status: "PENDING" },
      ]),
    });
  });

  it("does not count time between retry attempts as active analysis", () => {
    const progress = buildPostRunAnalysisProgress(
      {
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        deadlineAt: new Date("2026-09-02T02:00:00.000Z"),
        error: null,
        findings: [],
        finishedAt: null,
        hardDeadlineAt: new Date("2026-09-02T08:00:00.000Z"),
        inputSha256: "a".repeat(64),
        nextAttemptAt: null,
        readyAt: new Date("2026-09-02T00:00:00.000Z"),
        startedAt: new Date("2026-09-01T00:01:00.000Z"),
        status: "RUNNING",
        updatedAt: new Date("2026-09-02T00:02:00.000Z"),
      },
      [
        {
          kind: "analysis.started",
          occurredAt: new Date("2026-09-01T00:01:00.000Z"),
          payload: { attemptNumber: 1 },
          sequence: 1n,
        },
        {
          kind: "analysis.retry_queued",
          occurredAt: new Date("2026-09-01T00:11:00.000Z"),
          payload: { attemptNumber: 1 },
          sequence: 2n,
        },
        {
          kind: "analysis.started",
          occurredAt: new Date("2026-09-02T00:01:00.000Z"),
          payload: { attemptNumber: 2 },
          sequence: 3n,
        },
      ],
      new Date("2026-09-02T00:06:00.000Z"),
    );

    expect(progress.activeElapsedMs).toBe(15 * 60_000);
    expect(progress.currentAttemptElapsedMs).toBe(5 * 60_000);
    expect(progress.lifecycleElapsedMs).toBe(24 * 60 * 60_000 + 6 * 60_000);
    expect(progress.elapsedMs).toBe(progress.activeElapsedMs);
  });
});

function event(sequence: number, kind: string, payload: unknown) {
  return {
    kind,
    occurredAt: new Date(`2026-09-01T05:40:0${sequence}.000Z`),
    payload,
    sequence: BigInt(sequence),
  };
}
