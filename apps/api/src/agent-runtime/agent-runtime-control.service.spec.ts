import { describe, expect, it, vi } from "vitest";

import { AgentRuntimeControlService } from "./agent-runtime-control.service.js";

vi.mock("../config/env.js", () => ({
  env: () => ({ POST_RUN_ANALYSIS_CONCURRENCY: 3 }),
}));

const teamId = "4a9f2473-0b1f-4de8-87d7-2ac49b425d75";

describe("Agent Runtime pool registration", () => {
  it("derives Browser lane concurrency from all online execution nodes", async () => {
    const prisma = {
      browserRuntime: {
        findMany: vi.fn().mockResolvedValue([
          { id: "runtime-a", maxConcurrency: 4 },
          { id: "runtime-b", maxConcurrency: 8 },
          { id: "runtime-offline", maxConcurrency: 16 },
        ]),
      },
    };
    const redis = {
      assignAgentRuntimeConcurrency: vi.fn(
        async (_teamId: string, _workerId: string, total: number) => total,
      ),
      isRuntimeOnline: vi.fn(async (id: string) => id !== "runtime-offline"),
    };
    const service = new AgentRuntimeControlService(
      prisma as never,
      redis as never,
    );

    await expect(
      service.register(
        {
          credential: { pool: "BROWSER_EXECUTION" },
          team: { id: teamId },
        } as never,
        { protocol: { minor: 4 }, workerId: "browser-worker" },
      ),
    ).resolves.toEqual({
      analysisConcurrency: 0,
      browserConcurrency: 12,
      pools: ["BROWSER_EXECUTION"],
      refreshAfterMs: 5_000,
      specConcurrency: 0,
    });
    expect(redis.assignAgentRuntimeConcurrency).toHaveBeenCalledWith(
      teamId,
      "browser-worker",
      12,
    );
  });

  it("does not read Browser capacity for a Spec-only credential", async () => {
    const findMany = vi.fn();
    const service = new AgentRuntimeControlService(
      { browserRuntime: { findMany } } as never,
      {} as never,
    );

    await expect(
      service.register(
        {
          credential: { pool: "SPEC_ANALYSIS" },
          team: { id: teamId },
        } as never,
        { protocol: { minor: 7 }, workerId: "spec-worker" },
      ),
    ).resolves.toMatchObject({
      analysisConcurrency: 0,
      browserConcurrency: 0,
      pools: ["SPEC_ANALYSIS"],
      specConcurrency: 5,
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("advertises the configured post-run analysis lane capacity", async () => {
    const service = new AgentRuntimeControlService({} as never, {} as never);

    await expect(
      service.register(
        {
          credential: { pool: "POST_RUN_ANALYSIS" },
          team: { id: teamId },
        } as never,
        { protocol: { minor: 7 }, workerId: "analysis-worker" },
      ),
    ).resolves.toMatchObject({
      analysisConcurrency: 3,
      browserConcurrency: 0,
      pools: ["POST_RUN_ANALYSIS"],
      specConcurrency: 0,
    });
  });

  it("rejects legacy mixed credentials", async () => {
    const service = new AgentRuntimeControlService({} as never, {} as never);
    await expect(
      service.register(
        {
          credential: { pool: "MIXED" },
          team: { id: teamId },
        } as never,
        { protocol: { minor: 7 }, workerId: "legacy-worker" },
      ),
    ).rejects.toThrow("MIXED");
  });

  it("rejects registration clients older than the compatible v4 baseline", async () => {
    const service = new AgentRuntimeControlService({} as never, {} as never);

    await expect(
      service.register(
        {
          credential: { pool: "SPEC_ANALYSIS" },
          team: { id: teamId },
        } as never,
        { protocol: { minor: 3 }, workerId: "outdated-worker" },
      ),
    ).rejects.toThrow("minor 4 or newer");
  });
});
