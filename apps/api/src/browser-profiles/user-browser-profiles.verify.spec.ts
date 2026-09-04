import { afterEach, describe, expect, it, vi } from "vitest";
import { userBrowserProfileVerifyInputSchema } from "@devproof/contracts";
import { UserBrowserProfilesService } from "./user-browser-profiles.service.js";

const current = { user: { id: "user-1" }, team: { id: "team-1" } };
const verificationUrl = "https://app.example.com/account";

function fixture(changes: Record<string, unknown> = {}) {
  const profile = {
    id: "profile-1",
    teamId: "team-1",
    ownerUserId: "user-1",
    version: 2,
    executionMode: "SERIAL_PERSISTENT",
    status: "PREPARING",
    grants: [],
    verificationUrl,
    verificationRules: { successUrlPatterns: [verificationUrl] },
    runtimeSessions: [
      {
        id: "session-1",
        purpose: "PROFILE_PREPARATION",
        status: "ACTIVE",
        protocolMinor: 13,
      },
    ],
    ...changes,
  };
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const sessions = {
    execute: vi
      .fn()
      .mockImplementation(async (_current, _session, command) => ({
        status: "SUCCEEDED",
        result:
          command.commandType === "page.navigate"
            ? { status: 200, url: verificationUrl }
            : command.commandType === "locator.count"
              ? { count: 1 }
              : { url: verificationUrl },
      })),
    publishProfileSnapshot: vi.fn().mockResolvedValue({ generation: 3 }),
    close: vi.fn().mockResolvedValue({ status: "CLOSED" }),
  };
  const prisma = {
    userBrowserProfile: {
      updateMany,
      update: vi.fn().mockResolvedValue(profile),
      findUniqueOrThrow: vi.fn().mockResolvedValue(profile),
    },
    taskProfileRecoveryEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    (run: (tx: typeof prisma) => unknown) => run(prisma),
  );
  const service = new UserBrowserProfilesService(
    prisma as never,
    {} as never,
    sessions as never,
    {} as never,
    {} as never,
    { record: vi.fn().mockResolvedValue(undefined) } as never,
  );
  vi.spyOn(service as never, "owned" as never).mockResolvedValue(
    profile as never,
  );
  return { service, sessions, updateMany, prisma };
}

afterEach(() => vi.unstubAllEnvs());

