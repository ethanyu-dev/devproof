import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  redactTracePayload,
  sha256Json,
} from "./test-data.service.js";

describe("test data content addressing", () => {
  it("produces a stable canonical representation for object key order", () => {
    const left = { profile: { mode: "EPHEMERAL" }, steps: [{ b: 2, a: 1 }] };
    const right = { steps: [{ a: 1, b: 2 }], profile: { mode: "EPHEMERAL" } };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(sha256Json(left)).toBe(sha256Json(right));
  });

  it("preserves array ordering in the content hash", () => {
    expect(sha256Json({ steps: ["a", "b"] })).not.toBe(
      sha256Json({ steps: ["b", "a"] }),
    );
  });

  it("redacts nested credential-shaped trace fields at the storage boundary", () => {
    expect(
      redactTracePayload({
        request: { authorization: "Bearer secret", safe: "visible" },
        values: [{ password: "secret" }],
      }),
    ).toEqual({
      request: { authorization: "••••redacted••••", safe: "visible" },
      values: [{ password: "••••redacted••••" }],
    });
  });
});
