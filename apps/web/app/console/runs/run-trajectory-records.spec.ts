import { describe, expect, it } from "vitest";
import type { RunTrajectoryRecord } from "@devproof/contracts";
import { mergeTrajectoryRecords } from "./run-trajectory-records";

function model(
  id: string,
  sequence: string,
  extra: Partial<RunTrajectoryRecord> = {},
): RunTrajectoryRecord {
  return {
    id,
    sequence,
    actor: "AGENT_RUNTIME",
    attemptNumber: 1,
    callId: null,
    completedAt: null,
    durationMs: null,
    error: null,
    input: null,
    kind: "MODEL",
    lane: "MODEL",
    metadata: {},
    output: null,
    segmentId: "segment",
    startedAt: "2026-09-10T08:01:41.000Z",
    status: "RUNNING",
    step: 1,
    title: "provider / model",
    ...extra,
  };
}

describe("live trajectory reconciliation", () => {
  it("replaces a live call with its completion across page rollover without resurrecting an older start", () => {
    const start = model("call", "9007199254740993");
    const end = model("call", "9007199254740995", {
      status: "SUCCEEDED",
      completedAt: "2026-09-10T08:02:12.000Z",
    });
    expect(mergeTrajectoryRecords([start], [end], [start])).toEqual([end]);
  });
  it("ends retained in-flight calls when a later page reports their segment interruption", () => {
    const start = model("call", "1");
    const other = model("other", "3", { segmentId: "other-segment" });
    const end = model("end", "1000", {
      kind: "RUNTIME",
      lane: "INPUT",
      title: "agent.segment.completed",
      status: "FAILED",
      completedAt: "2026-09-10T08:02:12.000Z",
      error: "Runtime deployment interrupted execution",
    });
    const records = mergeTrajectoryRecords([start, other], [end]);
    expect(records[0]).toMatchObject({
      id: "call",
      status: "FAILED",
      durationMs: 31_000,
      error: end.error,
    });
    expect(records[1]).toEqual(other);
  });
  it("keeps a later fallback running after a prior candidate failed on the same step", () => {
    const failed = model("first", "2", { status: "FAILED" });
    const fallback = model("second", "3");
    expect(mergeTrajectoryRecords([failed], [fallback])).toEqual([
      failed,
      fallback,
    ]);
  });
});
