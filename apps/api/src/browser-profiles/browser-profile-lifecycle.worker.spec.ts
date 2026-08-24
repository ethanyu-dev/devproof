import { describe, expect, it, vi } from "vitest";

import { BrowserProfileLifecycleWorker } from "./browser-profile-lifecycle.worker.js";

function fixture(
  profile: Record<string, unknown>,
  usage: { activeRuns?: number; activeSessions?: number } = {},
) {
  const tx = {
    browserProfileReservation: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    taskExecution: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    taskExecutionEvent: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    taskExecutionStage: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    taskProfileBinding: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    userBrowserProfile: { delete: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
    browserRuntimeSession: {
      count: vi.fn().mockResolvedValue(usage.activeSessions ?? 0),
    },
    executionRun: {
      count: vi.fn().mockResolvedValue(usage.activeRuns ?? 0),
    },
    taskProfileBinding: { findMany: vi.fn().mockResolvedValue([]) },
    userBrowserProfile: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(
          profile.inactivityExpiresAt instanceof Date &&
            profile.inactivityExpiresAt.getTime() <= Date.now()
            ? [profile]
            : [],
        )
        .mockResolvedValueOnce(
          (profile.owner as { memberships?: unknown[] }).memberships?.length
            ? []
            : [profile],
        ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const browser = { purgeProfile: vi.fn().mockResolvedValue({ purged: true }) };
  const metrics = { increment: vi.fn() };
  const sessions = { closeIdleProfileSessions: vi.fn().mockResolvedValue(0) };
  const worker = new BrowserProfileLifecycleWorker(
    prisma as never,
    browser as never,
    metrics as never,
    sessions as never,
  );
  return { browser, prisma, sessions, tx, worker };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: "profile-1",
    inactivityExpiresAt: new Date("2026-10-01T00:00:00.000Z"),
    owner: { memberships: [], status: "ACTIVE" },
    runtimeProfileKey: "opaque-profile-key",
    status: "READY",
    teamId: "team-1",
    version: 1,
    ...overrides,
  };
}

describe("BrowserProfileLifecycleWorker", () => {
  it("purges an active user's profile after its team membership is removed", async () => {
    const { browser, prisma, sessions, tx, worker } = fixture(profile());

    await expect(worker.sweep()).resolves.toEqual({ purged: 1 });

    expect(browser.purgeProfile).toHaveBeenCalledWith(
      "team-1",
      "opaque-profile-key",
      "profile-1",
    );
    expect(prisma.userBrowserProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DISABLED",
          verificationError: expect.objectContaining({
            code: "PROFILE_OWNER_OFFBOARDED",
          }),
        }),
      }),
    );
    expect(sessions.closeIdleProfileSessions).toHaveBeenCalledWith("profile-1");
    expect(tx.userBrowserProfile.delete).toHaveBeenCalledWith({
      where: { id: "profile-1" },
    });
  });

  it("defers physical deletion while the profile still has an active session", async () => {
    const expired = profile({
      inactivityExpiresAt: new Date("2026-07-01T00:00:00.000Z"),
      owner: {
        memberships: [{ teamId: "team-1" }],
        status: "ACTIVE",
      },
    });
    const { browser, prisma, sessions, tx, worker } = fixture(expired, {
      activeSessions: 1,
    });

    await expect(worker.sweep()).resolves.toEqual({ purged: 0 });

    expect(browser.purgeProfile).not.toHaveBeenCalled();
    expect(prisma.userBrowserProfile.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.userBrowserProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DISABLED",
          verificationError: expect.objectContaining({
            code: "PROFILE_INACTIVITY_EXPIRED",
          }),
        }),
      }),
    );
    expect(sessions.closeIdleProfileSessions).toHaveBeenCalledWith("profile-1");
    expect(tx.browserProfileReservation.updateMany).not.toHaveBeenCalled();
    expect(tx.taskProfileBinding.updateMany).not.toHaveBeenCalled();
  });

  it("does not detach tasks while an execution Run is still active", async () => {
    const expired = profile({
      inactivityExpiresAt: new Date("2026-07-01T00:00:00.000Z"),
      owner: {
        memberships: [{ teamId: "team-1" }],
        status: "ACTIVE",
      },
    });
    const { browser, tx, worker } = fixture(expired, { activeRuns: 1 });

    await expect(worker.sweep()).resolves.toEqual({ purged: 0 });

    expect(browser.purgeProfile).not.toHaveBeenCalled();
    expect(tx.browserProfileReservation.updateMany).not.toHaveBeenCalled();
    expect(tx.taskProfileBinding.updateMany).not.toHaveBeenCalled();
  });

  it("keeps the purge pending when an abandoned session cannot be closed", async () => {
    const expired = profile({
      inactivityExpiresAt: new Date("2026-07-01T00:00:00.000Z"),
      owner: {
        memberships: [{ teamId: "team-1" }],
        status: "ACTIVE",
      },
    });
    const { browser, sessions, tx, worker } = fixture(expired);
    sessions.closeIdleProfileSessions.mockRejectedValueOnce(
      new Error("runtime offline"),
    );

    await expect(worker.sweep()).resolves.toEqual({ purged: 0 });

    expect(browser.purgeProfile).not.toHaveBeenCalled();
    expect(tx.browserProfileReservation.updateMany).not.toHaveBeenCalled();
    expect(tx.taskProfileBinding.updateMany).not.toHaveBeenCalled();
  });

  it("paginates past valid members so a later offboarded Profile is not starved", async () => {
    const active = Array.from({ length: 100 }, (_, index) =>
      profile({
        id: `active-${index}`,
        owner: {
          memberships: [{ teamId: "team-1" }],
          status: "ACTIVE",
        },
      }),
    );
    const offboarded = profile({ id: "offboarded-profile" });
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce([offboarded]);
    const worker = new BrowserProfileLifecycleWorker(
      { userBrowserProfile: { findMany } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const findOffboarded = Reflect.get(worker, "findOffboardedProfiles") as (
      limit: number,
    ) => Promise<Array<{ id: string }>>;

    await expect(findOffboarded.call(worker, 25)).resolves.toEqual([
      expect.objectContaining({ id: "offboarded-profile" }),
    ]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
