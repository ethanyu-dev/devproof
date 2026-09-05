import { UnauthorizedException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserRuntimeService } from "./browser-runtime.service.js";

const current = {
  team: { id: "4a9f2473-0b1f-4de8-87d7-2ac49b425d75" },
  user: { id: "89bc00dd-5c69-4794-8dad-e55db5cb0ceb" },
} as never;

function fixture(protocolMinor: number | null = 4, online = true) {
  const runtime = {
    enabled: true,
    connectionGeneration: 0n,
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
      findMany: vi.fn().mockResolvedValue([runtime]),
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
  it("serializes Runtime generations beyond Number precision in both Console responses", async () => {
    const f = fixture();
    f.runtime.connectionGeneration = 9_007_199_254_740_993_123n;
    const listed = await f.service.list(current);
    const configured = await f.service.updateConfiguration(
      current,
      f.runtime.id,
      { maxConcurrency: 4, networkAllowlist: [] },
    );
    for (const response of [listed[0], configured]) {
      expect(response?.connectionGeneration).toBe("9007199254740993123");
      expect(() => JSON.stringify(response)).not.toThrow();
      expect(JSON.stringify(response)).toContain(
        '"connectionGeneration":"9007199254740993123"',
      );
    }
  });
  it("reports separate A/B queue capacity and their configured total", async () => {
    const runtimes = [
      { id: "runtime-a", maxConcurrency: 4, name: "Browser A" },
      { id: "runtime-b", maxConcurrency: 8, name: "Browser B" },
    ];
    const prisma = {
      browserExecution: {
        findMany: vi.fn().mockResolvedValue([
          {
            error: { code: "NO_AVAILABLE_SLOT" },
            targetRuntimeId: "runtime-a",
          },
          {
            error: { code: "IDENTITY_CAPACITY" },
            targetRuntimeId: "runtime-b",
          },
        ]),
        count: vi.fn().mockResolvedValue(5),
        groupBy: vi.fn().mockResolvedValue([
          { _count: { _all: 7 }, targetRuntimeId: "runtime-a" },
          { _count: { _all: 1 }, targetRuntimeId: "runtime-b" },
        ]),
      },
      browserRuntime: { findMany: vi.fn().mockResolvedValue(runtimes) },
      browserRuntimeSession: { groupBy: vi.fn().mockResolvedValue([]) },
      taskCaseExecution: {
        findMany: vi.fn().mockResolvedValue([
          {
            taskExecutionId: "task-1",
            caseId: "case-1",
            deploymentId: "deployment-1",
            executionOrdinal: 1,
            dispatchStatus: "PENDING",
            dispatchAttempts: 0,
            runId: null,
            scheduling: { state: "WAITING", reason: "PROFILE_RESERVED" },
          },
          {
            taskExecutionId: "task-1",
            caseId: "case-2",
            deploymentId: "deployment-1",
            executionOrdinal: 1,
            dispatchStatus: "CANCELLED",
            dispatchAttempts: 0,
            runId: null,
            scheduling: null,
          },
        ]),
      },
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
      runtimeWaiting: 1,
      flexibleRuntimeWaiting: 0,
      upstreamWaiting: 2,
      upstreamWaitingByReason: { IDENTITY_LIMIT: 1, PROFILE_RESERVED: 1 },
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
          quarantined: 0,
          runtimeWaiting: 1,
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
          quarantined: 0,
          runtimeWaiting: 0,
          waiting: 1,
        },
      ],
      occupiedCapacity: 7,
      schedulableCapacity: 12,
    });
  });

  it("counts admitted Agent waits once without counting terminal, stale, or admission-waiting rows twice", async () => {
    const row = (
      caseId: string,
      runId: string,
      lifecycle = "PREPARING",
      executionOrdinal = 1,
    ) => ({
      taskExecutionId: "task-1",
      caseId,
      deploymentId: "deployment-1",
      executionOrdinal,
      dispatchStatus: "LINKED",
      dispatchAttempts: 1,
      runId,
      run: { lifecycle, executionDisposition: null, verdict: null },
      scheduling: { state: "ADMITTED", reason: "AGENT_CAPACITY" },
    });
    const prisma = {
      browserRuntime: { findMany: vi.fn().mockResolvedValue([]) },
      browserRuntimeSlot: { groupBy: vi.fn().mockResolvedValue([]) },
      browserRuntimeSession: { groupBy: vi.fn().mockResolvedValue([]) },
      browserExecution: {
        count: vi.fn().mockResolvedValue(1),
        groupBy: vi.fn().mockResolvedValue([]),
        findMany: vi.fn().mockResolvedValue([
          {
            runId: "admitting",
            targetRuntimeId: null,
            error: { code: "NO_AVAILABLE_SLOT" },
          },
        ]),
      },
      taskCaseExecution: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            row("ready", "waiting-agent"),
            row("admission", "admitting"),
            row("finished", "complete", "COMPLETED"),
            row("human", "human-run", "WAITING_HUMAN"),
            row("retried", "old-run", "PREPARING", 1),
            row("retried", "new-run", "COMPLETED", 2),
          ]),
      },
    };
    const service = new BrowserRuntimeService(
      prisma as never,
      {} as never,
      { isRuntimeOnline: vi.fn().mockResolvedValue(true) } as never,
      {} as never,
    );
    await expect(service.capacity(current)).resolves.toMatchObject({
      runtimeWaiting: 1,
      upstreamWaiting: 1,
      upstreamWaitingByReason: { AGENT_CAPACITY: 1 },
    });
    expect(prisma.browserExecution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ runId: true }),
      }),
    );
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
      $queryRaw: vi.fn().mockResolvedValue([]),
      browserRuntime: { upsert, findUnique: vi.fn().mockResolvedValue(null) },
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

  it.each(["FROZEN", "DRAINED"])(
    "does not consume a pairing token or revive a %s Runtime",
    async (drainState) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        browserRuntime: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ id: "runtime-id", drainState }),
          upsert: vi.fn(),
        },
        browserRuntimePairingToken: {
          findUnique: vi.fn().mockResolvedValue({
            id: "pairing-id",
            teamId: current.team.id,
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
          }),
          updateMany: vi.fn(),
        },
      };
      const service = new BrowserRuntimeService(
        {
          $transaction: vi.fn(
            (operation: (client: typeof tx) => Promise<unknown>) =>
              operation(tx),
          ),
        } as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await expect(
        service.pair({
          capabilities: ["browser"],
          deviceInfo: "linux",
          instanceKey: "device-1",
          maxConcurrency: 4,
          name: "Frozen node",
          pairingToken: "x".repeat(32),
          version: "0.2.18",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.browserRuntime.findUnique.mock.invocationCallOrder[0]!,
      );
      expect(tx.browserRuntimePairingToken.updateMany).not.toHaveBeenCalled();
      expect(tx.browserRuntime.upsert).not.toHaveBeenCalled();
    },
  );
});

