import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvForTests } from "../config/env.js";

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
          launchConnectionGeneration: 9007199254740993n,
          commands: [
            {
              error: null,
              fencingToken: 1n,
              ownerFencingToken: 9007199254740993n,
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
    expect(detail.launchConnectionGeneration).toBe("9007199254740993");
    expect(() => JSON.stringify(detail)).not.toThrow();
    expect(JSON.stringify(detail.commands)).not.toContain(
      "opaque-user-profile",
    );
    expect(detail.commands[0]?.payload).toEqual({ nested: {} });
    expect(detail.commands[0]?.ownerFencingToken).toBe("9007199254740993");
  });
});

describe("RuntimeSessionsService preparation admission", () => {
  const current = {
    sessionId: "cookie",
    team: { id: "team-1", name: "Team", slug: "team" },
    user: {
      id: "user-1",
      name: "User",
      email: "user@example.com",
      avatarUrl: null,
    },
  };
  const input = {
    profileMode: "PERSISTENT" as const,
    purpose: "PROFILE_PREPARATION" as const,
    runtimeId: "runtime-1",
    userBrowserProfileId: "profile-1",
  };

  function fixture(status: "READY" | "LOST" = "READY") {
    const events: string[] = [];
    const profile = {
      id: "profile-1",
      assignedRuntimeId: "runtime-1",
      runtimeProfileKey: "opaque-profile",
      status,
      version: 7,
      inactivityExpiresAt: new Date(0),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      userBrowserProfile: {
        findFirst: vi.fn().mockResolvedValue(profile),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(),
      },
      browserRuntime: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          enabled: true,
          revokedAt: null,
          maxConcurrency: 1,
        }),
      },
      browserRuntimeSession: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({ id: "session-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      browserRuntimeSlot: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn(),
      },
      browserRuntimeProfileLease: { create: vi.fn() },
      browserRuntimeFenceCounter: {
        upsert: vi.fn().mockResolvedValue({ value: 1n }),
      },
    };
    const prisma = {
      browserRuntime: {
        findFirst: vi.fn().mockResolvedValue({
          id: "runtime-1",
          maxConcurrency: 1,
          protocolMinor: 13,
        }),
      },
      userBrowserProfile: { findFirst: vi.fn().mockResolvedValue(profile) },
      browserRuntimeSession: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation(async (work) => {
        const result = await work(tx);
        events.push("commit");
        return result;
      }),
    };
    const commands = {
      execute: vi.fn().mockImplementation(async () => {
        events.push("session.open");
        return { status: "SUCCEEDED" };
      }),
    };
    const service = new RuntimeSessionsService(
      prisma as never,
      { isRuntimeOnline: vi.fn().mockResolvedValue(true) } as never,
      commands as never,
      {} as never,
      { record: vi.fn() } as never,
    );
    vi.spyOn(service as never, "expireSlots" as never).mockResolvedValue(
      undefined as never,
    );
    vi.spyOn(service, "detail").mockResolvedValue({
      id: "session-1",
      status: "ACTIVE",
    } as never);
    const claim = {
      expectedStatus: status,
      expectedVersion: 7,
      onAllocated: vi.fn().mockImplementation(() => {
        events.push("allocated");
      }),
    };
    return { service, profile, tx, prisma, commands, events, claim };
  }

  it.each(["READY", "LOST"] as const)(
    "admits %s reauthentication and marks allocation only after commit, before opening",
    async (status) => {
      const { service, tx, events, claim } = fixture(status);
      await service.create(current, input, claim);
      expect(events.slice(0, 3)).toEqual([
        "commit",
        "allocated",
        "session.open",
      ]);
      expect(tx.userBrowserProfile.updateMany).toHaveBeenCalledWith({
        data: {
          assignedRuntimeId: "runtime-1",
          status: "PREPARING",
          verificationError: expect.anything(),
          version: { increment: 1 },
        },
        where: {
          id: "profile-1",
          ownerUserId: "user-1",
          teamId: "team-1",
          status,
          version: 7,
        },
      });
      expect(tx.userBrowserProfile.findFirst).toHaveBeenCalledWith({
        where: {
          id: "profile-1",
          ownerUserId: "user-1",
          teamId: "team-1",
          owner: {
            status: "ACTIVE",
            memberships: { some: { teamId: "team-1" } },
          },
        },
      });
    },
  );

  it.each(["old session", "no capacity", "new version", "owner unavailable"])(
    "rejects %s before changing the profile or sending an open command",
    async (conflict) => {
      const { service, profile, tx, commands, claim } = fixture();
      if (conflict === "old session")
        tx.browserRuntimeSession.count.mockResolvedValue(1);
      if (conflict === "no capacity")
        tx.browserRuntimeSlot.count.mockResolvedValue(1);
      if (conflict === "new version")
        tx.userBrowserProfile.findFirst.mockResolvedValue({
          ...profile,
          version: 8,
        });
      if (conflict === "owner unavailable")
        tx.userBrowserProfile.findFirst.mockResolvedValue(null);
      await expect(service.create(current, input, claim)).rejects.toThrow();
      expect(tx.userBrowserProfile.updateMany).not.toHaveBeenCalled();
      expect(tx.browserRuntimeSession.create).not.toHaveBeenCalled();
      expect(claim.onAllocated).not.toHaveBeenCalled();
      expect(commands.execute).not.toHaveBeenCalled();
    },
  );

  it("does not let a preparation claim bypass execution admission", async () => {
    const { service, prisma, claim } = fixture();
    await expect(
      service.create(current, { ...input, purpose: "EXECUTION" }, claim),
    ).rejects.toThrow("Invalid browser profile preparation claim");
    expect(prisma.browserRuntime.findFirst).not.toHaveBeenCalled();
  });
});

