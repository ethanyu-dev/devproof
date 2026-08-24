import { describe, expect, it } from "vitest";

import {
  assertAllowedTenant,
  TenantAccessDeniedError,
} from "./feishu-oauth.client.js";

describe("configured Feishu tenant policy", () => {
  it("allows the configured tenant", () => {
    expect(() =>
      assertAllowedTenant("tenant-allowed", "tenant-allowed"),
    ).not.toThrow();
  });

  it("rejects a different tenant even when OAuth succeeded", () => {
    expect(() =>
      assertAllowedTenant("tenant-external", "tenant-allowed"),
    ).toThrow(TenantAccessDeniedError);
  });

  it("rejects an absent tenant identity", () => {
    expect(() => assertAllowedTenant("", "tenant-allowed")).toThrow(
      TenantAccessDeniedError,
    );
  });
});
