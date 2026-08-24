import { describe, expect, it } from "vitest";

import { extractBearerToken, hashToolToken } from "./tool-auth.service.js";

describe("tool authentication", () => {
  it("accepts only DevProof bearer tokens", () => {
    expect(extractBearerToken("Bearer dvp_sk_abc123")).toBe("dvp_sk_abc123");
    expect(() => extractBearerToken("Bearer external-token")).toThrow();
    expect(() => extractBearerToken(undefined)).toThrow();
  });

  it("stores a stable token hash instead of the credential", () => {
    expect(hashToolToken("dvp_sk_secret")).toHaveLength(64);
    expect(hashToolToken("dvp_sk_secret")).toBe(hashToolToken("dvp_sk_secret"));
    expect(hashToolToken("dvp_sk_secret")).not.toContain("secret");
  });
});
