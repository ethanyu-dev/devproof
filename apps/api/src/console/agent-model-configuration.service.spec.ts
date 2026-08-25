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
    position: 0,
    updatedAt: new Date("2026-08-25T00:00:00.000Z"),
  };
  const prisma = {
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
    });

    expect(cipher.encrypt).toHaveBeenCalledWith("sk-secret");
    expect(prisma.agentModelConfiguration.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          apiKeyEncrypted: "encrypted:sk-secret",
          position: 0,
        }),
      }),
    );
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("apiKeyEncrypted");
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

    await expect(service.candidatesForTeam(current.team.id)).resolves.toEqual([
      {
        apiKey: "plain:ciphertext",
        baseUrl: "https://gateway.example.com/v1",
        displayName: "Primary model",
        modelId: "provider/model-1",
      },
    ]);
    expect(cipher.decrypt).toHaveBeenCalledWith("ciphertext");
  });
});
