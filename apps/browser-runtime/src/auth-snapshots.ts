import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  authSnapshotReferenceSchema,
  type AuthSnapshotReference,
} from "@devproof/runtime-protocol";
import type { BrowserContext } from "playwright";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

interface SnapshotFile {
  schemaVersion: 1;
  profileKey: string;
  generation: number;
  createdAt: string;
  checksum: string;
  state: StorageState;
}

function snapshotPath(root: string, reference: AuthSnapshotReference) {
  authSnapshotReferenceSchema.parse(reference);
  return join(
    root,
    reference.profileKey,
    ".auth-snapshots",
    `${reference.generation}.json`,
  );
}

function snapshotError(code: string, message: string) {
  return Object.assign(new Error(message), { code, retryable: false });
}

/** Credentials stay on their Runtime; only this metadata crosses the wire. */
function metadata(snapshot: SnapshotFile) {
  return {
    profileKey: snapshot.profileKey,
    generation: snapshot.generation,
    createdAt: snapshot.createdAt,
    cookiesCount: snapshot.state.cookies.length,
    originsCount: snapshot.state.origins.length,
  };
}

export async function readAuthSnapshot(
  root: string,
  reference: AuthSnapshotReference,
) {
  let snapshot: SnapshotFile;
  try {
    snapshot = JSON.parse(
      await readFile(snapshotPath(root, reference), "utf8"),
    ) as SnapshotFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw snapshotError(
        "AUTH_SNAPSHOT_MISSING",
        "The requested authentication snapshot is not available on this Runtime.",
      );
    }
    throw snapshotError(
      "AUTH_SNAPSHOT_INVALID",
      "The authentication snapshot could not be loaded.",
    );
  }
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.profileKey !== reference.profileKey ||
    snapshot.generation !== reference.generation ||
    !snapshot.state ||
    !Array.isArray(snapshot.state.cookies) ||
    !Array.isArray(snapshot.state.origins) ||
    snapshot.checksum !==
      createHash("sha256").update(JSON.stringify(snapshot.state)).digest("hex")
  ) {
    throw snapshotError(
      "AUTH_SNAPSHOT_INVALID",
      "The authentication snapshot is inconsistent.",
    );
  }
  return { state: snapshot.state, metadata: metadata(snapshot) };
}

/** Atomic create-only publication: retries return the original immutable generation. */
export async function publishAuthSnapshot(
  root: string,
  reference: AuthSnapshotReference,
  context: Pick<BrowserContext, "storageState">,
  verify?: (state: StorageState) => Promise<void>,
) {
  const path = snapshotPath(root, reference);
  try {
    const existing = await readAuthSnapshot(root, reference);
    await verify?.(existing.state);
    return existing.metadata;
  } catch (error) {
    if ((error as { code?: string }).code !== "AUTH_SNAPSHOT_MISSING")
      throw error;
  }
  const state = await context.storageState({ indexedDB: true });
  await verify?.(state);
  const snapshot: SnapshotFile = {
    schemaVersion: 1,
    ...reference,
    createdAt: new Date().toISOString(),
    checksum: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
    state,
  };
  const directory = join(root, reference.profileKey, ".auth-snapshots");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${reference.generation}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, JSON.stringify(snapshot), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      // link is atomic and, unlike rename, cannot overwrite an existing generation.
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return (await readAuthSnapshot(root, reference)).metadata;
  } finally {
    await rm(temporary, { force: true });
  }
}
