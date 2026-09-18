import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  authSnapshotReferenceSchema,
  authSnapshotVerificationSchema,
  type AuthSnapshotReference,
  type AuthSnapshotVerification,
} from "@devproof/runtime-protocol";
import type { BrowserContext, Page } from "playwright";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
type TransferState = {
  apiUrl: string;
  runtimeId: string;
  runtimeToken: string;
};
export type PortableSnapshot = {
  state: StorageState;
  verification: AuthSnapshotVerification;
};

export function snapshotEncryptionKey(value: string) {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32)
    throw new Error(
      "DEVPROOF_AUTH_SNAPSHOT_KEY must contain 32 base64-encoded bytes.",
    );
  return key;
}
function aad(reference: AuthSnapshotReference) {
  return Buffer.from(
    JSON.stringify({
      profileKey: reference.profileKey,
      generation: reference.generation,
    }),
  );
}
export function encryptSnapshot(
  value: PortableSnapshot,
  reference: AuthSnapshotReference,
  secret: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    snapshotEncryptionKey(secret),
    iv,
  );
  cipher.setAAD(aad(reference));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  if (data.length > 16 * 1024 * 1024)
    throw new Error("Authentication snapshot exceeds 16 MiB.");
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    data.toString("base64url"),
  ].join(".");
}
export function decryptSnapshot(
  envelope: string,
  reference: AuthSnapshotReference,
  secret: string,
): PortableSnapshot {
  const [version, iv, tag, data, extra] = envelope.split(".");
  if (
    version !== "v1" ||
    !iv ||
    !tag ||
    !data ||
    extra ||
    envelope.length > 24 * 1024 * 1024
  )
    throw new Error("Invalid authentication snapshot.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    snapshotEncryptionKey(secret),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(aad(reference));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const value = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString(),
  );
  if (
    !Array.isArray(value.state?.cookies) ||
    !Array.isArray(value.state?.origins)
  )
    throw new Error("Invalid authentication snapshot state.");
  return {
    state: value.state,
    verification: authSnapshotVerificationSchema.parse(value.verification),
  };
}
function endpoint(state: TransferState, sessionId: string) {
  const url = new URL(
    `/runtime/${state.runtimeId}/sessions/${sessionId}/auth-snapshot`,
    state.apiUrl,
  );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Authentication snapshot transfer requires HTTPS.");
  return url;
}
/** Persist the randomly encrypted envelope before the first network request.
 * Atomic create-only publication makes retries and concurrent calls reuse its IV.
 */
export async function prepareSnapshotEnvelope(
  root: string,
  reference: AuthSnapshotReference,
  snapshot: PortableSnapshot,
) {
  authSnapshotReferenceSchema.parse(reference);
  const secret = process.env.DEVPROOF_AUTH_SNAPSHOT_KEY ?? "";
  const directory = join(root, reference.profileKey, ".auth-snapshots");
  const path = join(directory, `${reference.generation}.portable`);
  const read = async () => {
    const envelope = await readFile(path, "utf8");
    if (
      !isDeepStrictEqual(decryptSnapshot(envelope, reference, secret), snapshot)
    )
      throw new Error("Snapshot generations are immutable.");
    return envelope;
  };
  try {
    return await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${reference.generation}-${randomUUID()}.portable.tmp`,
  );
  try {
    await writeFile(temporary, encryptSnapshot(snapshot, reference, secret), {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return await read();
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function uploadSnapshot(
  state: TransferState,
  sessionId: string,
  reference: AuthSnapshotReference,
  snapshot: PortableSnapshot,
  profilesRoot: string,
) {
  const envelope = await prepareSnapshotEnvelope(
    profilesRoot,
    reference,
    snapshot,
  );
  const response = await fetch(endpoint(state, sessionId), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${state.runtimeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ generation: reference.generation, envelope }),
  });
  if (!response.ok)
    throw new Error(
      `Authentication snapshot publication failed (${response.status}).`,
    );
}
export async function downloadSnapshot(
  state: TransferState,
  sessionId: string,
  reference: AuthSnapshotReference,
) {
  const response = await fetch(endpoint(state, sessionId), {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${state.runtimeToken}` },
  });
  if (!response.ok)
    throw new Error(
      `Authentication snapshot retrieval failed (${response.status}).`,
    );
  // The authenticated API enforces the same size limit at publication.
  const value = (await response.json()) as {
    envelope: string;
    profileKey: string;
    generation: number;
  };
  if (
    value.profileKey !== reference.profileKey ||
    value.generation !== reference.generation
  )
    throw new Error("Authentication snapshot version mismatch.");
  return decryptSnapshot(
    value.envelope,
    reference,
    process.env.DEVPROOF_AUTH_SNAPSHOT_KEY ?? "",
  );
}
export async function verifyPortableSnapshot(
  page: Page,
  verification: AuthSnapshotVerification,
) {
  const response = await page.goto(verification.url, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  const actual = new URL(page.url());
  const expected = new URL(verification.url);
  const match = (pattern: string) =>
    new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`,
      "u",
    ).test(actual.toString());
  if (
    (response?.status() ?? 0) >= 400 ||
    (verification.loginUrlPatterns ?? []).some(match) ||
    (verification.exactLocation || !verification.successUrlPatterns?.length
      ? actual.origin !== expected.origin ||
        actual.pathname.replace(/\/+$/u, "") !==
          expected.pathname.replace(/\/+$/u, "")
      : !verification.successUrlPatterns.some(match))
  )
    throw Object.assign(
      new Error("Authentication is not valid on this Runtime."),
      { code: "AUTH_SNAPSHOT_INCOMPATIBLE" },
    );
  if (verification.authenticatedSelector)
    await page
      .locator(verification.authenticatedSelector)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
}
