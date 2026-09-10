import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { RuntimeModelCandidate } from "@devproof/agent-runtime-protocol";
import type { ModelRequestAttempt, ModelClient } from "./model-types.js";

/** Keep SDK retry behavior, measuring each actual transport attempt separately. */
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
      const response = await client.chat.completions.create(
        { ...request, stream: false } as ChatCompletionCreateParamsNonStreaming,
        { signal: options?.signal },
      );
      const message = response.choices[0]?.message;
      if (!message || message.role !== "assistant") {
        throw new Error("Chat Completions returned no assistant message.");
      }
      if (message.tool_calls?.some((call) => call.type !== "function")) {
        throw new Error("Chat Completions returned an unsupported tool call.");
      }
      return {
        id: response.id,
        message,
        ...(response.usage
          ? { usage: response.usage as unknown as Record<string, unknown> }
          : {}),
      };
    },
  };
}
