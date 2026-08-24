import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { Injectable } from "@nestjs/common";

import { env } from "../config/env.js";

export interface ObservabilityContext {
  credentialId?: string;
  requestId: string;
  runId?: string;
  spanId: string;
  toolInvocationId?: string;
  traceId: string;
}

const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|session)/iu;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/iu;
const LOG_PRIORITY = { debug: 10, info: 20, warn: 30, error: 40 } as const;

function hex(bytes: number) {
  return randomBytes(bytes).toString("hex");
}

function errorCode(error: unknown) {
  if (error && typeof error === "object") {
    if ("code" in error && typeof error.code === "string") return error.code;
    if ("status" in error && typeof error.status === "number")
      return `HTTP_${error.status}`;
    if ("statusCode" in error && typeof error.statusCode === "number")
      return `HTTP_${error.statusCode}`;
    if (error instanceof Error && error.name) return error.name.toUpperCase();
  }
  return "UNKNOWN_ERROR";
}

export function redactText(value: string) {
  return value
    .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/giu, "$1 [REDACTED]")
    .replace(/\b(?:dvp_sk_|sk-)[a-z0-9_-]{12,}/giu, "[REDACTED]")
    .replace(
      /\b(password|passwd|secret|token|api[-_]?key)(\s*[=:]\s*|["']?\s*:\s*["'])([^\s,;&"'<>}]+)/giu,
      "$1$2[REDACTED]",
    )
    .replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
      try {
        const url = new URL(candidate);
        url.username = "";
        url.password = "";
        for (const key of url.searchParams.keys()) {
          if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
        }
        return url.toString();
      } catch {
        return candidate;
      }
    });
}

function errorMessage(error: unknown) {
  return redactText(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 4_000);
}

function shape(value: unknown, depth = 0): unknown {
  if (depth >= 4) return "[depth-limited]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return `[string:${Buffer.byteLength(value)}]`;
  if (typeof value === "number") return "[number]";
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return "[bigint]";
  if (Array.isArray(value)) {
    return {
      items: value.slice(0, 20).map((item) => shape(item, depth + 1)),
      length: value.length,
    };
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, item]) => [
          key,
          SENSITIVE_KEY.test(key) ? "[REDACTED]" : shape(item, depth + 1),
        ]),
    );
  }
  return `[${typeof value}]`;
}

export function summarizeValue(value: unknown): Record<string, unknown> {
  const shaped = shape(value);
  const serialized = JSON.stringify(shaped);
  const direct =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const safeFields = Object.fromEntries(
    ["runId", "commandType", "status", "verdict", "id"]
      .filter((key) =>
        ["string", "number", "boolean"].includes(typeof direct[key]),
      )
      .map((key) => [key, direct[key]]),
  );
  return {
    ...safeFields,
    fingerprint: createHash("sha256").update(serialized).digest("hex"),
    shape: shaped,
  };
}

@Injectable()
export class ObservabilityService {
  private readonly storage = new AsyncLocalStorage<ObservabilityContext>();

  root(input: {
    requestId?: string;
    traceparent?: string | string[];
  }): ObservabilityContext {
    const raw = Array.isArray(input.traceparent)
      ? input.traceparent[0]
      : input.traceparent;
    const parsed = raw?.match(TRACEPARENT);
    const validParent = Boolean(
      parsed?.[1] &&
      parsed[2] &&
      parsed[1] !== "00000000000000000000000000000000" &&
      parsed[2] !== "0000000000000000",
    );
    return {
      requestId: input.requestId ?? randomUUID(),
      spanId: hex(8),
      traceId: validParent ? parsed![1]!.toLowerCase() : hex(16),
    };
  }

  current(): ObservabilityContext | undefined {
    return this.storage.getStore();
  }

  run<T>(context: ObservabilityContext, operation: () => T): T {
    return this.storage.run(context, operation);
  }

  with<T>(fields: Partial<ObservabilityContext>, operation: () => T): T {
    const current = this.current() ?? this.root({});
    return this.run({ ...current, ...fields }, operation);
  }

  childSpan(fields: Partial<ObservabilityContext> = {}): ObservabilityContext {
    return {
      ...(this.current() ?? this.root({})),
      ...fields,
      spanId: hex(8),
    };
  }

  traceparent(context = this.current()) {
    const value = context ?? this.root({});
    return `00-${value.traceId}-${value.spanId}-01`;
  }

  eventFields() {
    const current = this.current();
    if (!current) return {};
    return {
      ...(current.credentialId ? { credentialId: current.credentialId } : {}),
      requestId: current.requestId,
      spanId: current.spanId,
      ...(current.toolInvocationId
        ? { toolInvocationId: current.toolInvocationId }
        : {}),
      traceId: current.traceId,
    };
  }

  log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown> = {},
    error?: unknown,
  ) {
    if (LOG_PRIORITY[level] < LOG_PRIORITY[env().OBSERVABILITY_LOG_LEVEL]) {
      return;
    }
    const context = this.current();
    const record = {
      event,
      level,
      service: "devproof-api",
      timestamp: new Date().toISOString(),
      ...(context ?? {}),
      ...fields,
      ...(error
        ? { error: { code: errorCode(error), message: errorMessage(error) } }
        : {}),
    };
    const stream =
      level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(record)}\n`);
  }

  classifyError(error: unknown) {
    return { code: errorCode(error), message: errorMessage(error) };
  }
}
