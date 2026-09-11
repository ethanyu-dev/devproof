import type { BadgeTone } from "@/components/ui/badge";

export const terminalLifecycles = new Set([
  "COMPLETED",
  "CANCELLED",
  "TIMED_OUT",
]);

export function tone(status: string | null): BadgeTone {
  if (["PASSED", "SUCCEEDED"].includes(status ?? "")) return "success";
  if (
    [
      "FAILED",
      "TIMED_OUT",
      "NOT_RUN",
      "BLOCKED",
      "AGENT_ERROR",
      "PROVIDER_ERROR",
      "BROWSER_UNAVAILABLE",
      "RUNTIME_LOST",
    ].includes(status ?? "")
  )
    return "danger";
  if (["PENDING", "WAITING_INPUT", "WAITING_HUMAN"].includes(status ?? ""))
    return "warning";
  if (["PREPARING", "RUNNING", "DISPATCHING"].includes(status ?? ""))
    return "info";
  return "neutral";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (!isRecord(error)) return null;
  const message = error.message;
  const code = error.code;
  if (typeof message !== "string") return null;
  return typeof code === "string" ? `${code}: ${message}` : message;
}

export function prettyValue(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
