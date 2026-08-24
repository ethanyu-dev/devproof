import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { purgePersistentProfileDirectory } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("persistent Browser Profile purge", () => {
  it("atomically detaches and physically removes the profile directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "devproof-profile-purge-"));
    roots.push(root);
    const profilePath = join(root, "fp-issue-cycle");
    await mkdir(profilePath);
    await writeFile(join(profilePath, "Cookies"), "authenticated-session");

    await expect(
      purgePersistentProfileDirectory(root, "fp-issue-cycle"),
    ).resolves.toEqual({
      existed: true,
      profileKey: "fp-issue-cycle",
      purged: true,
    });
    await expect(access(profilePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(root, ".purge-fp-issue-cycle")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent when the profile is already absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "devproof-profile-purge-"));
    roots.push(root);

    await expect(
      purgePersistentProfileDirectory(root, "fp-missing-cycle"),
    ).resolves.toEqual({
      existed: false,
      profileKey: "fp-missing-cycle",
      purged: true,
    });
  });
});