describe("RuntimeSessionsService lifecycle cleanup", () => {
  beforeEach(() => {
    vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true");
    resetEnvForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });
  const current = {
    sessionId: "cookie",
    team: { id: "team-1", name: "Team", slug: "team" },
    user: {
      id: "user-1",
      name: "User",
      email: "user@example.com",
      avatarUrl: null,
    },
  };
  function fixture(verified = false) {
    const session = {
      id: "session-1",
      status: verified ? "CLOSED" : "CLOSING",
      fencingToken: 1n,
      leaseToken: "lease-1",
      artifacts: [],
      commands: [],
      events: [],
      profileKey: null,
      userBrowserProfileId: "profile-1",
      runtime: { id: "runtime-1", name: "Runtime", status: "ONLINE" },
      closureVerifiedAt: verified ? new Date() : null,
      closureEvidenceId: verified ? "proof-1" : null,
    };
    const prisma = {
      browserRuntimeSession: {
        findFirst: vi.fn().mockResolvedValue(session),
        findUnique: vi.fn().mockResolvedValue(session),
        findMany: vi.fn().mockResolvedValue([session]),
        updateMany: vi.fn(),
      },
      browserRuntimeSlot: { deleteMany: vi.fn() },
      browserRuntimeProfileLease: { deleteMany: vi.fn() },
    };
    const commands = {
      execute: vi
        .fn()
        .mockResolvedValue({ id: "command-1", status: "SUCCEEDED" }),
    };
    const closure = { recordFailure: vi.fn().mockResolvedValue(undefined) };
    const audit = { record: vi.fn() };
    const sessions = new RuntimeSessionsService(
      prisma as never,
      {} as never,
      commands as never,
      {} as never,
      audit as never,
      {} as never,
      closure as never,
    );
    return { sessions, prisma, commands, closure, audit, session };
  }
  it("routes an already-closing session through durable command reuse without manufacturing proof", async () => {
    const { sessions, prisma, commands, closure } = fixture();
    await expect(
      sessions.close(current, "session-1", { timeoutSeconds: 1 }),
    ).resolves.toMatchObject({ status: "CLOSING" });
    expect(commands.execute).toHaveBeenCalledWith({
      commandType: "session.close",
      sessionId: "session-1",
      source: "SYSTEM",
      timeoutSeconds: 1,
    });
    expect(closure.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "command-1",
        errorCode: "CLOSURE_UNVERIFIED",
      }),
    );
    expect(prisma.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
    expect(prisma.browserRuntimeProfileLease.deleteMany).not.toHaveBeenCalled();
  });
  it("keeps leases when a close RPC fails and records a retryable failure", async () => {
    const { sessions, prisma, commands, closure } = fixture();
    commands.execute.mockRejectedValue(new Error("offline"));
    await expect(sessions.close(current, "session-1")).resolves.toMatchObject({
      status: "CLOSING",
    });
    expect(closure.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedFencingToken: "1",
        expectedLeaseToken: "lease-1",
        errorCode: "CLOSE_FAILED",
      }),
    );
    expect(prisma.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
  });
  it("returns a proven closure without resending or regressing it", async () => {
    const { sessions, commands, closure } = fixture(true);
    await expect(sessions.close(current, "session-1")).resolves.toMatchObject({
      status: "CLOSED",
    });
    expect(commands.execute).not.toHaveBeenCalled();
    expect(closure.recordFailure).not.toHaveBeenCalled();
  });
  it("includes LOST and FAILED preparation sessions and counts only proven closures", async () => {
    const { sessions, prisma } = fixture();
    await expect(sessions.closeIdleProfileSessions("profile-1")).resolves.toBe(
      0,
    );
    expect(prisma.browserRuntimeSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: expect.arrayContaining(["LOST", "FAILED"]) },
          userBrowserProfileId: "profile-1",
        }),
      }),
    );
    const proven = fixture(true);
    await expect(
      proven.sessions.closeIdleProfileSessions("profile-1"),
    ).resolves.toBe(1);
  });
  it("enforces the rollout barrier on explicit close", async () => {
    vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "false");
    resetEnvForTests();
    const { sessions, commands } = fixture();
    await expect(sessions.close(current, "session-1")).rejects.toThrow(
      "paused",
    );
    expect(commands.execute).not.toHaveBeenCalled();
  });
});
