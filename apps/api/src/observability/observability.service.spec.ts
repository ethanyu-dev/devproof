import { describe, expect, it } from "vitest";

import {
  ObservabilityService,
  redactText,
  summarizeValue,
} from "./observability.service.js";

describe("ObservabilityService", () => {
  it("continues a valid W3C trace while creating a local span", () => {
    const service = new ObservabilityService();
    const context = service.root({
      requestId: "request-1",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });

    expect(context.requestId).toBe("request-1");
    expect(context.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(service.traceparent(context)).toBe(
      `00-${context.traceId}-${context.spanId}-01`,
    );
  });

  it("summarizes inputs without retaining secrets or raw content", () => {
    const summary = summarizeValue({
      authorization: "Bearer very-secret-value",
      commandType: "page.navigate",
      payload: { note: "private page contents", token: "dvp_sk_hidden" },
      runId: "run-1",
    });
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      commandType: "page.navigate",
      runId: "run-1",
    });
    expect(serialized).not.toContain("very-secret-value");
    expect(serialized).not.toContain("private page contents");
    expect(serialized).not.toContain("dvp_sk_hidden");
    expect(summary.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("redacts credentials embedded in errors and URLs", () => {
    const value = redactText(
      "Bearer abc.def token=dvp_sk_1234567890123456 https://user:pass@example.com/path?api_key=secret",
    );

    expect(value).not.toContain("abc.def");
    expect(value).not.toContain("dvp_sk_1234567890123456");
    expect(value).not.toContain("user:pass");
    expect(value).not.toContain("api_key=secret");
  });
});
