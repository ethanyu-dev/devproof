import type { LoggerService } from "@nestjs/common";

import { redactText } from "./observability.service.js";

type Level = "debug" | "info" | "warn" | "error";
const priority: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function safeValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (depth >= 6) return "[depth-limited]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const typed = value as Error & { code?: unknown };
    return {
      ...(typed.code === undefined ? {} : { code: safeValue(typed.code) }),
      message: redactText(value.message),
      name: value.name,
      ...(value.stack ? { stack: redactText(value.stack) } : {}),
      ...(value.cause === undefined
        ? {}
        : { cause: safeValue(value.cause, depth + 1, seen) }),
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.map((item) => safeValue(item, depth + 1, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /(?:authorization|cookie|password|secret|token|api[-_]?key)/iu.test(key)
          ? "[REDACTED]"
          : safeValue(item, depth + 1, seen),
      ]),
    );
  }
  return value;
}

export class JsonLogger implements LoggerService {
  private contextProvider?: () => Record<string, unknown> | undefined;

  constructor(private readonly minimumLevel: Level = "info") {}

  setContextProvider(
    provider: () => Record<string, unknown> | undefined,
  ): void {
    this.contextProvider = provider;
  }

  log(message: unknown, ...optionalParams: unknown[]) {
    this.write("info", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]) {
    this.write("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]) {
    this.write("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]) {
    this.write("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]) {
    this.write("debug", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]) {
    this.write("error", message, optionalParams);
  }

  private write(level: Level, message: unknown, optionalParams: unknown[]) {
    if (priority[level] < priority[this.minimumLevel]) return;
    const context =
      typeof optionalParams.at(-1) === "string"
        ? String(optionalParams.at(-1))
        : undefined;
    const details = context ? optionalParams.slice(0, -1) : optionalParams;
    const correlation = this.contextProvider?.();
    const record = {
      ...(correlation
        ? (safeValue(correlation) as Record<string, unknown>)
        : {}),
      ...(context ? { context: redactText(context) } : {}),
      event: "nest.log",
      level,
      message: safeValue(message),
      ...(details.length > 0 ? { details: safeValue(details) } : {}),
      service: "devproof-api",
      timestamp: new Date().toISOString(),
    };
    const stream =
      level === "warn" || level === "error" ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(record)}\n`);
  }
}
