import { describe, expect, it, vi } from "vitest";
import { createResponsesClient } from "./model-client.js";
import type { ModelRequestAttempt } from "./browser-verification.executor.js";

const candidate = {
  apiKey: "sk-private",
  baseUrl: "https://gateway.example.com/v1?token=private",
  displayName: "Test",
  modelId: "fixed-model",
};
const request = { model: candidate.modelId, input: "private input" };
const response = () =>
  new Response(
    JSON.stringify({
      id: "response-1",
      output: [],
      usage: { input_tokens: 10 },
    }),
    { headers: { "content-type": "application/json" } },
  );

describe("model request attempt telemetry", () => {
  it("measures SDK retries without putting transport metadata in model input", async () => {
    const attempts: ModelRequestAttempt[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"retry"}}', {
          status: 429,
          headers: { "retry-after-ms": "1" },
        }),
      )
      .mockResolvedValueOnce(response());
    const result = await createResponsesClient(
      candidate,
      fetch,
    ).responses.create(request, {
      onRequestAttempt: (attempt) => attempts.push(attempt),
    });
    expect(result).toMatchObject({
      id: "response-1",
      usage: { input_tokens: 10 },
    });
    expect(attempts).toMatchObject([
      { attempt: 1, status: 429, outcome: "RESPONSE" },
      { attempt: 2, status: 200, outcome: "RESPONSE" },
    ]);
    expect(
      attempts.every(
        (attempt) => attempt.durationMs !== null && attempt.durationMs >= 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(attempts)).not.toMatch(
      /private|gateway|authorization/iu,
    );
    for (const [, init] of fetch.mock.calls) {
      expect(String(init?.body)).not.toMatch(
        /onRequestAttempt|startedAt|durationMs/u,
      );
    }
  });

  it("retains the failed HTTP attempt without retrying non-retryable errors", async () => {
    const attempts: ModelRequestAttempt[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response('{"error":{"message":"invalid"}}', { status: 400 }),
      );
    await expect(
      createResponsesClient(candidate, fetch).responses.create(request, {
        onRequestAttempt: (attempt) => attempts.push(attempt),
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(attempts).toMatchObject([
      { attempt: 1, status: 400, outcome: "RESPONSE" },
    ]);
  });

  it("exposes an in-flight attempt and records its cancellation without retrying", async () => {
    const controller = new AbortController();
    const attempts: ModelRequestAttempt[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_input, init) => {
        expect(attempts).toMatchObject([
          { outcome: "RUNNING", durationMs: null },
        ]);
        return new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
          controller.abort();
        });
      });
    await expect(
      createResponsesClient(candidate, fetch).responses.create(request, {
        signal: controller.signal,
        onRequestAttempt: (attempt) => attempts.push(attempt),
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(attempts).toMatchObject([
      { attempt: 1, status: null, outcome: "ABORTED" },
    ]);
  });
});
