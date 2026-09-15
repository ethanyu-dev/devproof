import { describe, expect, it } from "vitest";
import { runRecoveryNotice } from "./run-recovery-notice";

describe("completed verification recovery", () => {
  it.each(["PASSED", "FAILED", "INCONCLUSIVE"])(
    "preserves %s independently of the pending write audit",
    (verdict) => {
      const notice = runRecoveryNotice(
        { lifecycle: "COMPLETED", executionDisposition: "EXECUTED", verdict },
        { closureState: "VERIFIED", writeOutcomeState: "UNKNOWN" },
      );
      expect(notice.diagnosticOnly).toBe(true);
      expect(notice.needsWriteReview).toBe(true);
      expect(notice.guidance).not.toContain("已停止自动重试");
    },
  );
  it.each(["REQUESTED", "NEEDS_OPERATOR"])(
    "keeps unverified browser closure %s actionable",
    (closureState) => {
      expect(
        runRecoveryNotice(
          {
            lifecycle: "COMPLETED",
            executionDisposition: "EXECUTED",
            verdict: "INCONCLUSIVE",
          },
          { closureState, writeOutcomeState: "UNKNOWN" },
        ).diagnosticOnly,
      ).toBe(false);
    },
  );
  it("keeps interrupted executions' retry guidance", () => {
    const notice = runRecoveryNotice(
      {
        lifecycle: "COMPLETED",
        executionDisposition: "AGENT_ERROR",
        verdict: null,
      },
      { closureState: "VERIFIED", writeOutcomeState: "UNKNOWN" },
    );
    expect(notice.diagnosticOnly).toBe(false);
    expect(notice.guidance).toContain("已停止自动重试");
  });
});