describe("BrowserRuntimeService revocation preserves closure protection", () => {
  afterEach(() => vi.unstubAllEnvs());

  function revokeFixture() {
    const runtimeId = "26608aff-cdbf-4fa6-b5b3-0adef707454d";
    const proofTime = new Date("2026-09-05T00:00:00Z");
    const rows = [
      {
        id: "active",
        runtimeId,
        status: "ACTIVE",
        closureVerifiedAt: null,
        closureEvidenceId: null,
        quarantinedAt: null,
      },
      {
        id: "failed",
        runtimeId,
        status: "FAILED",
        closureVerifiedAt: null,
        closureEvidenceId: null,
        quarantinedAt: null,
      },
      {
        id: "verified",
        runtimeId,
        status: "CLOSED",
        closureVerifiedAt: proofTime,
        closureEvidenceId: "proof-id",
        quarantinedAt: null,
      },
      {
        id: "legacy-closed",
        runtimeId,
        status: "CLOSED",
        closureVerifiedAt: null,
        closureEvidenceId: null,
        quarantinedAt: null,
      },
    ];
    const eligible = (
      row: (typeof rows)[number],
      where: Record<string, unknown>,
    ) =>
      row.runtimeId === where.runtimeId &&
      row.closureVerifiedAt === null &&
      row.status !== "CLOSED" &&
      (!Object.hasOwn(where, "quarantinedAt") || row.quarantinedAt === null);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      browserRuntime: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      browserRuntimeSession: {
        updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
          const selected = rows.filter((row) => eligible(row, where));
          for (const row of selected) Object.assign(row, data);
          return { count: selected.length };
        }),
        findMany: vi
          .fn()
          .mockImplementation(async ({ where }) =>
            rows
              .filter((row) => eligible(row, where))
              .map(({ id }) => ({ id })),
          ),
      },
      executionResourceLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
        deleteMany: vi.fn(),
      },
      browserRuntimeSlot: { deleteMany: vi.fn() },
      browserRuntimeProfileLease: { deleteMany: vi.fn() },
    };
    const prisma = {
      ...tx,
      $transaction: vi.fn(
        async (operation: (client: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const hub = { close: vi.fn() };
    const recovery = { request: vi.fn().mockResolvedValue({ id: "recovery" }) };
    const service = new BrowserRuntimeService(
      prisma as never,
      audit as never,
      {} as never,
      hub as never,
      recovery as never,
    );
    return { service, tx, audit, hub, recovery, rows, runtimeId, proofTime };
  }

  it("revokes authority, retains physical leases, and requests recovery for every unverified state", async () => {
    vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true");
    const f = revokeFixture();
    await f.service.revoke(current, f.runtimeId);
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(f.hub.close).toHaveBeenCalledWith(
      f.runtimeId,
      4003,
      "Runtime credential was revoked.",
    );
    expect(f.rows.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "active",
          status: "LOST",
          executionPermitExpiresAt: expect.any(Date),
          humanControllerUserId: null,
        }),
        expect.objectContaining({ id: "failed", status: "LOST" }),
      ]),
    );
    expect(f.recovery.request.mock.calls).toEqual([
      ["active", "RUNTIME_REVOKED", { explicitClose: true }],
      ["failed", "RUNTIME_REVOKED", { explicitClose: true }],
    ]);
    expect(f.tx.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.browserRuntimeProfileLease.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.executionResourceLease.updateMany).toHaveBeenCalledWith({
      where: {
        mode: "WRITE",
        session: {
          runtimeId: f.runtimeId,
          closureVerifiedAt: null,
          status: { not: "CLOSED" },
        },
      },
      data: { quarantined: true },
    });
  });

  it("does not overwrite proof or historical CLOSED state when revoke arrives late", async () => {
    vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true");
    const f = revokeFixture();
    await f.service.revoke(current, f.runtimeId);
    expect(f.rows[2]).toMatchObject({
      status: "CLOSED",
      closureVerifiedAt: f.proofTime,
      closureEvidenceId: "proof-id",
      quarantinedAt: null,
    });
    expect(f.rows[3]).toMatchObject({
      status: "CLOSED",
      closureVerifiedAt: null,
    });
    expect(f.recovery.request).not.toHaveBeenCalledWith(
      "verified",
      expect.anything(),
      expect.anything(),
    );
  });

  it("keeps protection while the rollout barrier disables new recovery materialization", async () => {
    vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "false");
    const f = revokeFixture();
    await f.service.revoke(current, f.runtimeId);
    expect(f.rows[0]?.status).toBe("LOST");
    expect(f.tx.browserRuntimeSession.findMany).not.toHaveBeenCalled();
    expect(f.recovery.request).not.toHaveBeenCalled();
    expect(f.tx.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.browserRuntimeProfileLease.deleteMany).not.toHaveBeenCalled();
    expect(f.audit.record).toHaveBeenCalledWith(
      current,
      "runtime.revoked",
      "browser_runtime",
      f.runtimeId,
    );
  });

  it("rejects another team's Runtime before mutating its sessions", async () => {
    vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true");
    const f = revokeFixture();
    f.tx.browserRuntime.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(f.service.revoke(current, f.runtimeId)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(f.tx.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
    expect(f.hub.close).not.toHaveBeenCalled();
    expect(f.recovery.request).not.toHaveBeenCalled();
  });
});