describe("Profile verification opt-in and source authentication", () => {
  it("defaults old verify requests to serial preparation and rejects unknown options", () => {
    expect(userBrowserProfileVerifyInputSchema.parse({})).toEqual({
      prepareIsolatedAuth: false,
    });
    expect(
      userBrowserProfileVerifyInputSchema.safeParse({
        prepareIsolatedAuth: "true",
      }).success,
    ).toBe(false);
    expect(
      userBrowserProfileVerifyInputSchema.safeParse({
        prepareIsolatedAuth: true,
        skipProbe: true,
      }).success,
    ).toBe(false);
  });

  it.each(["false", "true"])(
    "never probes a serial profile without explicit opt-in when the flag is %s",
    async (enabled) => {
      vi.stubEnv("BROWSER_ISOLATED_AUTH_ENABLED", enabled);
      const { service, sessions, updateMany } = fixture();
      await service.verify(current as never, "profile-1");
      expect(sessions.publishProfileSnapshot).not.toHaveBeenCalled();
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "READY",
            authSnapshotGeneration: null,
          }),
        }),
      );
    },
  );

  it.each(["SERIAL_PERSISTENT", "ISOLATED_AUTH"])(
    "rejects isolated validation with a disabled flag for %s",
    async (executionMode) => {
      vi.stubEnv("BROWSER_ISOLATED_AUTH_ENABLED", "false");
      const { service, sessions, updateMany } = fixture({ executionMode });
      await expect(
        service.verify(current as never, "profile-1", {
          prepareIsolatedAuth: true,
        }),
      ).rejects.toThrow("not enabled");
      expect(sessions.execute).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it("prepares a snapshot for a serial profile through explicit opt-in without switching its execution mode", async () => {
    vi.stubEnv("BROWSER_ISOLATED_AUTH_ENABLED", "true");
    const { service, sessions, updateMany } = fixture();
    await service.verify(current as never, "profile-1", {
      prepareIsolatedAuth: true,
    });
    expect(sessions.publishProfileSnapshot).toHaveBeenCalledWith(
      current,
      "session-1",
      3,
      expect.objectContaining({ url: verificationUrl }),
    );
    const finalized = updateMany.mock.calls.find(
      ([query]) => query.data.status === "READY",
    )![0];
    expect(finalized.data).toMatchObject({ authSnapshotGeneration: 3 });
    expect(finalized.data).not.toHaveProperty("executionMode");
  });

  it("keeps serial fallback only after refreshing and revalidating the source login", async () => {
    vi.stubEnv("BROWSER_ISOLATED_AUTH_ENABLED", "true");
    const { service, sessions, updateMany } = fixture();
    sessions.publishProfileSnapshot.mockRejectedValue(
      new Error("rotated credentials"),
    );
    await service.verify(current as never, "profile-1", {
      prepareIsolatedAuth: true,
    });
    expect(
      sessions.execute.mock.calls.map(([, , command]) => command.commandType),
    ).toEqual(["page.get_url", "page.navigate", "page.get_url"]);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "READY",
          authSnapshotGeneration: null,
          verificationError: expect.objectContaining({
            code: "AUTH_SNAPSHOT_INCOMPATIBLE",
          }),
        }),
      }),
    );
  });

  it.each(["http401", "redirect", "missingElement"])(
    "requires reauthentication when a failed probe invalidates the source: %s",
    async (failure) => {
      vi.stubEnv("BROWSER_ISOLATED_AUTH_ENABLED", "true");
      const { service, sessions, updateMany } = fixture({
        authSnapshotGeneration: 1,
        verificationRules: {
          successUrlPatterns: [verificationUrl],
          loginUrlPatterns: ["*/login"],
          authenticatedSelector: "#account",
        },
      });
      let probed = false;
      sessions.publishProfileSnapshot.mockImplementation(async () => {
        probed = true;
        throw new Error("rotated credentials");
      });
      sessions.execute.mockImplementation(
        async (_current, _session, command) => ({
          status: "SUCCEEDED",
          result:
            command.commandType === "page.navigate"
              ? { status: probed && failure === "http401" ? 401 : 200 }
              : command.commandType === "locator.count"
                ? { count: probed && failure === "missingElement" ? 0 : 1 }
                : {
                    url:
                      probed && failure === "redirect"
                        ? "https://app.example.com/login"
                        : verificationUrl,
                  },
        }),
      );
      await expect(
        service.verify(current as never, "profile-1", {
          prepareIsolatedAuth: true,
        }),
      ).rejects.toThrow();
      expect(updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "REAUTH_REQUIRED",
            authSnapshotGeneration: null,
            authSnapshotCreatedAt: null,
          }),
        }),
      );
      expect(
        updateMany.mock.calls.some(([query]) => query.data.status === "READY"),
      ).toBe(false);
      expect(sessions.close).not.toHaveBeenCalled();
    },
  );

  it("does not silently return an isolated profile to READY after a failed probe", async () => {
    vi.stubEnv("BROWSER_ISOLATED_AUTH_ENABLED", "true");
    const { service, sessions, updateMany } = fixture({
      executionMode: "ISOLATED_AUTH",
    });
    sessions.publishProfileSnapshot.mockRejectedValue(
      new Error("incompatible login"),
    );
    await expect(service.verify(current as never, "profile-1")).rejects.toThrow(
      "incompatible login",
    );
    expect(sessions.execute).toHaveBeenCalledWith(
      current,
      "session-1",
      expect.objectContaining({ commandType: "page.navigate" }),
    );
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REAUTH_REQUIRED" }),
      }),
    );
  });
});
