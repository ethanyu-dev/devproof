import { describe, expect, it } from "vitest";
import { ModelHealth } from "./model-health.js";

const candidate = {
  baseUrl: "https://provider.example/v1",
  apiKey: "secret",
  modelId: "model-a",
  displayName: "A",
};

describe("model health", () => {
  it("does not exclude sibling models for a model-specific permission failure", () => {
    const health = new ModelHealth();
    const error = Object.assign(new Error("Model permission denied"), {
      status: 403,
    });
    health.failure(candidate, error);
    health.failure(candidate, error);
    expect(health.available(candidate)).toBe(false);
    expect(health.available({ ...candidate, modelId: "other-model" })).toBe(
      true,
    );
  });

  it("recognizes machine-readable exhausted quota codes", () => {
    const health = new ModelHealth();
    health.failure(candidate, { status: 429, code: "insufficient_user_quota" });
    expect(health.available({ ...candidate, modelId: "alias" })).toBe(false);
  });
  it("temporarily excludes an exhausted credential across model aliases without blocking another credential", () => {
    let now = 0;
    const health = new ModelHealth(() => now);
    expect(
      health.failure(
        candidate,
        Object.assign(new Error("Insufficient balance"), { status: 429 }),
      ),
    ).toMatchObject({
      reason: "CREDENTIAL_UNAVAILABLE",
      cooldownMs: 1_800_000,
    });
    expect(health.available({ ...candidate, modelId: "alias" })).toBe(false);
    expect(health.available({ ...candidate, apiKey: "other" })).toBe(true);
    now = 1_800_000;
    expect(health.available(candidate)).toBe(true);
  });

  it("backs off rate limits and repeated timeouts, resetting consecutive failures after success", () => {
    let now = 0;
    const health = new ModelHealth(() => now);
    health.failure(candidate, new Error("模型响应超过 90 秒。"));
    expect(health.available(candidate)).toBe(true);
    health.failure(candidate, new Error("模型响应超过 90 秒。"));
    expect(health.available(candidate)).toBe(false);
    expect(health.available({ ...candidate, modelId: "model-b" })).toBe(true);
    now = 300_000;
    health.success(candidate);
    expect(
      health.failure(candidate, new Error("Connection error")).cooldownMs,
    ).toBe(0);
    health.failure(candidate, { status: 429 });
    expect(health.available(candidate)).toBe(false);
    now += 60_000;
    expect(health.available(candidate)).toBe(true);
  });
});
