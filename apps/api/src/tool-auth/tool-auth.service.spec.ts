import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  AGENT_RUNTIME_TOKEN_PREFIX,
  extractBearerToken,
  hashToolToken,
  ToolAuthService,
} from "./tool-auth.service.js";

describe("tool authentication", () => {
  it("accepts only DevProof bearer tokens", () => {
    expect(extractBearerToken("Bearer dvp_sk_abc123")).toBe("dvp_sk_abc123");
    expect(extractBearerToken("Bearer dvp_rt_abc123")).toBe("dvp_rt_abc123");
    expect(() => extractBearerToken("Bearer external-token")).toThrow();
    expect(() => extractBearerToken(undefined)).toThrow();
  });

  it("stores a stable token hash instead of the credential", () => {
    expect(hashToolToken("dvp_sk_secret")).toHaveLength(64);
    expect(hashToolToken("dvp_sk_secret")).toBe(hashToolToken("dvp_sk_secret"));
    expect(hashToolToken("dvp_sk_secret")).not.toContain("secret");
  });

  it("rejects Runtime scope even when the service is called directly", async () => {
    const service = new ToolAuthService({} as never, {} as never);

    await expect(
      service.create(
        {
          team: { id: "team-1" },
          user: { id: "user-1" },
        } as never,
        {
          expiresAt: null,
          name: "Untrusted Runtime",
          scopes: ["runtime:lease"],
        } as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("authenticates registered Runtime credentials from the separate store", async () => {
    const token = `${AGENT_RUNTIME_TOKEN_PREFIX}registered`;
    const runtimeCredential = {
      expiresAt: null,
      id: "runtime-1",
      name: "Production Runtime",
      revokedAt: null,
      team: { id: "team-1", name: "Team", slug: "default" },
    };
    const prisma = {
      agentRuntimeCredential: {
        findUnique: vi.fn().mockResolvedValue(runtimeCredential),
        update: vi.fn().mockResolvedValue(runtimeCredential),
      },
      toolCredential: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    };
    const service = new ToolAuthService(prisma as never, {} as never);

    await expect(service.authenticate(`Bearer ${token}`)).resolves.toEqual({
      credential: {
        id: "runtime-1",
        kind: "AGENT_RUNTIME",
        name: "Production Runtime",
        scopes: ["runtime:lease"],
      },
      team: runtimeCredential.team,
    });
    expect(prisma.toolCredential.findUnique).not.toHaveBeenCalled();
  });
});
