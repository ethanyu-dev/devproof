import { createHash } from "node:crypto";
import type { ModelAssistantMessage, ModelMessage } from "./model-types.js";
import { modelFunctionCalls } from "./model-types.js";

export interface OperationSummary {
  callId?: string;
  tool: string;
  arguments: unknown;
  outcome: "SUCCEEDED" | "FAILED" | "RETURNED" | "NO_TOOL_CALL";
  result: unknown;
}

/** Summaries describe tool facts, never an assistant's claimed business outcome. */
export function summarizeTurn(
  message: ModelAssistantMessage | null,
  results: ModelMessage[],
): OperationSummary[] {
  const calls = message ? modelFunctionCalls(message) : [];
  if (!calls.length) {
    return results.map((result) => {
      const value = parseContent(result.content);
      const initial = object(value);
      return initial.kind === "runtime_initial_navigation"
        ? summarizeOperation("browser_command", initial.command, initial.result)
        : {
            tool: "runtime",
            arguments: {},
            outcome: "NO_TOOL_CALL",
            result: compactValue(value, 1_000),
          };
    });
  }
  return calls.map((call) => {
    const reply = results.find(
      (result) => result.role === "tool" && result.tool_call_id === call.id,
    );
    return {
      callId: call.id,
      ...summarizeOperation(
        call.function.name,
        parseContent(call.function.arguments),
        parseContent(reply?.content),
      ),
    };
  });
}

export function summarizeOperation(
  tool: string,
  args: unknown,
  output: unknown,
): OperationSummary {
  const value = object(output);
  const failed =
    value.accepted === false || value.status === "FAILED" || value.ok === false;
  return {
    tool,
    arguments: compactValue(args, 2_048),
    outcome: failed
      ? "FAILED"
      : value.status === "SUCCEEDED" ||
          value.ok === true ||
          value.accepted === true
        ? "SUCCEEDED"
        : "RETURNED",
    result: compactValue(output, 4_096),
  };
}

/** Bound data structurally; omitted strings are explicitly marked, never invalid JSON. */
export function compactValue(value: unknown, maxBytes: number): unknown {
  let textLimit = 1_200;
  let arrayLimit = 8;
  const visit = (item: unknown, depth = 0): unknown => {
    if (typeof item === "string")
      return item.length <= textLimit
        ? item
        : {
            preview: item.slice(0, textLimit),
            truncated: true,
            totalChars: item.length,
          };
    if (item === null || typeof item !== "object") return item;
    if (depth >= 7) return { truncated: true };
    if (Array.isArray(item)) {
      const kept = item
        .slice(0, arrayLimit)
        .map((child) => visit(child, depth + 1));
      return item.length > arrayLimit
        ? [...kept, { omittedItems: item.length - arrayLimit }]
        : kept;
    }
    return Object.fromEntries(
      Object.entries(item).flatMap(([key, child]) => {
        // Pixels live in the current viewport, DOM lives in the current page window.
        if (
          [
            "dataBase64",
            "reasoning_content",
            "reasoning",
            "reasoning_details",
          ].includes(key)
        )
          return [];
        if (
          key === "content" &&
          typeof child === "string" &&
          object(item).refState === "CURRENT"
        )
          return [["contentInCurrentPage", true]];
        return [[key, visit(child, depth + 1)]];
      }),
    );
  };
  let result = visit(value);
  while (
    Buffer.byteLength(JSON.stringify(result) ?? "null") > maxBytes &&
    textLimit > 60
  ) {
    textLimit = Math.floor(textLimit / 2);
    arrayLimit = Math.max(1, Math.floor(arrayLimit / 2));
    result = visit(value);
  }
  if (Buffer.byteLength(JSON.stringify(result) ?? "null") <= maxBytes)
    return result;
  // Keep correction/recovery routing ahead of verbose or arbitrary output fields.
  const source = object(value);
  const fallback: Record<string, unknown> = { truncated: true };
  const keys = [
    "accepted",
    "status",
    "code",
    "nextAction",
    "observationId",
    "error",
    "locatorRecovery",
    "result",
  ].filter((key) => key in source);
  for (const [index, key] of keys.entries()) {
    const remaining =
      maxBytes - Buffer.byteLength(JSON.stringify(fallback)) - 32;
    const budget = Math.floor(remaining / (keys.length - index));
    if (budget < 64) continue;
    const child = compactValue(source[key], budget);
    if (
      Buffer.byteLength(JSON.stringify({ ...fallback, [key]: child })) <=
      maxBytes
    )
      fallback[key] = child;
  }
  return fallback;
}

export class OperationMemory {
  private readonly failures = new Map<
    string,
    { operation: OperationSummary; count: number }
  >();
  private lastBrowserAction: OperationSummary | undefined;

  record(operations: OperationSummary[]) {
    for (const operation of operations) {
      const key = createHash("sha256")
        .update(JSON.stringify([operation.tool, operation.arguments]))
        .digest("hex");
      if (operation.outcome === "FAILED") {
        const count = (this.failures.get(key)?.count ?? 0) + 1;
        this.failures.delete(key);
        this.failures.set(key, {
          operation: {
            ...operation,
            arguments: compactValue(operation.arguments, 768),
            result: compactValue(operation.result, 1_536),
          },
          count,
        });
        while (this.failures.size > 8)
          this.failures.delete(this.failures.keys().next().value!);
      } else if (operation.outcome === "SUCCEEDED") this.failures.delete(key);
      const commandType = object(operation.arguments).commandType;
      if (
        operation.tool === "browser_command" &&
        typeof commandType === "string" &&
        /\.(?:click|fill|type|check|uncheck|select|press|navigate|reload|go_back|go_forward|drag|scroll|new|close|switch)$/u.test(
          commandType,
        )
      )
        this.lastBrowserAction = structuredClone(operation);
    }
  }

  state() {
    return {
      recentFailures: [...this.failures.values()],
      lastBrowserAction: this.lastBrowserAction,
    };
  }
}

function parseContent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
