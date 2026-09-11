import { describe, expect, it } from "vitest";
import { projectSpecGenerationTrajectory } from "./spec-generation-trajectory";
import type { TaskDetail, TaskEvent } from "./task-types";

describe("Spec log chronology", () => {
  it("does not backdate completion events by their measured duration", () => {
    const detail = {
      stages: [],
      createdAt: "2026-09-11T00:00:00Z",
      input: {},
    } as unknown as TaskDetail;
    const events = [
      {
        sequence: "9",
        kind: "agent.tool.started",
        occurredAt: "2026-09-11T00:00:02Z",
        payload: { stage: "SPEC_ANALYSIS", callId: "a" },
      },
      {
        sequence: "10",
        kind: "agent.tool.completed",
        occurredAt: "2026-09-11T00:00:03Z",
        payload: {
          stage: "SPEC_ANALYSIS",
          callId: "a",
          durationMs: 5000,
          status: "TIMED_OUT",
        },
      },
    ] as TaskEvent[];
    const result = projectSpecGenerationTrajectory(detail, events);
    expect(result.map((row) => row.id)).toEqual(["task:9", "task:10"]);
    expect(result[1]).toMatchObject({
      status: "FAILED",
      durationMs: 5000,
      startedAt: events[1]!.occurredAt,
    });
    events[1]!.occurredAt = events[0]!.occurredAt;
    expect(
      projectSpecGenerationTrajectory(detail, [...events].reverse()).map(
        (row) => row.id,
      ),
    ).toEqual(["task:9", "task:10"]);
  });
});

const detail = {
  createdAt: "2026-09-11T00:00:00Z",
  input: { issue: "DEV-1" },
  stages: [
    {
      type: "SPEC_ANALYSIS",
      status: "SUCCEEDED",
      attempts: [
        {
          id: "analysis-1",
          number: 1,
          startedAt: "2026-09-11T00:00:01Z",
          finishedAt: "2026-09-11T00:00:04Z",
          error: null,
          result: { caseCount: 1 },
          status: "SUCCEEDED",
        },
      ],
    },
  ],
} as TaskDetail;
const event = (
  sequence: string,
  kind: string,
  payload: unknown,
  occurredAt = "2026-09-11T00:00:02Z",
): TaskEvent => ({ sequence, kind, payload, occurredAt, actor: "WORKER" });

describe("task Spec trajectory", () => {
  it("keeps Spec records and analysis attempts without including execution events", () => {
    const records = projectSpecGenerationTrajectory(detail, [
      event("1", "task.created", { issue: "DEV-1" }, detail.createdAt),
      event("2", "agent.tool.completed", {
        stage: "SPEC_ANALYSIS",
        name: "read_issue",
        durationMs: 500,
        outputPreview: { title: "登录" },
      }),
      event("3", "task.stage.started", { stage: "SPEC_EXECUTION" }),
      event("4", "agent.tool.completed", {
        stage: "SPEC_EXECUTION",
        name: "click",
      }),
    ]);
    expect(records).toHaveLength(3);
    expect(records.map((item) => item.id)).toEqual([
      "task:1",
      "analysis:analysis-1",
      "task:2",
    ]);
    expect(records.map((item) => item.sequence)).toEqual(["1", "2", "3"]);
    expect(records[2]).toMatchObject({
      kind: "TOOL",
      durationMs: 500,
      status: "SUCCEEDED",
      output: { title: "登录" },
    });
    expect(records[1]).toMatchObject({
      input: { issue: "DEV-1" },
      output: { caseCount: 1 },
      durationMs: 3000,
    });
  });

  it("retains cancellation in an unfinished analysis log", () => {
    const records = projectSpecGenerationTrajectory({ ...detail, stages: [] }, [
      event("1", "task.cancel_requested", {}),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("task:1");
  });
});
