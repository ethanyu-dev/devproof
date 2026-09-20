import type {
  ModelCallTelemetry,
  RuntimeModelCandidate,
} from "@devproof/agent-runtime-protocol";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

export const DEFAULT_MODEL_CALL_SECONDS = 300;
export const MAX_MODEL_ATTEMPTS = 5;

/** Legacy replay preserves provider reasoning; bounded decisions retain tool facts only. */
export interface ModelAssistantMessage extends ChatCompletionAssistantMessageParam {
  reasoning_content?: string | null;
}

export type ModelMessage = ChatCompletionMessageParam | ModelAssistantMessage;
export type ModelFunctionCall = ChatCompletionMessageFunctionToolCall;

export interface ModelCompletion {
  id: string;
  message: ModelAssistantMessage;
  usage?: Record<string, unknown>;
  responseModel?: string;
  durationMs?: number;
}

/** Transport metadata only; never contains URLs, headers or request bodies. */
export interface ModelRequestAttempt {
  attempt: number;
  startedAt: number;
  durationMs: number | null;
  status: number | null;
  outcome: "RUNNING" | "RESPONSE" | "ERROR" | "ABORTED";
}

export interface ModelClient {
  complete(
    request: Record<string, unknown>,
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onTelemetry?:
        | ((value: Omit<ModelCallTelemetry, "modelCallId">) => Promise<void>)
        | undefined;
      onRequestAttempt?: (attempt: ModelRequestAttempt) => void;
    },
  ): Promise<ModelCompletion>;
}

export type ModelClientFactory = (
  candidate: RuntimeModelCandidate,
) => ModelClient;

export function modelFunctionCalls(
  message: ModelAssistantMessage,
): ModelFunctionCall[] {
  return (message.tool_calls ?? []).filter(
    (call): call is ModelFunctionCall => call.type === "function",
  );
}
