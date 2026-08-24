import { describe, expect, it, vi } from "vitest";

import { UserBrowserProfilesService } from "./user-browser-profiles.service.js";

function service(
  prisma: Record<string, unknown>,
  redis: Record<string, unknown> = {},
) {
  return new UserBrowserProfilesService(
    prisma as never,
    redis as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe("UserBrowserProfilesService", () => {
  it("provisions a task-scoped Profile without user-authored verification settings", async () => {
    const create = vi.fn().mockImplementation(({ data }) => ({
      ...data,
      assignedRuntime: null,
      createdAt: new Date(),
      grants: [],
      id: "profile-1",
      inactivityExpiresAt: null,
      lastUsedAt: null,
      lastVerifiedAt: null,
      runtimeSessions: [],
      status: "UNINITIALIZED",
      updatedAt: new Date(),
    }));
    const profiles = service({
      user: { findFirst: vi.fn().mockResolvedValue({ id: "user-1" }) },
      userBrowserProfile: {
        create,
        findUnique: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await profiles.provisionForTask({
      authRole: "default",
      environmentKey: "default",
      ownerUserId: "user-1",
      targetUrl: "https://preview.example.com/dashboard?build=123",
      teamId: "team-1",
      triggerSource: "FEISHU",
    });

    expect(result).toMatchObject({
      configurationSource: "TASK",
      displayName: "preview.example.com",
      pendingTriggerSources: ["FEISHU"],
      siteHostname: "preview.example.com",
      status: "UNINITIALIZED",
      verificationUrl: "https://preview.example.com/dashboard?build=123",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          verificationRules: expect.objectContaining({
            provisionedBy: "TASK_TARGET",
            requestedTriggerSources: ["FEISHU"],
            successUrlPatterns: ["https://preview.example.com/dashboard*"],
          }),
        }),
      }),
    );
  });

  it("does not treat a same-origin login redirect as automatic verification", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: "SUCCEEDED" })
      .mockResolvedValueOnce({
        result: { url: "https://app.example.com/auth" },
      });
    const profiles = new UserBrowserProfilesService(
      { userBrowserProfile: { update: vi.fn() } } as never,
      {} as never,
      { execute } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      id: "profile-1",
      runtimeSessions: [{ id: "session-1", status: "ACTIVE" }],
      verificationRules: {
        loginUrlPatterns: ["*/login*", "*/signin*"],
        provisionedBy: "TASK_TARGET",
        requestedTriggerSources: ["CONSOLE"],
        successUrlPatterns: ["https://app.example.com/*"],
      },
      verificationUrl: "https://app.example.com/",
    } as never);

    await expect(
      profiles.verify(
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
        "profile-1",
      ),
    ).rejects.toThrow("does not prove authentication");
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "session-1",
      expect.objectContaining({ commandType: "page.navigate" }),
    );
  });

  it("activates a pending entry only for the automatic Profile target", async () => {
    const upsert = vi.fn();
    const update = vi.fn();
    const audit = { record: vi.fn() };
    const profiles = new UserBrowserProfilesService(
      {
        $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
          callback({
            browserProfileGrant: { upsert },
            userBrowserProfile: { update },
          }),
        ),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
    );
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      grants: [],
      id: "profile-1",
      ownerUserId: "user-1",
      runtimeSessions: [],
      status: "READY",
      teamId: "team-1",
      verificationRules: {
        provisionedBy: "TASK_TARGET",
        requestedTriggerSources: ["FEISHU"],
        successUrlPatterns: ["https://app.example.com/*"],
      },
      verificationUrl: "https://app.example.com/",
    } as never);

    await profiles.approve(
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
      "profile-1",
    );

    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          hostnamePattern: "app.example.com",
          triggerSource: "FEISHU",
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      "browser_profile.grants_approved",
      "user_browser_profile",
      "profile-1",
      { approvedSources: ["FEISHU"] },
    );
  });

  it("uses a versioned claim so a concurrent preparation cannot roll back the winner", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const sessions = { create: vi.fn() };
    const profiles = new UserBrowserProfilesService(
      { userBrowserProfile: { updateMany } } as never,
      {} as never,
      sessions as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      assignedRuntimeId: null,
      grants: [],
      id: "profile-1",
      runtimeSessions: [],
      status: "READY",
      verificationUrl: "https://app.example.com/login",
      version: 7,
    } as never);
    vi.spyOn(profiles as never, "selectRuntime" as never).mockResolvedValue(
      "runtime-1" as never,
    );

    await expect(
      profiles.prepare(
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
        "profile-1",
        { ttlSeconds: 300 },
      ),
    ).rejects.toThrow("started by another request");

    expect(updateMany).toHaveBeenCalledWith({
      data: {
        assignedRuntimeId: "runtime-1",
        status: "PREPARING",
        verificationError: expect.anything(),
        version: { increment: 1 },
      },
      where: { id: "profile-1", status: "READY", version: 7 },
    });
    expect(sessions.create).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("rolls back only the preparation version owned by the failed request", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const profiles = new UserBrowserProfilesService(
      { userBrowserProfile: { updateMany } } as never,
      {} as never,
      {
        create: vi.fn().mockRejectedValue(new Error("runtime offline")),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      assignedRuntimeId: null,
      grants: [],
      id: "profile-1",
      runtimeSessions: [],
      status: "REAUTH_REQUIRED",
      verificationUrl: "https://app.example.com/login",
      version: 11,
    } as never);
    vi.spyOn(profiles as never, "selectRuntime" as never).mockResolvedValue(
      "runtime-1" as never,
    );

    await expect(
      profiles.prepare(
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
        "profile-1",
        { ttlSeconds: 300 },
      ),
    ).rejects.toThrow("runtime offline");

    expect(updateMany).toHaveBeenLastCalledWith({
      data: {
        status: "REAUTH_REQUIRED",
        verificationError: expect.objectContaining({
          code: "PROFILE_PREPARATION_FAILED",
        }),
        version: { increment: 1 },
      },
      where: { id: "profile-1", status: "PREPARING", version: 12 },
    });
  });

  it("requires an active owner and a current team membership at resolution time", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const profiles = service({ userBrowserProfile: { findMany } });

    await profiles.resolveProfile({
      ownerUserId: "user-1",
      policy: {
        onUnavailable: "WAIT_FOR_PROFILE",
        scope: { authRole: "admin", environmentKey: "staging" },
        strategy: "REQUESTER",
      },
      targetHostname: "app.example.com",
      teamId: "team-1",
      triggerSource: "CONSOLE",
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          owner: {
            memberships: { some: { teamId: "team-1" } },
            status: "ACTIVE",
          },
          ownerUserId: "user-1",
          inactivityExpiresAt: { gt: expect.any(Date) },
          status: "READY",
          teamId: "team-1",
        }),
      }),
    );
  });

  it("never serializes the opaque Runtime profile key", () => {
    const profiles = service({});
    const serialize = Reflect.get(profiles, "serialize") as (
      row: Record<string, unknown>,
    ) => Record<string, unknown>;

    const result = serialize.call(profiles, {
      grants: [
        { id: "active-grant", revokedAt: null },
        { id: "revoked-grant", revokedAt: new Date() },
      ],
      runtimeProfileKey: "opaque-secret-key",
      runtimeSessions: [],
    });

    expect(result).not.toHaveProperty("runtimeProfileKey");
    expect(result.grants).toEqual([
      expect.objectContaining({ id: "active-grant" }),
    ]);
  });

  it("physically deletes the Profile record after Runtime cleanup", async () => {
    const tx = {
      browserProfileReservation: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      taskExecution: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      taskExecutionStage: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      taskProfileBinding: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ taskExecutionId: "task-using-profile" }]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      userBrowserProfile: { delete: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
      browserRuntimeSession: { findMany: vi.fn().mockResolvedValue([]) },
      executionRun: { count: vi.fn().mockResolvedValue(0) },
      userBrowserProfile: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const browser = {
      purgeProfile: vi.fn().mockResolvedValue({ purged: true }),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const profiles = new UserBrowserProfilesService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      browser as never,
      audit as never,
    );
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      id: "profile-1",
      runtimeProfileKey: "opaque-profile-key",
      status: "READY",
      verificationError: null,
      version: 4,
    } as never);

    await expect(
      profiles.remove(
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
        "profile-1",
      ),
    ).resolves.toEqual({ deleted: true, id: "profile-1" });
    expect(browser.purgeProfile).toHaveBeenCalledWith(
      "team-1",
      "opaque-profile-key",
      "profile-1",
    );
    expect(tx.userBrowserProfile.delete).toHaveBeenCalledWith({
      where: { id: "profile-1" },
    });
    expect(tx.taskExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentStage: "PROFILE_RESOLUTION",
          lifecycle: "WAITING_INPUT",
          waitingReason: "PROFILE_OWNER_DELETED",
        }),
        where: expect.objectContaining({
          id: { in: ["task-using-profile"] },
        }),
      }),
    );
    expect(tx.taskExecutionStage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "WAITING_INPUT",
          waitingReason: "PROFILE_OWNER_DELETED",
        }),
        where: expect.objectContaining({
          taskExecutionId: { in: ["task-using-profile"] },
          type: "PROFILE_RESOLUTION",
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      "browser_profile.deleted",
      "user_browser_profile",
      "profile-1",
    );
  });

  it("lets the Runtime proxy enforce private-network policy for public hosts", async () => {
    const profiles = service(
      {
        browserRuntime: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "runtime-1",
              networkAllowlist: [],
              protocolMajor: 1,
              protocolMinor: 9,
            },
          ]),
        },
        runtimeRoutingRule: { findMany: vi.fn().mockResolvedValue([]) },
      },
      { isRuntimeOnline: vi.fn().mockResolvedValue(true) },
    );
    const selectRuntime = Reflect.get(profiles, "selectRuntime") as (
      teamId: string,
      hostname: string,
    ) => Promise<string>;

    await expect(
      selectRuntime.call(profiles, "team-1", "public.example.com"),
    ).resolves.toBe("runtime-1");
  });
});
