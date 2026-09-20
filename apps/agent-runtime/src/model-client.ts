import OpenAI from "openai";
import { numericModelUsage } from "@devproof/agent-runtime-protocol";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { RuntimeModelCandidate } from "@devproof/agent-runtime-protocol";
import type { ModelRequestAttempt, ModelClient } from "./model-types.js";
import { DEFAULT_MODEL_CALL_SECONDS } from "./model-types.js";

/** Executors own retries, so one model attempt is exactly one HTTP request. */
export function createChatCompletionsClient(
  candidate: RuntimeModelCandidate,
  modelFetch: typeof fetch,
): ModelClient {
  return {
    complete: async (request, options) => {
      let attemptCount = 0;
      const client = new OpenAI({
        apiKey: candidate.apiKey,
        baseURL: candidate.baseUrl,
        maxRetries: 0,
        timeout: DEFAULT_MODEL_CALL_SECONDS * 1_000,
        fetch: async (input, init) => {
          const attempt: ModelRequestAttempt = {
            attempt: ++attemptCount,
            startedAt: Date.now(),
            durationMs: null,
            status: null,
            outcome: "RUNNING",
          };
          options?.onRequestAttempt?.(attempt);
          try {
            const response = await modelFetch(input, init);
            attempt.status = response.status;
            attempt.outcome = "RESPONSE";
            return response;
          } catch (error) {
            attempt.outcome = init?.signal?.aborted ? "ABORTED" : "ERROR";
            throw error;
          } finally {
            attempt.durationMs = Math.max(0, Date.now() - attempt.startedAt);
          }
        },
      });
      const startedAt = new Date().toISOString();
      const started = performance.now();
      let captured: {
        responseId?: string;
        responseModel?: string;
        usage?: Record<string, unknown>;
      } = {};
      let durationMs = 0;
      let outcome: "SUCCEEDED" | "FAILED" | "INTERRUPTED" = "FAILED";
      try {
        const response = await client.chat.completions.create(
          {
            ...request,
            stream: false,
          } as ChatCompletionCreateParamsNonStreaming,
          {
            signal: options?.signal,
            timeout: options?.timeoutMs ?? DEFAULT_MODEL_CALL_SECONDS * 1_000,
          },
        );
        durationMs = Math.max(0, Math.round(performance.now() - started));
        captured = {
          responseId: response.id,
          responseModel: response.model,
          usage: numericModelUsage(response.usage),
        };
        const message = response.choices[0]?.message;
        if (!message || message.role !== "assistant") {
          throw new Error("Chat Completions returned no assistant message.");
        }
        if (message.tool_calls?.some((call) => call.type !== "function")) {
          throw new Error(
            "Chat Completions returned an unsupported tool call.",
          );
        }
        outcome = "SUCCEEDED";
        return {
          id: response.id,
          message,
          ...(response.usage
            ? { usage: response.usage as unknown as Record<string, unknown> }
            : {}),
        };
      } finally {
        await options?.onTelemetry?.({
          requestedModel: candidate.modelId,
          configurationId: candidate.configurationId,
          configurationName: candidate.displayName,
          startedAt,
          durationMs:
            durationMs || Math.max(0, Math.round(performance.now() - started)),
          outcome:
            options?.signal?.aborted && !captured.responseId
              ? "INTERRUPTED"
              : outcome,
          ...captured,
        });
      }
    },
  };
}
