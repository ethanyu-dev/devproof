import { describe, expect, it, vi } from "vitest";

import { RuntimeSessionsService } from "./runtime-sessions.service.js";

describe("RuntimeSessionsService user Profile isolation", () => {
  it("rejects a READY logical user Profile after its inactivity deadline", async () => {
    const prisma = {
      browserRuntime: {
        findFirst: vi.fn().mockResolvedValue({
          id: "runtime-1",
          maxConcurrency: 1,
          protocolMinor: 9,
        }),
      },
      userBrowserProfile: {
        findFirst: vi.fn().mockResolvedValue({
          assignedRuntimeId: "runtime-1",
          id: "profile-1",
          inactivityExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
          runtimeProfileKey: "opaque-user-profile",
          status: "READY",
        }),
      },
    };
    const redis = { isRuntimeOnline: vi.fn() };
    const commands = { execute: vi.fn() };
    const sessions = new RuntimeSessionsService(
      prisma as never,
      redis as never,
      commands as never,
      {} as never,
      {} as never,
    );

    await expect(
      sessions.create(
        {
          sessionId: "session-cookie",
          team: { id: "team-1", name: "Team", slug: "team" },
          user: {
            avatarUrl: null,
            email: "user@example.com",
            id: "user-1",
            name: "User",
          },
        },
        {
          profileMode: "PERSISTENT",
          purpose: "EXECUTION",
          runtimeId: "runtime-1",
          userBrowserProfileId: "profile-1",
        },
      ),
    ).rejects.toThrow("expired");
    expect(redis.isRuntimeOnline).not.toHaveBeenCalled();
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it("rejects a legacy persistent session opened with a raw user Profile key", async () => {
    const prisma = {
      browserRuntime: {
        findFirst: vi.fn().mockResolvedValue({
          id: "runtime-1",
          maxConcurrency: 1,
          protocolMinor: 9,
        }),
      },
      userBrowserProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: "profile-1" }),
      },
    };
    const redis = { isRuntimeOnline: vi.fn() };
    const sessions = new RuntimeSessionsService(
      prisma as never,
      redis as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      sessions.create(
        {
          sessionId: "session-cookie",
          team: { id: "team-1", name: "Team", slug: "team" },
          user: {
            avatarUrl: null,
            email: "user@example.com",
            id: "user-1",
            name: "User",
          },
        },
        {
          profileKey: "opaque-user-profile",
          profileMode: "PERSISTENT",
          purpose: "EXECUTION",
          runtimeId: "runtime-1",
        },
      ),
    ).rejects.toThrow("logical profile id");
    expect(redis.isRuntimeOnline).not.toHaveBeenCalled();
  });

  it("redacts nested raw keys from user Profile session command responses", async () => {
    const prisma = {
      browserRuntimeSession: {
        findFirst: vi.fn().mockResolvedValue({
          artifacts: [],
          commands: [
            {
              error: null,
              fencingToken: 1n,
              payload: {
                nested: { runtimeProfileKey: "opaque-user-profile" },
                profileKey: "opaque-user-profile",
              },
              result: { profileKey: "opaque-user-profile", purged: true },
            },
          ],
          events: [],
          fencingToken: 1n,
          id: "session-1",
          profileKey: "opaque-user-profile",
          runtime: { id: "runtime-1", name: "Runtime", status: "ONLINE" },
          userBrowserProfileId: "profile-1",
        }),
      },
    };
    const sessions = new RuntimeSessionsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const current = {
      sessionId: "session-cookie",
      team: { id: "team-1", name: "Team", slug: "team" },
      user: {
        avatarUrl: null,
        email: "user@example.com",
        id: "user-1",
        name: "User",
      },
    };

    const detail = await sessions.detail(current, "session-1");

    expect(detail.profileKey).toBeNull();
    expect(JSON.stringify(detail.commands)).not.toContain(
      "opaque-user-profile",
    );
    expect(detail.commands[0]?.payload).toEqual({ nested: {} });
  });
});

describe("RuntimeSessionsService lifecycle cleanup", () => {
  it("closes abandoned preparation sessions and releases their leases", async () => {
    const prisma = {
      $transaction: vi.fn(async (operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
      browserRuntimeProfileLease: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      browserRuntimeSession: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "session-1", status: "ACTIVE" }]),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      browserRuntimeSlot: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const commands = {
      execute: vi.fn().mockResolvedValue({ status: "SUCCEEDED" }),
    };
    const sessions = new RuntimeSessionsService(
      prisma as never,
      {} as never,
      commands as never,
      {} as never,
      {} as never,
    );

    await expect(sessions.closeIdleProfileSessions("profile-1")).resolves.toBe(
      1,
    );

    expect(prisma.browserRuntimeSession.findMany).toHaveBeenCalledWith({
      where: {
        purpose: {
          in: ["PROFILE_PREPARATION", "PROFILE_VERIFICATION"],
        },
        status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"] },
        userBrowserProfileId: "profile-1",
      },
    });
    expect(commands.execute).toHaveBeenCalledWith({
      commandType: "session.close",
      sessionId: "session-1",
      source: "SYSTEM",
    });
    expect(prisma.browserRuntimeSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CLOSED" }),
        where: { id: "session-1" },
      }),
    );
    expect(prisma.browserRuntimeSlot.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: "session-1" },
    });
    expect(prisma.browserRuntimeProfileLease.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: "session-1" },
    });
  });
});
