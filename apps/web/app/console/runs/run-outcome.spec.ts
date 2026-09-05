import { describe, expect, it } from "vitest";
import { runOutcome } from "./run-outcome";

describe("Run lifecycle outcome", () => {
  it.each(["QUEUED", "PREPARING", "RUNNING", "WAITING_HUMAN"])(
    "%s never presents a stale verdict as a completed verification",
    (lifecycle) => {
      const result = runOutcome(
        { lifecycle, verdict: "PASSED" },
        "EXECUTED",
        [],
        [],
      );
      expect(result.title).not.toMatch(/已完成|验证通过/u);
      expect(result.tone).toBe("warning");
    },
  );
  it("only completed runs present verification verdicts", () => {
    expect(
      runOutcome(
        { lifecycle: "COMPLETED", verdict: "PASSED" },
        "EXECUTED",
        [],
        [],
      ).title,
    ).toBe("验证通过");
    expect(
      runOutcome(
        { lifecycle: "UNKNOWN_NEW_STATE", verdict: "PASSED" },
        "EXECUTED",
        [],
        [],
      ).label,
    ).toBe("状态待确认");
    expect(
      runOutcome(
        { lifecycle: "TIMED_OUT", verdict: "PASSED" },
        "EXECUTED",
        [],
        [],
      ).label,
    ).toBe("已超时");
  });
});
