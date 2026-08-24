import { describe, expect, it } from "vitest";

import {
  boundedJsonArray,
  boundedUtf8Buffer,
  redactText,
  sanitizeDom,
} from "./index.js";

describe("Browser content safety", () => {
  it("redacts password values regardless of attribute order", () => {
    const sanitized = sanitizeDom(
      '<input value="super-secret" type="password"><textarea name="api-token">token-value</textarea>',
    );
    expect(sanitized).not.toContain("super-secret");
    expect(sanitized).not.toContain("token-value");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("redacts free-form cookie and embedded URL credentials", () => {
    const redacted = redactText(
      "cookie: sessionid=abc123 visit https://user:pass@example.com/?token=value",
    );
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("user:pass");
    expect(redacted).not.toContain("token=value");
  });

  it("truncates UTF-8 content on a complete character boundary", () => {
    const bounded = boundedUtf8Buffer("a你b", 3);
    expect(bounded.data.byteLength).toBeLessThanOrEqual(3);
    expect(bounded.data.toString("utf8")).toBe("a");
    expect(bounded.data.toString("utf8")).not.toContain("�");
  });

  it("keeps bounded JSON artifacts valid", () => {
    const bounded = boundedJsonArray(
      [{ text: "a".repeat(60) }, { text: "b".repeat(60) }],
      100,
    );
    expect(() => JSON.parse(bounded.content)).not.toThrow();
    expect(bounded.truncated).toBe(true);
  });
});
