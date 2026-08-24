import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserSessionManager,
  assertUserProfileCanOpen,
  cleanupExpiredUserProfiles,
  readPendingProfileLifecycleEvents,
  removePendingProfileLifecycleEvent,
  touchUserProfileMetadata,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), "devproof-profile-retention-"));
  roots.push(value);
  return value;
}

describe("user Browser Profile inactivity retention", () => {
  it("does not apply a Profile-specific hostname policy to navigation", async () => {
    const manager = new BrowserSessionManager(
      {} as never,
      "http://127.0.0.1:1",
      () => undefined,
      () => undefined,
    );
    const goto = vi.fn().mockResolvedValue({ status: () => 200 });
    const page = {
      goto,
      title: vi.fn().mockResolvedValue("Feishu login"),
      url: vi.fn().mockReturnValue("https://open.feishu.cn/"),
    };
    const sessions = Reflect.get(manager, "sessions") as Map<
      string,
      Record<string, unknown>
    >;
    sessions.set("profile-session", {
      fencingToken: "1",
      leaseToken: "11111111-1111-4111-8111-111111111111",
      page,
      profileKey: "user-profile",
      profileMode: "PERSISTENT",
      profileRetention: {
        inactivityTtlSeconds: 2_592_000,
        kind: "USER",
      },
      sessionId: "profile-session",
      state: "OPEN",
    });

    await expect(
      manager.execute({
        commandId: "22222222-2222-4222-8222-222222222222",
        commandType: "page.navigate",
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        fencingToken: "1",
        leaseToken: "11111111-1111-4111-8111-111111111111",
        payload: {
          url: "https://open.feishu.cn/",
          waitUntil: "domcontentloaded",
        },
        sessionId: "profile-session",
        type: "command.execute",
      }),
    ).resolves.toMatchObject({ result: { status: 200 } });
    expect(goto).toHaveBeenCalledWith(
      "https://open.feishu.cn/",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
  });

  it("purges an inactive marked user profile after 30 days", async () => {
    const profiles = await root();
    const lastUsedAt = new Date("2026-07-01T00:00:00.000Z");
    await touchUserProfileMetadata(profiles, "user-profile", lastUsedAt);
    await writeFile(
      join(profiles, "user-profile", "Cookies"),
      "authenticated-session",
    );

    const purged = await cleanupExpiredUserProfiles(
      profiles,
      new Set(),
      new Date("2026-07-31T00:00:00.001Z"),
    );
    expect(purged).toEqual([
      expect.objectContaining({
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        kind: "PROFILE_EXPIRED",
        lastUsedAt: lastUsedAt.toISOString(),
        profileKey: "user-profile",
        purgedAt: "2026-07-31T00:00:00.001Z",
        type: "profile.lifecycle",
      }),
    ]);
    await expect(access(join(profiles, "user-profile"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readPendingProfileLifecycleEvents(profiles)).resolves.toEqual(
      purged,
    );
    await removePendingProfileLifecycleEvent(profiles, purged[0]!.eventId);
    await expect(readPendingProfileLifecycleEvents(profiles)).resolves.toEqual(
      [],
    );
  });

  it("replays a persisted lifecycle event after the profile directory is gone", async () => {
    const profiles = await root();
    await touchUserProfileMetadata(
      profiles,
      "expired-profile",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const first = await cleanupExpiredUserProfiles(
      profiles,
      new Set(),
      new Date("2026-08-01T00:00:00.000Z"),
    );

    await expect(
      cleanupExpiredUserProfiles(
        profiles,
        new Set(),
        new Date("2026-08-01T01:00:00.000Z"),
      ),
    ).resolves.toEqual(first);
  });

  it("does not recreate a user profile while its expiry event is pending", async () => {
    const profiles = await root();
    await touchUserProfileMetadata(
      profiles,
      "expired-profile",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    await cleanupExpiredUserProfiles(
      profiles,
      new Set(),
      new Date("2026-08-01T00:00:00.000Z"),
    );

    await expect(
      assertUserProfileCanOpen(profiles, "expired-profile"),
    ).rejects.toMatchObject({ code: "PROFILE_EXPIRED" });
  });

  it("keeps recently used and currently active user profiles", async () => {
    const profiles = await root();
    const now = new Date("2026-08-01T00:00:00.000Z");
    await touchUserProfileMetadata(
      profiles,
      "recent-profile",
      new Date("2026-07-15T00:00:00.000Z"),
    );
    await touchUserProfileMetadata(
      profiles,
      "active-profile",
      new Date("2026-01-01T00:00:00.000Z"),
    );

    await expect(
      cleanupExpiredUserProfiles(profiles, new Set(["active-profile"]), now),
    ).resolves.toEqual([]);
    await expect(
      access(join(profiles, "recent-profile")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(profiles, "active-profile")),
    ).resolves.toBeUndefined();
  });

  it("does not race an opening session after the scan snapshot", async () => {
    const profiles = await root();
    await touchUserProfileMetadata(
      profiles,
      "opening-profile",
      new Date("2026-01-01T00:00:00.000Z"),
    );

    await expect(
      cleanupExpiredUserProfiles(
        profiles,
        new Set(),
        new Date("2026-08-01T00:00:00.000Z"),
        () => null,
      ),
    ).resolves.toEqual([]);
    await expect(
      access(join(profiles, "opening-profile")),
    ).resolves.toBeUndefined();
  });

  it("rejects a second active session for the same user profile", async () => {
    const manager = new BrowserSessionManager(
      {} as never,
      "http://127.0.0.1:1",
      () => undefined,
      () => undefined,
    );
    const sessions = Reflect.get(manager, "sessions") as Map<
      string,
      Record<string, unknown>
    >;
    sessions.set("existing-session", {
      profileKey: "shared-user-profile",
      profileMode: "PERSISTENT",
    });
    const open = Reflect.get(manager, "open") as (
      descriptor: Record<string, unknown>,
    ) => Promise<unknown>;

    await expect(
      open.call(manager, {
        fencingToken: "1",
        leaseToken: "lease-token",
        profileKey: "shared-user-profile",
        profileMode: "PERSISTENT",
        profileRetention: {
          inactivityTtlSeconds: 2_592_000,
          kind: "USER",
        },
        sessionId: "second-session",
        state: "OPEN",
      }),
    ).rejects.toMatchObject({ code: "PROFILE_IN_USE" });
  });

  it("never deletes legacy persistent profiles without a user marker", async () => {
    const profiles = await root();
    await mkdir(join(profiles, "legacy-profile"));
    await writeFile(join(profiles, "legacy-profile", "Cookies"), "legacy");

    await expect(
      cleanupExpiredUserProfiles(
        profiles,
        new Set(),
        new Date("2030-01-01T00:00:00.000Z"),
      ),
    ).resolves.toEqual([]);
    await expect(
      access(join(profiles, "legacy-profile")),
    ).resolves.toBeUndefined();
  });
});
