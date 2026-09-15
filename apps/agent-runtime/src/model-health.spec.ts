import { describe, expect, it } from "vitest";
import { ModelHealth } from "./model-health.js";

const candidate = {
  baseUrl: "https://provider.example/v1",
  apiKey: "secret",
  modelId: "model-a",
  displayName: "A",
};

describe("model health", () => {
  it("excludes a missing model immediately across retries and resumes, with a bounded reprobe", () => {
    let now = 0;
    const health = new ModelHealth(() => now);
    const sibling = { ...candidate, modelId: "available" };
    const attempts = health.attempts([candidate, sibling]);
    expect(attempts.next().value?.candidate).toEqual(candidate);
    health.failure(
      candidate,
      Object.assign(
        new Error("The model does not exist or you do not have access to it"),
        { status: 404 },
      ),
    );
    expect(
      [...attempts].every((item) => item.candidate.modelId === "available"),
    ).toBe(true);
    expect([...health.attempts([candidate])]).toEqual([]);
    expect(health.available({ ...candidate, apiKey: "changed" })).toBe(true);
    now = 30 * 60_000;
    expect(health.available(candidate)).toBe(true);
  });
  it("restores definitive failures when human input resumes on another worker", () => {
    const first = new ModelHealth(() => 1000);
    const failure = first.failure(
      candidate,
      Object.assign(new Error("model not found"), { status: 404 }),
    );
    const resumed = new ModelHealth(() => 2000);
    resumed.restore({
      [failure.key]: {
        until: failure.until,
        reason: failure.reason,
        failures: failure.consecutiveFailures,
      },
    });
    expect(resumed.available(candidate)).toBe(false);
    expect(resumed.available({ ...candidate, modelId: "available" })).toBe(
      true,
    );
    expect(JSON.stringify(failure)).not.toContain(candidate.apiKey);
  });
  it("does not exclude sibling models for a model-specific permission failure", () => {
    const health = new ModelHealth();
    const error = Object.assign(new Error("Model permission denied"), {
      status: 403,
    });
    for (let i = 0; i < 5; i++) health.failure(candidate, error);
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
    health.failure(candidate, new Error("模型响应超过 300 秒。"));
    expect(health.available(candidate)).toBe(true);
    health.failure(candidate, new Error("模型响应超过 300 秒。"));
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

  it("keeps five attempts for each admitted model despite transient cooldowns", () => {
    const health = new ModelHealth();
    const candidates = [candidate, { ...candidate, modelId: "model-b" }];
    const attempts = [];
    for (const attempt of health.attempts(candidates)) {
      attempts.push([attempt.candidate.modelId, attempt.modelAttempt]);
      health.failure(attempt.candidate, { status: 429 });
    }
    expect(attempts).toEqual(
      [1, 2, 3, 4, 5].flatMap((attempt) => [
        ["model-a", attempt],
        ["model-b", attempt],
      ]),
    );
    expect([...health.attempts(candidates)]).toEqual([]);
  });

  it("stops retrying credentials that become unavailable, including admitted aliases", () => {
    const health = new ModelHealth();
    const attempts = health.attempts([
      candidate,
      { ...candidate, modelId: "alias" },
    ]);
    expect(attempts.next().value).toMatchObject({ modelAttempt: 1 });
    health.failure(candidate, { status: 401 });
    expect(attempts.next().done).toBe(true);
  });
});

it("stops a model after two consecutive timeout attempts in the same decision", () => {
  const health = new ModelHealth(() => 1000);
  const attempts = health.attempts([candidate]);
  expect(attempts.next().done).toBe(false);
  health.failure(candidate, new Error("模型响应超过 300 秒。"));
  expect(attempts.next().done).toBe(false);
  health.failure(candidate, new Error("Request timed out"));
  expect(attempts.next().done).toBe(true);
  expect(health.available({ ...candidate, modelId: "fallback" })).toBe(true);
});
