import type {
  RuntimeRoutingFallbackPolicy,
  VerificationRequest,
} from "@devproof/contracts";

export interface RuntimeRoutingRuleLike {
  fallbackPolicy: RuntimeRoutingFallbackPolicy;
  hostnamePattern: string;
  id: string;
  priority: number;
  runtimeId: string;
}

export interface RuntimeRoutingPlan {
  availabilityPolicyOverride?: "WAIT" | "FAIL_FAST";
  candidateIds: string[];
  routing: {
    hostname: string | null;
    priority: number;
    ruleId: string | null;
    source: "DOMAIN_RULE" | "POOL";
    targetRuntimeId: string | null;
  };
}

export function verificationTargetHostname(
  request: VerificationRequest,
): string | null {
  const legacyTarget = request.inputs.targetUrl;
  const targetUrl =
    request.execution.targetUrl ??
    (typeof legacyTarget === "string" ? legacyTarget : undefined);
  if (!targetUrl) return null;
  try {
    return new URL(targetUrl).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return null;
  }
}

export function hostnameMatchesPattern(hostname: string, pattern: string) {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, "");
  const normalizedPattern = pattern.toLowerCase().replace(/\.$/u, "");
  if (!normalizedPattern.startsWith("*.")) {
    return normalizedHostname === normalizedPattern;
  }
  const suffix = normalizedPattern.slice(1);
  return (
    normalizedHostname.endsWith(suffix) &&
    normalizedHostname.length > suffix.length
  );
}

export function matchingRuntimeRoutingRule(
  hostname: string,
  rules: RuntimeRoutingRuleLike[],
) {
  return [...rules]
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }
      const leftWildcard = left.hostnamePattern.startsWith("*.");
      const rightWildcard = right.hostnamePattern.startsWith("*.");
      if (leftWildcard !== rightWildcard) return leftWildcard ? 1 : -1;
      return right.hostnamePattern.length - left.hostnamePattern.length;
    })
    .find((rule) => hostnameMatchesPattern(hostname, rule.hostnamePattern));
}

export function shuffleRuntimeCandidates<T>(
  items: T[],
  random: () => number = Math.random,
): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [
      shuffled[target] as T,
      shuffled[index] as T,
    ];
  }
  return shuffled;
}

export function resolveRuntimeRoutingPlan(input: {
  allRuntimeIds: string[];
  hostname: string | null;
  rules: RuntimeRoutingRuleLike[];
}): RuntimeRoutingPlan {
  const rule = input.hostname
    ? matchingRuntimeRoutingRule(input.hostname, input.rules)
    : undefined;
  if (rule) {
    return {
      availabilityPolicyOverride: rule.fallbackPolicy,
      candidateIds: [rule.runtimeId],
      routing: {
        hostname: input.hostname,
        priority: rule.priority,
        ruleId: rule.id,
        source: "DOMAIN_RULE",
        targetRuntimeId: rule.runtimeId,
      },
    };
  }

  return {
    candidateIds: input.allRuntimeIds,
    routing: {
      hostname: input.hostname,
      priority: 0,
      ruleId: null,
      source: "POOL",
      targetRuntimeId: null,
    },
  };
}
