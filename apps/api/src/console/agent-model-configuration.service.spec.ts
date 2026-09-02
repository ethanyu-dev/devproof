import { describe, expect, it, vi } from "vitest";

import { AgentModelConfigurationService } from "./agent-model-configuration.service.js";

const current = {
  team: { id: "4a9f2473-0b1f-4de8-87d7-2ac49b425d75" },
  user: { id: "89bc00dd-5c69-4794-8dad-e55db5cb0ceb" },
} as never;

function fixture() {
  const row = {
    apiKeyHint: "••••cret",
    baseUrl: "https://gateway.example.com/v1",
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    displayName: "Primary model",
    id: "model-1",
    modelId: "provider/model-1",
    pool: "BROWSER_EXECUTION" as const,
    position: 0,
    updatedAt: new Date("2026-08-25T00:00:00.000Z"),
  };
  const prisma = {
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
    ),
    agentModelConfiguration: {
      aggregate: vi.fn().mockResolvedValue({ _max: { position: null } }),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(row),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({
        baseUrl: row.baseUrl,
        id: row.id,
      }),
      update: vi.fn().mockResolvedValue(row),
    },
  };
  const cipher = {
    decrypt: vi.fn((value: string) => `plain:${value}`),
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    hint: vi.fn(() => row.apiKeyHint),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    audit,
    cipher,
    prisma,
    row,
    service: new AgentModelConfigurationService(
      prisma as never,
      cipher as never,
      audit as never,
    ),
  };
}

describe("AgentModelConfigurationService", () => {
  it("encrypts API keys and never returns them", async () => {
    const { cipher, prisma, service } = fixture();

    const result = await service.create(current, {
      apiKey: "sk-secret",
      baseUrl: "https://gateway.example.com/v1",
      displayName: "Primary model",
      modelId: "provider/model-1",
      pool: "BROWSER_EXECUTION",
    });

    expect(cipher.encrypt).toHaveBeenCalledWith("sk-secret");
    expect(prisma.agentModelConfiguration.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          apiKeyEncrypted: "encrypted:sk-secret",
          pool: "BROWSER_EXECUTION",
          position: 0,
        }),
      }),
    );
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("apiKeyEncrypted");
  });

  it("applies the model limit independently to each Runtime pool", async () => {
    const { prisma, service } = fixture();
    prisma.agentModelConfiguration.count.mockResolvedValue(10);

    await expect(
      service.create(current, {
        apiKey: "sk-secret",
        baseUrl: "https://gateway.example.com/v1",
        displayName: "Overflow",
        modelId: "provider/model-overflow",
        pool: "POST_RUN_ANALYSIS",
      }),
    ).rejects.toThrow(/POST_RUN_ANALYSIS/u);
    expect(prisma.agentModelConfiguration.count).toHaveBeenCalledWith({
      where: {
        pool: "POST_RUN_ANALYSIS",
        teamId: current.team.id,
      },
    });
    expect(prisma.agentModelConfiguration.create).not.toHaveBeenCalled();
  });

  it("reorders models only inside the selected Runtime pool", async () => {
    const { prisma, service } = fixture();
    const ids = [
      "d63bd843-b89d-48ea-90c9-caad5b51d526",
      "d11bd843-b89d-48ea-90c9-caad5b51d527",
    ];
    prisma.agentModelConfiguration.findMany
      .mockResolvedValueOnce(ids.map((id) => ({ id })) as never)
      .mockResolvedValueOnce([]);

    await service.reorder(current, { ids, pool: "SPEC_ANALYSIS" });

    expect(prisma.agentModelConfiguration.findMany).toHaveBeenNthCalledWith(1, {
      select: { id: true },
      where: { pool: "SPEC_ANALYSIS", teamId: current.team.id },
    });
    expect(prisma.agentModelConfiguration.update).toHaveBeenNthCalledWith(1, {
      data: { position: 0 },
      where: { id: ids[0] },
    });
  });

  it("keeps the encrypted key when an update omits API key", async () => {
    const { cipher, prisma, service } = fixture();

    await service.update(current, "model-1", {
      baseUrl: "https://gateway.example.com/v1",
      displayName: "Primary model",
      modelId: "provider/model-2",
    });

    expect(cipher.encrypt).not.toHaveBeenCalled();
    expect(prisma.agentModelConfiguration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          apiKeyEncrypted: expect.anything(),
        }),
        where: {
          baseUrl: "https://gateway.example.com/v1",
          id: "model-1",
          teamId: current.team.id,
        },
      }),
    );
  });

  it("requires a replacement key when the Base URL changes", async () => {
    const { cipher, prisma, service } = fixture();

    await expect(
      service.update(current, "model-1", {
        baseUrl: "https://attacker.example.com/v1",
        displayName: "Primary model",
        modelId: "provider/model-1",
      }),
    ).rejects.toThrow(/also requires a replacement API key/u);

    expect(cipher.encrypt).not.toHaveBeenCalled();
    expect(prisma.agentModelConfiguration.update).not.toHaveBeenCalled();
  });

  it("replaces the Base URL and API key atomically", async () => {
    const { cipher, prisma, service } = fixture();

    await service.update(current, "model-1", {
      apiKey: "sk-replacement",
      baseUrl: "https://replacement.example.com/v1",
      displayName: "Primary model",
      modelId: "provider/model-1",
    });

    expect(prisma.agentModelConfiguration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          apiKeyEncrypted: "encrypted:sk-replacement",
          baseUrl: "https://replacement.example.com/v1",
        }),
        where: { id: "model-1", teamId: current.team.id },
      }),
    );
  });

  it("decrypts ordered model candidates only for Runtime delivery", async () => {
    const { cipher, prisma, service } = fixture();
    prisma.agentModelConfiguration.findMany.mockResolvedValue([
      {
        apiKeyEncrypted: "ciphertext",
        baseUrl: "https://gateway.example.com/v1",
        displayName: "Primary model",
        modelId: "provider/model-1",
      },
    ] as never);

    await expect(
      service.candidatesForPool(current.team.id, "SPEC_ANALYSIS"),
    ).resolves.toEqual([
      {
        apiKey: "plain:ciphertext",
        baseUrl: "https://gateway.example.com/v1",
        displayName: "Primary model",
        modelId: "provider/model-1",
      },
    ]);
    expect(prisma.agentModelConfiguration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pool: "SPEC_ANALYSIS", teamId: current.team.id },
      }),
    );
    expect(cipher.decrypt).toHaveBeenCalledWith("ciphertext");
  });
});
