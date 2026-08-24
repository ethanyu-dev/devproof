import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  isMainModule,
  pairingTokenFromInputs,
  runtimeVersion,
} from "./index.js";

describe("runtimeVersion", () => {
  it("matches the distributable package metadata", async () => {
    const metadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(runtimeVersion).toBe(metadata.version);
  });
});

describe("isMainModule", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("recognizes an npm-style symlink to the CLI entry point", async () => {
    const modulePath = fileURLToPath(import.meta.url);
    const directory = await mkdtemp(join(tmpdir(), "devproof-cli-entry-"));
    temporaryDirectories.push(directory);
    const entryPath = join(directory, "devproof-browser-runtime");
    await symlink(modulePath, entryPath);

    expect(isMainModule(entryPath, import.meta.url)).toBe(true);
  });

  it("rejects a different entry point", () => {
    expect(isMainModule(process.execPath, import.meta.url)).toBe(false);
  });
});

describe("pairingTokenFromInputs", () => {
  it("reads a pairing token from stdin without requiring a process argument", async () => {
    await expect(
      pairingTokenFromInputs(
        ["node", "runtime", "pair", "--token-stdin"],
        Readable.from(["one-time-token\n"]),
        {},
      ),
    ).resolves.toBe("one-time-token");
  });

  it("keeps the legacy process argument available for manual pairing", async () => {
    await expect(
      pairingTokenFromInputs(
        ["node", "runtime", "pair", "--token", "manual-token"],
        Readable.from([]),
        {},
      ),
    ).resolves.toBe("manual-token");
  });
});
