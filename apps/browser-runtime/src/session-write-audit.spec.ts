import { describe, expect, it } from "vitest";
import { SessionWriteAudit } from "./session-write-audit.js";
describe("cumulative session network audit", () => {
  it("retains writes from early actions even after later read-only observations", () => {
    const audit = new SessionWriteAudit(true);
    audit.request("POST");
    for (let i = 0; i < 1000; i++) audit.request("GET");
    expect(audit.closed("launch")).toMatchObject({
      complete: true,
      requestCount: 1001,
      potentialWrites: 1,
    });
  });
  it("does not treat persistent pages or unobserved channels as a complete audit", () => {
    expect(new SessionWriteAudit(false).closed("launch").complete).toBe(false);
    const audit = new SessionWriteAudit(true);
    audit.invalidate();
    expect(audit.closed("launch").complete).toBe(false);
    expect(new SessionWriteAudit(true).closed(undefined).complete).toBe(false);
  });
  it("counts HTTP methods across origins without recording sensitive request content", () => {
    const audit = new SessionWriteAudit(true);
    ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE", "POST"].forEach((m) =>
      audit.request(m),
    );
    expect(audit.closed("launch")).toMatchObject({
      requestCount: 7,
      potentialWrites: 4,
    });
  });
});
