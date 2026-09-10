import { describe, expect, it, vi } from "vitest";
import { createChatCompletionsClient } from "./model-client.js";
import type { ModelMessage, ModelRequestAttempt } from "./model-types.js";

const candidate = {
  apiKey: "sk-private",
  baseUrl: "https://gateway.example.com/v1?token=private",
  displayName: "Test",
  modelId: "fixed-model",
};
const request = {
  model: candidate.modelId,
  messages: [{ role: "user", content: "private input" }],
};
const response = () =>
  new Response(
    JSON.stringify({
      id: "response-1",
      choices: [{ message: { role: "assistant", content: "Done." } }],
      usage: { prompt_tokens: 10 },
    }),
    { headers: { "content-type": "application/json" } },
  );

describe("Chat Completions transport", () => {
  it.each(["deepseek-flash", "kimi-k3"])(
    "sends native chat messages, tools, images and preserved tool history for %s",
    async (modelId) => {
      const assistant = {
        role: "assistant" as const,
        content: null,
        reasoning_content: "private reasoning required by the next tool turn",
        tool_calls: [
          {
            id: "call-1",
            type: "function" as const,
            function: {
              name: "inspect_page",
              arguments: '{"selector":"#result"}',
            },
          },
          {
            id: "call-2",
            type: "function" as const,
            function: {
              name: "inspect_page",
              arguments: '{"selector":"#status"}',
            },
          },
        ],
      };
      const usage = {
        prompt_tokens: 31,
        completion_tokens: 17,
        total_tokens: 48,
        completion_tokens_details: { reasoning_tokens: 12 },
      };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: "chatcmpl-tools",
              choices: [
                { index: 0, finish_reason: "tool_calls", message: assistant },
              ],
              usage,
            }),
            { headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(response());
      const client = createChatCompletionsClient(
        {
          ...candidate,
          modelId,
          baseUrl: "https://gateway.example.com/v1",
        },
        fetch,
      );
      const messages: ModelMessage[] = [
        { role: "system", content: "Inspect the page using tools." },
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect the current viewport." },
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,cGl4ZWxz",
                detail: "high",
              },
            },
          ],
        },
      ];
      const settings = {
        model: modelId,
        tool_choice: "auto",
        parallel_tool_calls: false,
        tools: [
          {
            type: "function",
            function: {
              name: "inspect_page",
              description: "Inspect a visible element.",
              strict: false,
              parameters: {
                type: "object",
                properties: { selector: { type: "string" } },
                required: ["selector"],
              },
            },
          },
        ],
      };
      const first = await client.complete({ ...settings, messages });
      expect(first).toEqual({
        id: "chatcmpl-tools",
        message: assistant,
        usage,
      });
      const results: ModelMessage[] = assistant.tool_calls.map((call) => ({
        role: "tool",
        tool_call_id: call.id,
        content: '{"visible":true}',
      }));
      const nextMessages = [...messages, first.message, ...results];
      await client.complete({ ...settings, messages: nextMessages });

      for (const [index, [url, init]] of fetch.mock.calls.entries()) {
        expect(String(url)).toBe(
          "https://gateway.example.com/v1/chat/completions",
        );
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          ...settings,
          stream: false,
          messages: index === 0 ? messages : nextMessages,
        });
      }
    },
  );

  it.each([
    { choices: [] },
    { choices: [{ message: null }] },
    { choices: [{ message: { role: "user", content: "invalid role" } }] },
  ])(
    "rejects missing assistant messages so the executor can try another model (%#)",
    async (body) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify({ id: "empty", ...body }), {
          headers: { "content-type": "application/json" },
        }),
      );
      await expect(
        createChatCompletionsClient(candidate, fetch).complete(request),
      ).rejects.toThrow("no assistant message");
    },
  );

  it("rejects unsupported tool calls instead of replaying them without results", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "unsupported",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "custom-1",
                    type: "custom",
                    custom: { name: "shell", input: "ls" },
                  },
                ],
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      createChatCompletionsClient(candidate, fetch).complete(request),
    ).rejects.toThrow("unsupported tool call");
  });
});

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
    const result = await createChatCompletionsClient(candidate, fetch).complete(
      request,
      {
        onRequestAttempt: (attempt) => attempts.push(attempt),
      },
    );
    expect(result).toMatchObject({
      id: "response-1",
      usage: { prompt_tokens: 10 },
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
      createChatCompletionsClient(candidate, fetch).complete(request, {
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
      createChatCompletionsClient(candidate, fetch).complete(request, {
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
