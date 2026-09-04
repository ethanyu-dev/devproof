import { Prisma } from "@prisma/client";
import type { UserBrowserProfileUpdateInput } from "@devproof/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserBrowserProfilesService } from "./user-browser-profiles.service.js";

const current = { user: { id: "user-1" }, team: { id: "team-1" } };

function fixture(lockedChanges: Record<string, unknown> = {}) {
  const profile = {
    id: "profile-1",
    ownerUserId: "user-1",
    teamId: "team-1",
    version: 7,
    status: "READY",
    executionMode: "SERIAL_PERSISTENT",
    executionConcurrency: 1,
    assignedRuntimeId: "runtime-1",
    authSnapshotGeneration: 5,
    authSnapshotCreatedAt: new Date("2026-01-01T00:00:00Z"),
    inactivityExpiresAt: new Date("2099-01-01T00:00:00Z"),
    verificationUrl: "https://app.example.com/settings",
    verificationRules: {},
    authRole: "default",
    environmentKey: "default",
    runtimeProfileKey: "secret-local-profile-key",
    grants: [{ triggerSource: "CONSOLE", revokedAt: null }],
    runtimeSessions: [],
  };
  const lockedProfile = { ...profile, ...lockedChanges };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    userBrowserProfile: {
      findFirst: vi.fn().mockResolvedValue(lockedProfile),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(lockedProfile),
    },
    browserRuntime: {
      findFirst: vi.fn().mockResolvedValue({ id: "runtime-1" }),
    },
    executionRun: { count: vi.fn().mockResolvedValue(0) },
    browserRuntimeSession: { count: vi.fn().mockResolvedValue(0) },
    taskProfileBinding: { count: vi.fn().mockResolvedValue(0) },
    taskDeploymentProfileBinding: { count: vi.fn().mockResolvedValue(0) },
    browserProfileGrant: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    userBrowserProfile: { findFirst: vi.fn().mockResolvedValue(profile) },
    $transaction: vi
      .fn()
      .mockImplementation((run: (client: typeof tx) => unknown) => run(tx)),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new UserBrowserProfilesService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    audit as never,
  );
  return { service, tx, prisma, audit };
}

afterEach(() => vi.unstubAllEnvs());

