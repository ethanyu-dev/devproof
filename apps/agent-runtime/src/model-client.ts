import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { RuntimeModelCandidate } from "@devproof/agent-runtime-protocol";
import type {
  ModelRequestAttempt,
  ModelResponse,
  ResponsesClient,
} from "./browser-verification.executor.js";

/** Keep SDK retry behavior, measuring each actual transport attempt separately. */
export function createResponsesClient(
  candidate: RuntimeModelCandidate,
  modelFetch: typeof fetch,
): ResponsesClient {
  return {
    responses: {
      create: async (request, options) => {
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
        const response = await client.responses.create(
          request as ResponseCreateParamsNonStreaming,
          { signal: options?.signal },
        );
        return {
          id: response.id,
          output: response.output as ModelResponse["output"],
          ...(response.usage
            ? { usage: response.usage as unknown as Record<string, unknown> }
            : {}),
        };
      },
    },
  };
}
