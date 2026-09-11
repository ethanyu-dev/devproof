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