describe("UserBrowserProfilesService configuration concurrency", () => {
  it("rejects a snapshot invalidated by another update while waiting for the profile lock", async () => {
    vi.stubEnv("BROWSER_ISOLATED_AUTH_ENABLED", "true");
    const { service, tx } = fixture({
      version: 8,
      authSnapshotGeneration: null,
    });

    await expect(
      service.update(current as never, "profile-1", {
        executionMode: "ISOLATED_AUTH",
      }),
    ).rejects.toThrow("changed concurrently");

    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.userBrowserProfile.findFirst.mock.invocationCallOrder[0]!,
    );
    expect(tx.userBrowserProfile.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { status: "REAUTH_REQUIRED" },
    { authSnapshotGeneration: null },
    { authSnapshotCreatedAt: null },
    { assignedRuntimeId: null },
    { inactivityExpiresAt: new Date("2020-01-01T00:00:00Z") },
  ])("checks the locked snapshot prerequisites: %o", async (lockedChanges) => {
    vi.stubEnv("BROWSER_ISOLATED_AUTH_ENABLED", "true");
    const { service, tx } = fixture(lockedChanges);
    await expect(
      service.update(current as never, "profile-1", {
        executionMode: "ISOLATED_AUTH",
      }),
    ).rejects.toThrow("Verify a compatible authentication snapshot");
    expect(tx.userBrowserProfile.updateMany).not.toHaveBeenCalled();
  });

  it("requires the snapshot's assigned runtime to remain enabled and compatible", async () => {
    vi.stubEnv("BROWSER_ISOLATED_AUTH_ENABLED", "true");
    const { service, tx } = fixture();
    tx.browserRuntime.findFirst.mockResolvedValue(null as never);
    await expect(
      service.update(current as never, "profile-1", {
        executionMode: "ISOLATED_AUTH",
      }),
    ).rejects.toThrow("assigned Browser Runtime");
    expect(tx.browserRuntime.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "runtime-1",
          teamId: "team-1",
          enabled: true,
          revokedAt: null,
          protocolMajor: 1,
          protocolMinor: { gte: 13 },
        }),
      }),
    );
    expect(tx.userBrowserProfile.updateMany).not.toHaveBeenCalled();
  });

  it.each<UserBrowserProfileUpdateInput>([
    { grants: ["FEISHU"] },
    { verificationUrl: "https://other.example.com/settings" },
    {
      verificationRules: {
        authenticatedSelector: "#account",
        loginUrlPatterns: [],
        successUrlPatterns: [],
      },
    },
    { executionMode: "SERIAL_PERSISTENT" },
    { executionConcurrency: 4 },
  ])(
    "blocks execution configuration changes when a task binds during the update: %o",
    async (input) => {
      const { service, tx } = fixture();
      tx.taskProfileBinding.count.mockResolvedValue(1);
      await expect(
        service.update(current as never, "profile-1", input),
      ).rejects.toThrow("Wait for bound tasks");
      expect(tx.taskProfileBinding.count).toHaveBeenCalledWith({
        where: {
          OR: [
            { resolvedProfileId: "profile-1" },
            { requestedProfileId: "profile-1" },
          ],
          taskExecution: {
            lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
          },
        },
      });
      expect(tx.taskDeploymentProfileBinding.count).toHaveBeenCalled();
      expect(tx.executionRun.count).toHaveBeenCalled();
      expect(tx.userBrowserProfile.updateMany).not.toHaveBeenCalled();
      expect(tx.browserProfileGrant.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["LOST", "FAILED"])(
    "retains the configuration guard for an unverified %s session",
    async (status) => {
      const { service, tx } = fixture();
      tx.browserRuntimeSession.count.mockImplementation(async ({ where }) =>
        where.closureVerifiedAt === null && where.status.not !== status ? 1 : 0,
      );
      await expect(
        service.update(current as never, "profile-1", { grants: ["FEISHU"] }),
      ).rejects.toThrow("confirmed closed");
      expect(tx.userBrowserProfile.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["executionRun", "taskDeploymentProfileBinding"] as const)(
    "checks %s inside the same locked transaction",
    async (source) => {
      const { service, tx } = fixture();
      tx[source].count.mockResolvedValue(1);
      await expect(
        service.update(current as never, "profile-1", {
          executionConcurrency: 4,
        }),
      ).rejects.toThrow("Wait for bound tasks");
      expect(tx.userBrowserProfile.updateMany).not.toHaveBeenCalled();
    },
  );

  it("enables isolation with a verified snapshot using a version-checked write", async () => {
    vi.stubEnv("BROWSER_ISOLATED_AUTH_ENABLED", "true");
    const { service, tx, prisma, audit } = fixture();
    await service.update(current as never, "profile-1", {
      executionMode: "ISOLATED_AUTH",
      executionConcurrency: 4,
    });
    expect(tx.userBrowserProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "profile-1",
          ownerUserId: "user-1",
          teamId: "team-1",
          version: 7,
        },
        data: expect.objectContaining({
          executionMode: "ISOLATED_AUTH",
          executionConcurrency: 4,
          version: { increment: 1 },
        }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(audit.record).toHaveBeenCalled();
  });

  it("does not overwrite grants if a lifecycle transition wins the final version check", async () => {
    const { service, tx, audit } = fixture();
    tx.userBrowserProfile.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.update(current as never, "profile-1", { grants: ["FEISHU"] }),
    ).rejects.toThrow("changed concurrently");
    expect(tx.browserProfileGrant.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("returns a retryable configuration conflict for a concurrent serializable commit", async () => {
    const { service, prisma } = fixture();
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Concurrent update", {
        code: "P2034",
        clientVersion: "7",
      }),
    );
    await expect(
      service.update(current as never, "profile-1", {
        executionConcurrency: 4,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("still allows renaming a profile while it is in use", async () => {
    const { service, tx } = fixture();
    tx.executionRun.count.mockResolvedValue(1);
    await service.update(current as never, "profile-1", {
      displayName: "QA account",
    });
    expect(tx.executionRun.count).not.toHaveBeenCalled();
    expect(tx.userBrowserProfile.updateMany).toHaveBeenCalled();
  });
});
