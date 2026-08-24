import { describe, expect, it } from "vitest";

import {
  canTransitionVerification,
  isTerminalVerificationStatus,
} from "./verification-lifecycle.service.js";

describe("verification lifecycle", () => {
  it("allows the normal execution and HITL path", () => {
    expect(canTransitionVerification("QUEUED", "RUNNING")).toBe(true);
    expect(canTransitionVerification("QUEUED", "WAITING_EXECUTION")).toBe(true);
    expect(canTransitionVerification("WAITING_EXECUTION", "RUNNING")).toBe(
      true,
    );
    expect(canTransitionVerification("RUNNING", "WAITING_HUMAN")).toBe(true);
    expect(canTransitionVerification("WAITING_HUMAN", "RUNNING")).toBe(true);
    expect(canTransitionVerification("WAITING_HUMAN", "QUEUED")).toBe(true);
    expect(canTransitionVerification("RUNNING", "PASSED")).toBe(true);
  });

  it("makes terminal verdicts immutable", () => {
    expect(isTerminalVerificationStatus("FAILED")).toBe(true);
    expect(canTransitionVerification("PASSED", "RUNNING")).toBe(false);
    expect(canTransitionVerification("CANCELLED", "QUEUED")).toBe(false);
  });

  it("allows a retry to return to the queue", () => {
    expect(canTransitionVerification("RUNNING", "QUEUED")).toBe(true);
  });
});
