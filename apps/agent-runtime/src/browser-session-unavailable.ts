/** Browser commands stop when the session or its lease is gone. Human takeover
 * pause stays recoverable and is not one of these codes.
 */
const TERMINAL_BROWSER_SESSION_CODES = new Set([
  "SESSION_PERMIT_EXPIRED",
  "SESSION_CLOSED",
  "SESSION_NOT_ACTIVE",
  "BROWSER_SESSION_LOST",
  "LEASE_LOST",
]);

export class BrowserSessionUnavailableError extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function codeOf(value: unknown) {
  const code = record(value)?.code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(value: unknown) {
  const message = record(value)?.message;
  return typeof message === "string" ? message : undefined;
}

/** Recognize a lost session from a command result or a control-plane HTTP body.
 * Prose is not a signal: the code lives on `error.code` or `body.code`.
 */
export function terminalBrowserSessionError(
  value: unknown,
): BrowserSessionUnavailableError | null {
  if (value instanceof BrowserSessionUnavailableError) return value;
  const envelope = record(value);
  if (!envelope) return null;
  const nested = record(envelope.error);
  const code = codeOf(nested) ?? codeOf(envelope) ?? codeOf(envelope.body);
  if (!code || !TERMINAL_BROWSER_SESSION_CODES.has(code)) return null;
  const message =
    messageOf(nested) ??
    messageOf(envelope.body) ??
    messageOf(envelope) ??
    "浏览器会话已失效。";
  return new BrowserSessionUnavailableError(`${code}: ${message}`);
}
