import { describe, expect, it } from "vitest";
import { planDiffDispatch } from "./task-diff-dispatch.js";
import type { DiffDispatchCandidate } from "./task-diff-dispatch.js";

const cases = [
  { id: "case-a", definitionHash: "hash-a" },
  { id: "case-b", definitionHash: "hash-b" },
  { id: "case-c", definitionHash: "hash-c" },
];
const deployments = [{ id: "deploy-1" }, { id: "deploy-2" }];

const candidate = (
  id: string,
  definitionHash: string,
  deploymentId: string,
  run: DiffDispatchCandidate["run"],
): DiffDispatchCandidate => ({
  id,
  caseId: `prev-${id}`,
  deploymentId,
  definitionHash,
  run,
});

const cleanRun = {
  lifecycle: "COMPLETED",
  executionDisposition: "EXECUTED",
  writeOutcomeUnknown: false,
};

describe("planDiffDispatch", () => {
  it("carries unchanged Cases with clean terminal runs", () => {
    const planned = planDiffDispatch("task", cases, deployments, [
      candidate("e1", "hash-a", "deploy-1", cleanRun),
      candidate("e2", "hash-a", "deploy-2", cleanRun),
    ]);
    expect(planned.carriedCount).toBe(2);
    expect(planned.dispatchedCount).toBe(4);
    const carried = planned.rows.filter(
      (row) => row.dispatchStatus === "CARRIED_OVER",
    );
    expect(carried.map((row) => row.caseId)).toEqual(["case-a", "case-a"]);
    expect(carried.map((row) => row.carriedFromExecutionId)).toEqual([
      "e1",
      "e2",
    ]);
    expect(carried[0]?.taskExecutionId).toBe("task");
  });

  it("dispatches changed and new Cases normally", () => {
    const planned = planDiffDispatch("task", cases, deployments, [
      candidate("e1", "hash-a", "deploy-1", cleanRun),
    ]);
    // case-a/deploy-1 carried; case-a/deploy-2, case-b, case-c dispatched.
    expect(planned.carriedCount).toBe(1);
    expect(planned.dispatchedCount).toBe(5);
    expect(
      planned.rows.filter((row) => row.dispatchStatus === "CARRIED_OVER"),
    ).toHaveLength(1);
  });

  it("does not carry incomplete or blocked runs", () => {
    const planned = planDiffDispatch("task", cases, deployments, [
      candidate("e1", "hash-a", "deploy-1", {
        lifecycle: "CANCELLED",
        executionDisposition: null,
        writeOutcomeUnknown: false,
      }),
      candidate("e2", "hash-a", "deploy-2", {
        lifecycle: "COMPLETED",
        executionDisposition: "BLOCKED",
        writeOutcomeUnknown: false,
      }),
      candidate("e3", "hash-b", "deploy-1", {
        lifecycle: "COMPLETED",
        executionDisposition: "EXECUTED",
        writeOutcomeUnknown: true,
      }),
      candidate("e4", "hash-b", "deploy-2", null),
    ]);
    expect(planned.carriedCount).toBe(0);
    expect(planned.dispatchedCount).toBe(6);
  });

  it("consumes each candidate at most once", () => {
    const planned = planDiffDispatch("task", cases, deployments, [
      candidate("e1", "hash-a", "deploy-1", cleanRun),
    ]);
    const carried = planned.rows.filter(
      (row) => row.dispatchStatus === "CARRIED_OVER",
    );
    expect(new Set(carried.map((row) => row.carriedFromExecutionId)).size).toBe(
      carried.length,
    );
  });

  it("uses the ordinary matrix when there are no candidates", () => {
    const planned = planDiffDispatch("task", cases, deployments, []);
    expect(planned.carriedCount).toBe(0);
    expect(planned.dispatchedCount).toBe(cases.length * deployments.length);
    expect(planned.rows.every((row) => row.dispatchStatus === undefined)).toBe(
      true,
    );
  });
});
