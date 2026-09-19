import { describe, expect, it } from "vitest";
import { executionVerification } from "./execution-cleanup.js";

function fixture() {
  return {
    lifecycle: "COMPLETED",
    executionDisposition: "BLOCKED" as const,
    verdict: null,
    currentAttemptNumber: 1,
    attempts: [{ id: "current", number: 1, error: null as unknown }],
    tasks: [
      {
        attemptId: "current",
        error: null as unknown,
        result: {
          kind: "VERIFICATION_COMPLETED",
          executionDisposition: "EXECUTED",
          verdict: "PASSED",
          cleanup: { status: "BLOCKED", note: "待核对恢复结果" },
          termination: undefined as unknown,
        },
      },
    ],
  };
}

describe("historical cleanup-only verification projection", () => {
  it.each(["PASSED", "FAILED", "INCONCLUSIVE"])(
    "preserves the recorded %s verdict",
    (verdict) => {
      const run = fixture();
      run.tasks[0]!.result.verdict = verdict;
      expect(executionVerification(run)).toEqual({
        executionDisposition: "EXECUTED",
        verdict,
      });
      expect(run.executionDisposition).toBe("BLOCKED");
    },
  );
  it.each([
    "termination",
    "task-error",
    "attempt-error",
    "old-attempt",
    "timeout",
    "fatal",
  ])("does not bypass %s", (reason) => {
    const run = fixture();
    if (reason === "termination")
      run.tasks[0]!.result.termination = { reason: "TOOL_LIMIT_REACHED" };
    if (reason === "task-error")
      run.tasks[0]!.error = { code: "WRITE_OUTCOME_UNKNOWN" };
    if (reason === "attempt-error") run.attempts[0]!.error = { code: "FAILED" };
    if (reason === "old-attempt") run.tasks[0]!.attemptId = "old";
    if (reason === "timeout") run.lifecycle = "TIMED_OUT";
    if (reason === "fatal") run.tasks[0]!.result.kind = "FATAL_FAILURE";
    expect(executionVerification(run)).toEqual({
      executionDisposition: "BLOCKED",
      verdict: null,
    });
  });
});
