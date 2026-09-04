import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishAuthSnapshot, readAuthSnapshot } from "./auth-snapshots.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("immutable local authentication snapshots", () => {
  it("captures IndexedDB, publishes atomically, and does not overwrite a generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "devproof-auth-snapshot-"));
    roots.push(root);
    const reference = { profileKey: "profile-1", generation: 4 };
    const state = {
      cookies: [],
      origins: [
        {
          origin: "https://app.test",
          localStorage: [{ name: "token", value: "secret" }],
          indexedDB: [],
        },
      ],
    };
    const context = { storageState: vi.fn().mockResolvedValue(state) };
    const results = await Promise.all([
      publishAuthSnapshot(root, reference, context),
      publishAuthSnapshot(root, reference, context),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(JSON.stringify(results)).not.toContain("secret");
    expect(context.storageState).toHaveBeenCalledWith({ indexedDB: true });
    context.storageState.mockResolvedValue({ cookies: [], origins: [] });
    await publishAuthSnapshot(root, reference, context);
    expect((await readAuthSnapshot(root, reference)).state).toEqual(state);
    expect(
      (await stat(join(root, "profile-1/.auth-snapshots/4.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      await readFile(join(root, "profile-1/.auth-snapshots/4.json"), "utf8"),
    ).toContain("secret");
  });

  it("does not publish when concurrent-login verification fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "devproof-auth-snapshot-"));
    roots.push(root);
    const reference = { profileKey: "profile-1", generation: 1 };
    await expect(
      publishAuthSnapshot(
        root,
        reference,
        {
          storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
        },
        async () => {
          throw new Error("login rejected");
        },
      ),
    ).rejects.toThrow("login rejected");
    await expect(readAuthSnapshot(root, reference)).rejects.toMatchObject({
      code: "AUTH_SNAPSHOT_MISSING",
    });
    await expect(
      readAuthSnapshot(root, { profileKey: "../escape", generation: 1 }),
    ).rejects.toBeDefined();
  });
});
