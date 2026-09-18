import { describe, expect, it } from "vitest";
import {
  businessEnvironmentKey,
  resourceClaims,
  resourcesConflict,
} from "./execution-concurrency.js";

describe("shared backend execution locks", () => {
  it("coordinates users and tasks by the actual origin, including configured aliases", () => {
    const config = JSON.stringify([
      { hostname: "test.example.com", key: "shared-backend" },
      { hostname: "alias.example.com", key: "shared-backend" },
    ]);
    expect(businessEnvironmentKey("https://test.example.com/a", config)).toBe(
      businessEnvironmentKey("https://alias.example.com/b", config),
    );
    expect(businessEnvironmentKey("https://test.example.com/a", "[]")).toBe(
      businessEnvironmentKey("https://test.example.com/b", "[]"),
    );
  });
  it("shares reads but excludes unknown work and ancestor mutations", () => {
    const read = resourceClaims("https://example.com", {
      accessMode: "READ_ONLY",
      resourceScopes: ["models/1"],
    })[0]!;
    expect(resourcesConflict(read, read)).toBe(false);
    expect(
      resourcesConflict(
        read,
        resourceClaims("https://example.com", undefined)[0]!,
      ),
    ).toBe(true);
    expect(
      resourcesConflict(read, {
        ...read,
        resourceKey: "models",
        mode: "WRITE",
      }),
    ).toBe(true);
    expect(
      resourcesConflict(read, {
        ...read,
        resourceKey: "models/2",
        mode: "WRITE",
      }),
    ).toBe(false);
    expect(
      resourcesConflict(read, {
        ...read,
        resourceKey: "models/10",
        mode: "WRITE",
      }),
    ).toBe(false);
  });
  it("does not let missing targets or malformed policy escape exclusion", () => {
    const unknown = resourceClaims(undefined, { accessMode: "READ_ONLY" })[0]!;
    const scoped = resourceClaims("https://example.com", {
      accessMode: "READ_ONLY",
    })[0]!;
    expect(resourcesConflict(unknown, scoped)).toBe(true);
    expect(
      resourceClaims("https://example.com", {
        accessMode: "READ_ONLY",
        businessEnvironmentKey: "invented",
      })[0]!.mode,
    ).toBe("WRITE");
  });
  it("normalizes scope separators so collection locks cover their records", () => {
    const writer = resourceClaims("https://example.com", {
      accessMode: "MUTATING",
      resourceScopes: ["models/", "models//"],
    });
    const reader = resourceClaims("https://example.com", {
      accessMode: "READ_ONLY",
      resourceScopes: ["models//1/"],
    });
    expect(writer).toHaveLength(1);
    expect(resourcesConflict(writer[0]!, reader[0]!)).toBe(true);
  });
});

it("serializes assigned account mutations without enabling broad locks, while unrelated accounts and types stay parallel", async () => {
  const { executionResourceClaims } =
    await import("./execution-concurrency.js");
  const policy = (
    account: string,
    type: string,
    usage = "CREATE_OR_MODIFY",
    aliases: string[] = [],
  ) => ({
    testAccounts: [
      {
        slotId: "subject:1",
        account,
        aliases,
        usage,
        requiredTypes: type ? [type] : [],
      },
    ],
  });
  const claims = (
    account: string,
    type: string,
    usage?: string,
    aliases?: string[],
  ) =>
    executionResourceClaims(
      "https://app.test",
      { accessMode: "MUTATING" },
      policy(account, type, usage, aliases),
    ).filter((c) => c.resourceKey.startsWith("accounts/"));
  const a = claims("subject-a", "MAPPING")[0]!;
  expect(a.resourceKey).not.toContain("subject-a");
  expect(resourcesConflict(a, claims("subject-a", "MAPPING")[0]!)).toBe(true);
  expect(resourcesConflict(a, claims("subject-b", "MAPPING")[0]!)).toBe(false);
  expect(resourcesConflict(a, claims("subject-a", "OTHER")[0]!)).toBe(false);
  expect(resourcesConflict(a, claims("subject-a", "")[0]!)).toBe(true);
  const read = claims("subject-a", "MAPPING", "READ_EXISTING")[0]!;
  expect(resourcesConflict(read, read)).toBe(false);
  expect(resourcesConflict(a, read)).toBe(true);
  expect(
    claims("uuid-a", "MAPPING", "CREATE_OR_MODIFY", ["subject-a"]).some((c) =>
      resourcesConflict(a, c),
    ),
  ).toBe(true);
});
