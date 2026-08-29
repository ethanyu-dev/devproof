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
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: "SUCCEEDED" })
      .mockResolvedValueOnce({
        result: { url: "https://app.example.com/auth" },
      });
    const profiles = new UserBrowserProfilesService(
      { userBrowserProfile: { updateMany } } as never,
      {} as never,
      { execute } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      id: "profile-1",
      runtimeSessions: [
        {
          id: "session-1",
          purpose: "PROFILE_PREPARATION",
          status: "ACTIVE",
        },
      ],
      status: "PREPARING",
      verificationRules: {
        loginUrlPatterns: ["*/login*", "*/signin*"],
        provisionedBy: "TASK_TARGET",
        requestedTriggerSources: ["CONSOLE"],
        successUrlPatterns: ["https://app.example.com/*"],
      },
      verificationUrl: "https://app.example.com/",
      version: 3,
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
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      data: {
        status: "VERIFYING",
        verificationError: expect.anything(),
        version: { increment: 1 },
      },
      where: { id: "profile-1", status: "PREPARING", version: 3 },
    });
  });

  it("does not mark a Profile ready when Runtime close cannot confirm persistence", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = vi.fn();
    const profiles = new UserBrowserProfilesService(
      {
        $transaction: transaction,
        userBrowserProfile: { updateMany },
      } as never,
      {} as never,
      {
        close: vi.fn().mockResolvedValue({ status: "LOST" }),
        execute: vi.fn().mockResolvedValue({
          result: { url: "https://app.example.com/dashboard" },
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      id: "profile-1",
      runtimeSessions: [
        {
          id: "session-1",
          purpose: "PROFILE_PREPARATION",
          status: "ACTIVE",
        },
      ],
      status: "PREPARING",
      verificationRules: {
        successUrlPatterns: ["https://app.example.com/*"],
      },
      verificationUrl: "https://app.example.com/login",
      version: 2,
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
    ).rejects.toThrow("disconnected before the profile could be saved");
    expect(transaction).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REAUTH_REQUIRED" }),
        where: { id: "profile-1", status: "VERIFYING", version: 3 },
      }),
    );
  });

  it("rejects duplicate verification while a save is already running", async () => {
    const profiles = service({});
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      id: "profile-1",
      runtimeSessions: [{ id: "session-1", status: "HUMAN_CONTROL" }],
      status: "VERIFYING",
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
    ).rejects.toThrow("already in progress");
  });

  it("closes a preparation without saving a new login state", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const sessions = { close: vi.fn().mockResolvedValue({ status: "CLOSED" }) };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const profiles = new UserBrowserProfilesService(
      { userBrowserProfile: { updateMany } } as never,
      {} as never,
      sessions as never,
      {} as never,
      {} as never,
      audit as never,
    );
    vi.spyOn(profiles as never, "owned" as never)
      .mockResolvedValueOnce({
        grants: [],
        id: "profile-1",
        lastVerifiedAt: null,
        runtimeSessions: [{ id: "session-1", status: "HUMAN_CONTROL" }],
        status: "VERIFYING",
        verificationRules: {},
        verificationUrl: "https://app.example.com/",
        version: 8,
      } as never)
      .mockResolvedValueOnce({
        grants: [],
        id: "profile-1",
        lastVerifiedAt: null,
        runtimeSessions: [],
        status: "UNINITIALIZED",
        verificationRules: {},
        verificationUrl: "https://app.example.com/",
        version: 10,
      } as never);

    await profiles.closePreparation(
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

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      data: {
        status: "VERIFYING",
        verificationError: expect.anything(),
        version: { increment: 1 },
      },
      where: { id: "profile-1", status: "VERIFYING", version: 8 },
    });
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ status: "UNINITIALIZED" }),
        where: { id: "profile-1", status: "VERIFYING", version: 9 },
      }),
    );
    expect(sessions.close).toHaveBeenCalledWith(
      expect.anything(),
      "session-1",
      { timeoutSeconds: 15 },
    );
  });

  it("marks a preparation lost when Runtime cannot confirm close", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const profiles = new UserBrowserProfilesService(
      { userBrowserProfile: { updateMany } } as never,
      {} as never,
      { close: vi.fn().mockResolvedValue({ status: "LOST" }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      id: "profile-1",
      lastVerifiedAt: null,
      runtimeSessions: [{ id: "session-1", status: "HUMAN_CONTROL" }],
      status: "PREPARING",
      version: 2,
    } as never);

    await expect(
      profiles.closePreparation(
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
    ).rejects.toThrow("could be confirmed closed");
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ status: "LOST" }),
        where: { id: "profile-1", status: "VERIFYING", version: 3 },
      }),
    );
  });

  it("recovers a verifying Profile after its Runtime session disappeared", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const sessions = { close: vi.fn() };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const profiles = new UserBrowserProfilesService(
      { userBrowserProfile: { updateMany } } as never,
      {} as never,
      sessions as never,
      {} as never,
      {} as never,
      audit as never,
    );
    vi.spyOn(profiles as never, "owned" as never)
      .mockResolvedValueOnce({
        grants: [],
        id: "profile-1",
        lastVerifiedAt: new Date(),
        runtimeSessions: [],
        status: "VERIFYING",
        verificationRules: {},
        version: 4,
      } as never)
      .mockResolvedValueOnce({
        grants: [],
        id: "profile-1",
        lastVerifiedAt: new Date(),
        runtimeSessions: [],
        status: "REAUTH_REQUIRED",
        verificationRules: {},
        version: 5,
      } as never);

    await profiles.closePreparation(
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

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REAUTH_REQUIRED" }),
        where: { id: "profile-1", status: "VERIFYING", version: 4 },
      }),
    );
    expect(sessions.close).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      "browser_profile.preparation_closed",
      "user_browser_profile",
      "profile-1",
      { sessionId: null },
    );
  });

  it("recovers a preparing Profile after its Runtime session disappeared", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const profiles = new UserBrowserProfilesService(
      { userBrowserProfile: { updateMany } } as never,
      {} as never,
      { close: vi.fn() } as never,
      {} as never,
      {} as never,
      { record: vi.fn().mockResolvedValue(undefined) } as never,
    );
    vi.spyOn(profiles as never, "owned" as never)
      .mockResolvedValueOnce({
        id: "profile-1",
        lastVerifiedAt: null,
        runtimeSessions: [],
        status: "PREPARING",
        version: 6,
      } as never)
      .mockResolvedValueOnce({
        grants: [],
        id: "profile-1",
        lastVerifiedAt: null,
        runtimeSessions: [],
        status: "UNINITIALIZED",
        verificationRules: {},
        version: 7,
      } as never);

    await profiles.closePreparation(
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

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "UNINITIALIZED" }),
        where: { id: "profile-1", status: "PREPARING", version: 6 },
      }),
    );
  });

  it("does not let close revive a terminal Profile state", async () => {
    const updateMany = vi.fn();
    const profiles = service({ userBrowserProfile: { updateMany } });
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      id: "profile-1",
      runtimeSessions: [],
      status: "DISABLED",
      version: 9,
    } as never);

    await expect(
      profiles.closePreparation(
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
    ).rejects.toThrow("does not have a preparation");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("removes an unused pending task source without changing other rules", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const profiles = service({
      taskProfileBinding: { findFirst: vi.fn().mockResolvedValue(null) },
      userBrowserProfile: {
        findUnique: vi.fn().mockResolvedValue({
          verificationRules: {
            provisionedBy: "TASK_TARGET",
            requestedTriggerSources: ["CONSOLE", "FEISHU"],
          },
          verificationRulesVersion: 6,
        }),
        updateMany,
      },
    });

    await expect(
      profiles.releasePendingTaskRequest({
        profileId: "profile-1",
        triggerSource: "CONSOLE",
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      data: {
        verificationRules: {
          provisionedBy: "TASK_TARGET",
          requestedTriggerSources: ["FEISHU"],
        },
        verificationRulesVersion: { increment: 1 },
      },
      where: { id: "profile-1", verificationRulesVersion: 6 },
    });
  });

  it("restores a pending source after the task binding has been persisted", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const profiles = service({
      taskProfileBinding: {
        findFirst: vi.fn().mockResolvedValue({ id: "binding-1" }),
      },
      userBrowserProfile: {
        findUnique: vi.fn().mockResolvedValue({
          grants: [],
          verificationRules: { provisionedBy: "TASK_TARGET" },
          verificationRulesVersion: 2,
        }),
        updateMany,
      },
    });

    await expect(
      profiles.ensurePendingTaskRequest({
        profileId: "profile-secondary",
        triggerSource: "FEISHU",
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      data: {
        verificationRules: {
          provisionedBy: "TASK_TARGET",
          requestedTriggerSources: ["FEISHU"],
        },
        verificationRulesVersion: { increment: 1 },
      },
      where: {
        id: "profile-secondary",
        verificationRulesVersion: 2,
      },
    });
  });

  it("keeps a pending source while another active task still requests it", async () => {
    const updateMany = vi.fn();
    const findFirst = vi.fn().mockResolvedValue({ id: "binding-2" });
    const profiles = service({
      taskProfileBinding: { findFirst },
      userBrowserProfile: { updateMany },
    });

    await expect(
      profiles.releasePendingTaskRequest({
        profileId: "profile-1",
        triggerSource: "FEISHU",
      }),
    ).resolves.toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { requestedProfileId: "profile-1" },
            {
              externalIdentitySnapshot: {
                array_contains: [{ profileId: "profile-1" }],
                path: ["pendingProfiles"],
              },
            },
          ]),
        }),
      }),
    );
  });

  it("activates a pending entry only for the automatic Profile target", async () => {
    const upsert = vi.fn();
    const update = vi.fn();
    const recoveryCreate = vi.fn();
    const audit = { record: vi.fn() };
    const profiles = new UserBrowserProfilesService(
      {
        $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
          callback({
            browserProfileGrant: { upsert },
            taskProfileRecoveryEvent: { create: recoveryCreate },
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
    expect(recoveryCreate).toHaveBeenCalledWith({
      data: {
        profileId: "profile-1",
        resumedAt: expect.any(Date),
        source: "PROFILE_GRANTS_APPROVED",
        teamId: "team-1",
      },
    });
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
      status: "UNINITIALIZED",
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
      where: { id: "profile-1", status: "UNINITIALIZED", version: 7 },
    });
    expect(sessions.create).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("rejects a new preparation while the previous session is closing", async () => {
    const profiles = service({});
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      id: "profile-1",
      runtimeSessions: [
        {
          id: "session-1",
          purpose: "PROFILE_PREPARATION",
          status: "CLOSING",
        },
      ],
      status: "REAUTH_REQUIRED",
      verificationUrl: "https://app.example.com/login",
    } as never);

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
    ).rejects.toThrow("still closing");
  });

  it.each(["ACTIVE", "HUMAN_CONTROL"] as const)(
    "reopens the verification URL when reusing a %s profile session",
    async (status) => {
      const execute = vi.fn().mockResolvedValue({ status: "SUCCEEDED" });
      const takeover = vi.fn().mockResolvedValue(undefined);
      const update = vi.fn().mockResolvedValue(undefined);
      const audit = { record: vi.fn() };
      const profiles = new UserBrowserProfilesService(
        { userBrowserProfile: { update } } as never,
        {} as never,
        { execute, takeover } as never,
        {} as never,
        {} as never,
        audit as never,
      );
      vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
        grants: [],
        id: "profile-1",
        runtimeSessions: [
          { id: "session-1", purpose: "PROFILE_PREPARATION", status },
        ],
        status: "REAUTH_REQUIRED",
        verificationRules: {},
        verificationUrl: "https://app.example.com/login",
      } as never);

      const result = await profiles.prepare(
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
      );

      expect(result.sessionId).toBe("session-1");
      expect(execute).toHaveBeenCalledWith(expect.anything(), "session-1", {
        commandType: "page.navigate",
        payload: {
          url: "https://app.example.com/login",
          waitUntil: "domcontentloaded",
        },
        timeoutSeconds: 15,
      });
      if (status === "ACTIVE") {
        expect(takeover).toHaveBeenCalledOnce();
        expect(takeover.mock.invocationCallOrder[0]).toBeLessThan(
          execute.mock.invocationCallOrder[0]!,
        );
      } else {
        expect(takeover).not.toHaveBeenCalled();
      }
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        "browser_profile.preparation_started",
        "user_browser_profile",
        "profile-1",
        { reused: true, sessionId: "session-1" },
      );
    },
  );

  it("does not reuse an active execution session for Profile preparation", async () => {
    const execute = vi.fn().mockResolvedValue({ status: "SUCCEEDED" });
    const takeover = vi.fn().mockResolvedValue(undefined);
    const create = vi
      .fn()
      .mockResolvedValue({ id: "preparation-session", status: "ACTIVE" });
    const update = vi.fn().mockResolvedValue(undefined);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const profiles = new UserBrowserProfilesService(
      { userBrowserProfile: { update, updateMany } } as never,
      {} as never,
      { create, execute, takeover } as never,
      {} as never,
      {} as never,
      { record: vi.fn() } as never,
    );
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      assignedRuntimeId: "runtime-1",
      grants: [],
      id: "profile-1",
      runtimeSessions: [
        { id: "execution-session", purpose: "EXECUTION", status: "ACTIVE" },
      ],
      status: "REAUTH_REQUIRED",
      verificationRules: {},
      verificationUrl: "https://app.example.com/login",
      version: 3,
    } as never);
    vi.spyOn(profiles as never, "selectRuntime" as never).mockResolvedValue(
      "runtime-1" as never,
    );

    const result = await profiles.prepare(
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
    );

    expect(result.sessionId).toBe("preparation-session");
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        purpose: "PROFILE_PREPARATION",
        userBrowserProfileId: "profile-1",
      }),
    );
    expect(takeover).toHaveBeenCalledWith(
      expect.anything(),
      "preparation-session",
      { ttlSeconds: 300 },
    );
    expect(execute).not.toHaveBeenCalledWith(
      expect.anything(),
      "execution-session",
      expect.anything(),
    );
  });

  it("does not verify or close an execution session through Profile controls", async () => {
    const close = vi.fn();
    const execute = vi.fn();
    const profiles = new UserBrowserProfilesService(
      { userBrowserProfile: { update: vi.fn() } } as never,
      {} as never,
      { close, execute } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(profiles as never, "owned" as never).mockResolvedValue({
      id: "profile-1",
      runtimeSessions: [
        { id: "execution-session", purpose: "EXECUTION", status: "ACTIVE" },
      ],
      status: "PREPARING",
      verificationRules: {},
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
    ).rejects.toThrow("Profile preparation session is not active");
    expect(execute).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
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
      taskDeploymentProfileBinding: { deleteMany: vi.fn() },
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

  it("does not purge a Profile when Runtime close was not confirmed", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const browser = { purgeProfile: vi.fn() };
    const profiles = new UserBrowserProfilesService(
      {
        browserRuntimeSession: {
          findMany: vi.fn().mockResolvedValue([
            {
              humanControllerUserId: null,
              id: "session-1",
              status: "ACTIVE",
            },
          ]),
        },
        executionRun: { count: vi.fn().mockResolvedValue(0) },
        userBrowserProfile: { updateMany },
      } as never,
      {} as never,
      { close: vi.fn().mockResolvedValue({ status: "LOST" }) } as never,
      {} as never,
      browser as never,
      {} as never,
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
    ).rejects.toThrow("confirmed closed");
    expect(browser.purgeProfile).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "READY" }),
        where: { id: "profile-1", status: "DISABLED", version: 5 },
      }),
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
