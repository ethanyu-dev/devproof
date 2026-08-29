type ProfileUnavailablePolicy = "FAIL" | "USE_EPHEMERAL" | "WAIT_FOR_PROFILE";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function retainedProfilePolicy(input: unknown): {
  onUnavailable: ProfileUnavailablePolicy;
  scope: { authRole: string; environmentKey: string; hostname?: string };
} {
  const fallback = {
    onUnavailable: "WAIT_FOR_PROFILE" as const,
    scope: { authRole: "default", environmentKey: "default" },
  };
  if (!isRecord(input) || !isRecord(input.profilePolicy)) return fallback;
  const profilePolicy = input.profilePolicy;
  const onUnavailable = ["FAIL", "USE_EPHEMERAL", "WAIT_FOR_PROFILE"].includes(
    String(profilePolicy.onUnavailable),
  )
    ? (profilePolicy.onUnavailable as ProfileUnavailablePolicy)
    : fallback.onUnavailable;
  if (!isRecord(profilePolicy.scope)) {
    return { ...fallback, onUnavailable };
  }
  const authRole = profilePolicy.scope.authRole;
  const environmentKey = profilePolicy.scope.environmentKey;
  if (typeof authRole !== "string" || typeof environmentKey !== "string") {
    return { ...fallback, onUnavailable };
  }
  const hostname = profilePolicy.scope.hostname;
  return {
    onUnavailable,
    scope: {
      authRole,
      environmentKey,
      ...(typeof hostname === "string" && hostname ? { hostname } : {}),
    },
  };
}
