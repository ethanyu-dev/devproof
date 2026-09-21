import { createHash } from "node:crypto";
import {
  testAccountBindingsSchema,
  readExecutionState,
} from "@devproof/agent-runtime-protocol";
import { executionConcurrencyPolicySchema } from "@devproof/contracts";
import type { ExecutionConcurrencyPolicy } from "@devproof/contracts";
import { ExecutionRunnerUnavailableError } from "./runtime-adapters.js";
import type { ExecutionUnavailableReason } from "./runtime-adapters.js";

export interface ResourceClaim {
  rootKey: string;
  resourceKey: string;
  mode: "READ" | "WRITE";
  origin?: string;
}

/** Unknown/global mutations serialize by environment unless explicitly disabled. */
export function businessDataLocksEnabled(): boolean {
  return process.env.BROWSER_EXECUTION_DATA_LOCKS_ENABLED !== "false";
}

/** Only deployment configuration can alias origins which share backend state. */
export function businessEnvironmentKey(
  targetUrl?: string,
  configuration = process.env.BROWSER_EXECUTION_ENVIRONMENTS_JSON,
): string {
  if (!targetUrl) return "*";
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return "*";
  }
  if (!["http:", "https:"].includes(target.protocol)) return "*";
  if (configuration) {
    let rules: unknown;
    try {
      rules = JSON.parse(configuration);
    } catch {
      throw new Error(
        "BROWSER_EXECUTION_ENVIRONMENTS_JSON must be valid JSON.",
      );
    }
    if (!Array.isArray(rules))
      throw new Error("BROWSER_EXECUTION_ENVIRONMENTS_JSON must be an array.");
    const valid = rules.map((rule: unknown) => {
      if (
        !rule ||
        typeof rule !== "object" ||
        !("hostname" in rule) ||
        !("key" in rule) ||
        typeof rule.hostname !== "string" ||
        typeof rule.key !== "string" ||
        !rule.key.trim()
      )
        throw new Error(
          "Execution environment rules require hostname and key.",
        );
      return { hostname: rule.hostname.toLowerCase(), key: rule.key.trim() };
    });
    const matching = valid.filter(
      (rule) =>
        rule.hostname === target.hostname.toLowerCase() ||
        (rule.hostname.startsWith("*.") &&
          target.hostname.toLowerCase().endsWith(rule.hostname.slice(1))),
    );
    matching.sort(
      (a, b) =>
        Number(b.hostname === target.hostname) -
          Number(a.hostname === target.hostname) ||
        b.hostname.length - a.hostname.length ||
        a.key.localeCompare(b.key),
    );
    if (matching[0]) return `environment:${matching[0].key}`;
  }
  return `origin:${target.origin.toLowerCase()}`;
}

export function concurrencyPolicy(value: unknown): ExecutionConcurrencyPolicy {
  const parsed = executionConcurrencyPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : { accessMode: "UNKNOWN" };
}

export function resourceClaims(
  targetUrl: string | undefined,
  value: unknown,
): ResourceClaim[] {
  const rootKey = businessEnvironmentKey(targetUrl);
  const policy = concurrencyPolicy(value);
  if (rootKey === "*" || policy.accessMode === "UNKNOWN")
    return [{ rootKey, resourceKey: "", mode: "WRITE" }];
  const scopes = [
    ...new Set(
      (policy.resourceScopes?.length ? policy.resourceScopes : [""]).map(
        (scope) => scope.split("/").filter(Boolean).join("/"),
      ),
    ),
  ].sort();
  return scopes.map((resourceKey) => ({
    rootKey,
    resourceKey,
    mode: policy.accessMode === "READ_ONLY" ? "READ" : "WRITE",
  }));
}

/** Reusing an assigned account is allowed; conflicting use waits for verified closure.
 * Hash identities before persisting lock keys. An unspecified type covers all types.
 */
export function executionResourceClaims(
  targetUrl: string | undefined,
  concurrency: unknown,
  executionPolicy: unknown,
): ResourceClaim[] {
  const claims = businessDataLocksEnabled()
    ? resourceClaims(targetUrl, concurrency)
    : [];
  const policy =
    executionPolicy && typeof executionPolicy === "object"
      ? (executionPolicy as Record<string, unknown>)
      : {};
  const parsed = testAccountBindingsSchema.safeParse(policy.testAccounts);
  if (!parsed.success) return claims;
  const hash = (s: string) =>
    createHash("sha256").update(s.trim().toLowerCase()).digest("hex");
  const rootKey = businessEnvironmentKey(targetUrl);
  const state = readExecutionState(policy);
  const bindings = parsed.data.length
    ? parsed.data
    : state.account
      ? [
          {
            account: state.account,
            aliases: state.accountAliases,
            requiredTypes: [],
            usage: "CREATE_OR_MODIFY",
          },
        ]
      : [];
  for (const binding of bindings) {
    for (const account of new Set([binding.account, ...binding.aliases])) {
      for (const type of binding.requiredTypes.length
        ? binding.requiredTypes
        : [""]) {
        claims.push({
          rootKey,
          origin: "ACCOUNT_COORDINATION",
          resourceKey: `accounts/${hash(account)}${type ? `/${hash(type)}` : ""}`,
          mode: binding.usage === "READ_EXISTING" ? "READ" : "WRITE",
        });
      }
    }
  }
  // Duplicate roles may name the same identity; WRITE subsumes READ for that key.
  const unique = new Map<string, ResourceClaim>();
  for (const claim of claims) {
    const key = JSON.stringify([claim.rootKey, claim.resourceKey]);
    if (unique.get(key)?.mode !== "WRITE") unique.set(key, claim);
  }
  return [...unique.values()];
}

/** Root, collection and record scopes overlap; readers alone are compatible. */
export function resourcesConflict(
  left: ResourceClaim,
  right: ResourceClaim,
): boolean {
  if (
    left.rootKey !== right.rootKey &&
    left.rootKey !== "*" &&
    right.rootKey !== "*"
  )
    return false;
  if (left.mode === "READ" && right.mode === "READ") return false;
  if (left.rootKey === "*" || right.rootKey === "*") return true;
  return (
    !left.resourceKey ||
    !right.resourceKey ||
    left.resourceKey === right.resourceKey ||
    left.resourceKey.startsWith(`${right.resourceKey}/`) ||
    right.resourceKey.startsWith(`${left.resourceKey}/`)
  );
}

export class ExecutionAdmissionBlocked extends ExecutionRunnerUnavailableError {
  constructor(
    reason: ExecutionUnavailableReason,
    message: string,
    blockedBy?: {
      resourceType: string;
      taskId?: string;
      runId?: string;
      sessionId?: string;
      recoveryId?: string;
      recoveryPhase?: string;
      rootReason?: string;
    },
  ) {
    super(reason, message, "WAIT", blockedBy);
  }
}

export function executionTarget(
  input: unknown,
  environment?: unknown,
): string | undefined {
  for (const value of [input, environment]) {
    if (
      value &&
      typeof value === "object" &&
      "targetUrl" in value &&
      typeof value.targetUrl === "string"
    )
      return value.targetUrl;
  }
  return undefined;
}
