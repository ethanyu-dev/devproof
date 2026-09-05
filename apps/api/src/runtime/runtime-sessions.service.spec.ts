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
