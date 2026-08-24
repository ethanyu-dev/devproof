import { describe, expect, it } from "vitest";
import { verificationRequestSchema } from "@devproof/contracts";

import {
  hostnameMatchesPattern,
  matchingRuntimeRoutingRule,
  resolveRuntimeRoutingPlan,
  shuffleRuntimeCandidates,
  verificationTargetHostname,
} from "./runtime-routing.js";

const rules = [
  {
    fallbackPolicy: "WAIT" as const,
    hostnamePattern: "*.example.com",
    id: "wildcard",
    priority: 100,
    runtimeId: "runtime-wildcard",
  },
  {
    fallbackPolicy: "FAIL_FAST" as const,
    hostnamePattern: "admin.example.com",
    id: "exact",
    priority: 100,
    runtimeId: "runtime-exact",
  },
];

describe("runtime domain routing", () => {
  it("matches subdomains without matching the wildcard root", () => {
    expect(hostnameMatchesPattern("app.example.com", "*.example.com")).toBe(
      true,
    );
    expect(hostnameMatchesPattern("example.com", "*.example.com")).toBe(false);
  });

  it("prefers an exact rule when priorities are equal", () => {
    expect(matchingRuntimeRoutingRule("admin.example.com", rules)?.id).toBe(
      "exact",
    );
  });

  it("extracts the formal target URL and supports the legacy input", () => {
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Page loads", id: "loads" }],
      execution: {
        requiredCapabilities: ["browser"],
        targetUrl: "https://ADMIN.Example.com/path",
      },
      goal: "Verify the page",
      idempotencyKey: "routing-target",
      inputs: { targetUrl: "https://legacy.example.net" },
    });
    expect(verificationTargetHostname(request)).toBe("admin.example.com");
  });

  it("routes a matched hostname only to its configured Runtime", () => {
    expect(
      resolveRuntimeRoutingPlan({
        allRuntimeIds: ["runtime-exact", "runtime-pool"],
        hostname: "admin.example.com",
        rules,
      }),
    ).toMatchObject({
      availabilityPolicyOverride: "FAIL_FAST",
      candidateIds: ["runtime-exact"],
      routing: {
        priority: 100,
        ruleId: "exact",
        source: "DOMAIN_RULE",
      },
    });
  });

  it("uses the Runtime pool when no domain rule matches", () => {
    expect(
      resolveRuntimeRoutingPlan({
        allRuntimeIds: ["runtime-a", "runtime-b"],
        hostname: "unmatched.example.net",
        rules,
      }),
    ).toMatchObject({
      candidateIds: ["runtime-a", "runtime-b"],
      routing: { priority: 0, source: "POOL", targetRuntimeId: null },
    });
  });

  it("randomizes unmatched Runtime candidates without mutating the pool", () => {
    const pool = ["runtime-a", "runtime-b", "runtime-c"];

    expect(shuffleRuntimeCandidates(pool, () => 0)).toEqual([
      "runtime-b",
      "runtime-c",
      "runtime-a",
    ]);
    expect(pool).toEqual(["runtime-a", "runtime-b", "runtime-c"]);
  });
});
