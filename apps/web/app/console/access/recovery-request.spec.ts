import { describe, expect, it } from "vitest";
import { RecoveryRequest } from "./recovery-request";
import {
  recoveryGuidance,
  recoveryNeedsWriteReview,
} from "./runtime-recovery-display";

describe("recovery reads", () => {
  it("rejects late results and errors from a superseded filter even if transport ignores abort", async () => {
    const requests = new RecoveryRequest();
    let release!: () => void;
    const old = requests.begin();
    let displayed = "initial";
    const lateResponse = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      if (old.current()) displayed = "old record";
    });
    const latest = requests.begin();
    expect(old.signal.aborted).toBe(true);
    if (latest.current()) displayed = "new record";
    release();
    await lateResponse;
    expect(displayed).toBe("new record");
    requests.cancel();
    expect(latest.signal.aborted).toBe(true);
    expect(latest.current()).toBe(false);
  });
});
describe("recovery next action", () => {
  it("offers business review only after closure, and never for a settled outcome", () => {
    const item = {
      closureState: "NEEDS_OPERATOR",
      writeOutcomeState: "UNKNOWN",
      resolvedAt: null,
    };
    expect(recoveryNeedsWriteReview(item)).toBe(false);
    expect(
      recoveryNeedsWriteReview({ ...item, closureState: "VERIFIED" }),
    ).toBe(true);
    expect(
      recoveryNeedsWriteReview({
        ...item,
        closureState: "VERIFIED",
        resolvedAt: "2026-09-07",
      }),
    ).toBe(false);
    for (const writeOutcomeState of [
      "NOT_APPLICABLE",
      "CONFIRMED",
      "RESOLVED",
      "NO_WRITE_VERIFIED",
    ]) {
      expect(
        recoveryNeedsWriteReview({
          ...item,
          closureState: "VERIFIED",
          writeOutcomeState,
        }),
      ).toBe(false);
    }
  });
  it("explains that unverifiable closure needs operator evidence rather than another automatic retry", () => {
    expect(recoveryGuidance("NEEDS_OPERATOR", "CLOSURE_UNVERIFIED")).toContain(
      "自动重试已暂停",
    );
    expect(recoveryGuidance("NEEDS_OPERATOR", "CLOSURE_UNVERIFIED")).toContain(
      "节点排空",
    );
    expect(recoveryGuidance("OBSERVED", null)).toContain("当前无需关闭");
  });
});
