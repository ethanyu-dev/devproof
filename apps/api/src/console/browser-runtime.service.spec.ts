import { UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { BrowserRuntimeService } from "./browser-runtime.service.js";

const current = {
  team: { id: "4a9f2473-0b1f-4de8-87d7-2ac49b425d75" },
  user: { id: "89bc00dd-5c69-4794-8dad-e55db5cb0ceb" },
} as never;

function fixture(protocolMinor: number | null = 4, online = true) {
  const runtime = {
    enabled: true,
    id: "26608aff-cdbf-4fa6-b5b3-0adef707454d",
    maxConcurrency: 4,
    networkAllowlist: ["test-console.paigod.work"],
    protocolMinor,
    revokedAt: null,
    status: "ONLINE",
    teamId: "4a9f2473-0b1f-4de8-87d7-2ac49b425d75",
    tokenHash: "not-returned",
  };
  const prisma = {
    browserRuntime: {
      findFirst: vi.fn().mockResolvedValue({ id: runtime.id }),
      update: vi.fn().mockResolvedValue(runtime),
    },
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const redis = { isRuntimeOnline: vi.fn().mockResolvedValue(online) };
  const hub = {
    close: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
  const service = new BrowserRuntimeService(
    prisma as never,
    audit as never,
    redis as never,
    hub as never,
  );
  return { audit, hub, prisma, redis, runtime, service };
}

describe("BrowserRuntimeService managed configuration", () => {
  it("reports separate A/B queue capacity and their configured total", async () => {
    const runtimes = [
      { id: "runtime-a", maxConcurrency: 4, name: "Browser A" },
      { id: "runtime-b", maxConcurrency: 8, name: "Browser B" },
    ];
    const prisma = {
      browserExecution: {
        count: vi.fn().mockResolvedValue(5),
        groupBy: vi.fn().mockResolvedValue([
          { _count: { _all: 7 }, targetRuntimeId: "runtime-a" },
          { _count: { _all: 1 }, targetRuntimeId: "runtime-b" },
        ]),
      },
      browserRuntime: { findMany: vi.fn().mockResolvedValue(runtimes) },
      browserRuntimeSlot: {
        groupBy: vi.fn().mockResolvedValue([
          { _count: { _all: 4 }, runtimeId: "runtime-a" },
          { _count: { _all: 3 }, runtimeId: "runtime-b" },
        ]),
      },
    };
    const service = new BrowserRuntimeService(
      prisma as never,
      {} as never,
      { isRuntimeOnline: vi.fn().mockResolvedValue(true) } as never,
      {} as never,
    );

    await expect(service.capacity(current)).resolves.toEqual({
      availableCapacity: 5,
      configuredCapacity: 12,
      drainingCapacity: 0,
      flexibleWaiting: 5,
      nodes: [
        {
          available: 0,
          configured: 4,
          draining: 0,
          id: "runtime-a",
          name: "Browser A",
          occupied: 4,
          online: true,
          waiting: 7,
        },
        {
          available: 5,
          configured: 8,
          draining: 0,
          id: "runtime-b",
          name: "Browser B",
          occupied: 3,
          online: true,
          waiting: 1,
        },
      ],
      occupiedCapacity: 7,
      schedulableCapacity: 12,
    });
  });

  it("persists and audits capacity while pushing network policy to a compatible online Runtime", async () => {
    const { audit, hub, prisma, runtime, service } = fixture();

    const result = await service.updateConfiguration(current, runtime.id, {
      maxConcurrency: 4,
      networkAllowlist: ["test-console.paigod.work"],
    });

    expect(prisma.browserRuntime.update).toHaveBeenCalledWith({
      data: {
        maxConcurrency: 4,
        networkAllowlist: ["test-console.paigod.work"],
      },
      where: { id: runtime.id },
    });
    expect(audit.record).toHaveBeenCalledWith(
      current,
      "runtime.configuration.updated",
      "browser_runtime",
      runtime.id,
      {
        maxConcurrency: 4,
        networkAllowlist: ["test-console.paigod.work"],
      },
    );
    expect(hub.send).toHaveBeenCalledWith(runtime.id, {
      networkAllowlist: ["test-console.paigod.work"],
      type: "runtime.network_policy.updated",
    });
    expect(result).toMatchObject({
      id: runtime.id,
      maxConcurrency: 4,
      networkAllowlist: ["test-console.paigod.work"],
      status: "ONLINE",
    });
    expect(result.tokenHash).toBeUndefined();
  });

  it("persists without pushing to a legacy Runtime", async () => {
    const { hub, runtime, service } = fixture(3);

    await service.updateConfiguration(current, runtime.id, {
      maxConcurrency: 3,
      networkAllowlist: ["test-console.paigod.work"],
    });

    expect(hub.send).not.toHaveBeenCalled();
  });

  it("does not update a Runtime owned by another team", async () => {
    const { prisma, runtime, service } = fixture();
    prisma.browserRuntime.findFirst.mockResolvedValue(null);

    await expect(
      service.updateConfiguration(current, runtime.id, {
        maxConcurrency: 2,
        networkAllowlist: [],
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.browserRuntime.update).not.toHaveBeenCalled();
  });

  it("uses the Runtime capacity only when first registering a device", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "runtime-id" });
    const tx = {
      browserRuntime: { upsert },
      browserRuntimePairingToken: {
        findUnique: vi.fn().mockResolvedValue({
          expiresAt: new Date(Date.now() + 60_000),
          id: "pairing-id",
          teamId: current.team.id,
          usedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const hub = { close: vi.fn(), send: vi.fn() };
    const service = new BrowserRuntimeService(
      prisma as never,
      { record: vi.fn() } as never,
      {} as never,
      hub as never,
    );

    await service.pair({
      capabilities: ["browser"],
      deviceInfo: "darwin",
      instanceKey: "device-1",
      maxConcurrency: 8,
      name: "MacBook",
      pairingToken: "x".repeat(32),
      version: "0.2.5",
    });

    const upsertInput = upsert.mock.calls[0]?.[0];
    expect(upsertInput.create.maxConcurrency).toBe(8);
    expect(upsertInput.update).not.toHaveProperty("maxConcurrency");
  });
});
