import { describe, expect, it } from "vitest";
import { currentRunFailures, summarizeTaskFailures } from "./run-failure";

const originalError = {
  code: "REPEATED_OPERATIONS",
  message: "重复操作未产生进展。\n多条验收尚未完成。",
};
const wrapped = {
  code: "WRITE_OUTCOME_UNKNOWN",
  message: "Possible write; reconcile before retrying.",
  details: { originalError },
};

describe("execution failure reason", () => {
  it("shows the original stop reason separately from the write-result guard", () => {
    const failure = summarizeTaskFailures([{ error: wrapped }])[0]!;
    expect(failure.code).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(failure.causeCode).toBe("REPEATED_OPERATIONS");
    expect(failure.message).toContain("未产生新的页面观察或验收进展");
    expect(failure.raw).toContain("WRITE_OUTCOME_UNKNOWN");
  });
  it("preserves the cause through nested recovery wrappers", () => {
    const failure = summarizeTaskFailures([
      { error: { ...wrapped, details: { originalError: wrapped } } },
    ])[0]!;
    expect(failure.causeCode).toBe("REPEATED_OPERATIONS");
  });
  it("does not invent which service caused fetch failed", () => {
    const failure = summarizeTaskFailures([
      {
        error: {
          ...wrapped,
          details: {
            originalError: {
              code: "AGENT_EXECUTION_FAILED",
              message: "fetch failed",
            },
          },
        },
      },
    ])[0]!;
    expect(failure.message).toContain("未提供更具体");
    expect(failure.message).not.toMatch(/浏览器离线|模型服务断开/);
  });
  it("keeps distinct causes even when the outer recovery code is identical", () => {
    expect(
      summarizeTaskFailures([
        { error: wrapped },
        {
          error: {
            ...wrapped,
            details: {
              originalError: { code: "TOOL_LIMIT_REACHED", message: "limit" },
            },
          },
        },
      ]),
    ).toHaveLength(2);
  });
  it("uses only the current attempt and falls back to browser execution errors", () => {
    const detail = {
      currentAttemptNumber: 2,
      attempts: [
        { id: "old", number: 1, error: wrapped },
        { id: "new", number: 2, error: null },
      ],
      tasks: [{ attemptId: "old", error: wrapped }],
      browserExecutions: [
        {
          attemptId: "new",
          error: { code: "COMMAND_TIMEOUT", message: "timeout" },
        },
      ],
    };
    expect(currentRunFailures(detail)[0]!.causeCode).toBe("COMMAND_TIMEOUT");
    detail.browserExecutions = [];
    expect(currentRunFailures(detail)).toEqual([]);
    expect(currentRunFailures({ ...detail, currentAttemptNumber: 3 })).toEqual(
      [],
    );
    expect(currentRunFailures(detail, "old")[0]!.causeCode).toBe(
      "REPEATED_OPERATIONS",
    );
  });
});
