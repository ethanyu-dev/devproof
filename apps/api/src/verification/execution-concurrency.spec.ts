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
