import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptSnapshot,
  uploadSnapshot,
  prepareSnapshotEnvelope,
  encryptSnapshot,
  verifyPortableSnapshot,
} from "./distributed-auth-snapshots.js";
import type { Page } from "playwright";
const key = randomBytes(32).toString("base64");
const reference = { profileKey: "user-site-a", generation: 3 };
const snapshot = {
  state: {
    cookies: [],
    origins: [
      {
        origin: "https://example.com",
        localStorage: [{ name: "auth", value: "secret" }],
      },
    ],
  },
  verification: {
    url: "https://example.com/dashboard",
    loginUrlPatterns: ["*/login*"],
  },
};
describe("portable authentication snapshots", () => {
  it("roundtrips without exposing credentials and binds ciphertext to the exact site generation", () => {
    const encrypted = encryptSnapshot(snapshot, reference, key);
    expect(encrypted).not.toContain("secret");
    expect(decryptSnapshot(encrypted, reference, key)).toEqual(snapshot);
    expect(() =>
      decryptSnapshot(encrypted, { ...reference, generation: 4 }, key),
    ).toThrow();
    expect(() =>
      decryptSnapshot(
        encrypted,
        { ...reference, profileKey: "other-user" },
        key,
      ),
    ).toThrow();
    expect(() =>
      decryptSnapshot(encrypted, reference, randomBytes(32).toString("base64")),
    ).toThrow();
    const parts = encrypted.split(".");
    const data = Buffer.from(parts[3]!, "base64url");
    data[0] = data[0]! ^ 1;
    parts[3] = data.toString("base64url");
    expect(() => decryptSnapshot(parts.join("."), reference, key)).toThrow();
  });
  it("rejects login redirects on the destination VM before executing work", async () => {
    const page = {
      goto: vi.fn(async () => ({ status: () => 200 })),
      url: () => "https://example.com/login",
    } as unknown as Page;
    await expect(
      verifyPortableSnapshot(page, snapshot.verification),
    ).rejects.toThrow("not valid");
  });
  it("verifies the actual destination session and authenticated element", async () => {
    const waitFor = vi.fn(async () => undefined);
    const page = {
      goto: vi.fn(async () => ({ status: () => 200 })),
      url: () => "https://example.com/dashboard?tab=1",
      locator: vi.fn(() => ({ first: () => ({ waitFor }) })),
    } as unknown as Page;
    await verifyPortableSnapshot(page, {
      ...snapshot.verification,
      authenticatedSelector: "#account",
    });
    expect(waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 15_000 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("reuses a durable ciphertext after failed and uncertain uploads", async () => {
  vi.stubEnv("DEVPROOF_AUTH_SNAPSHOT_KEY", key);
  const root = await mkdtemp(join(tmpdir(), "devproof-envelope-"));
  let reserved: string | undefined;
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const envelope = JSON.parse(init.body).envelope as string;
      // The local envelope must exist before a request can reserve the server row.
      expect(
        await readFile(
          join(
            root,
            reference.profileKey,
            ".auth-snapshots",
            `${reference.generation}.portable`,
          ),
          "utf8",
        ),
      ).toBe(envelope);
      if (reserved && reserved !== envelope)
        return new Response("immutable", { status: 409 });
      reserved = envelope;
      attempts++;
      if (attempts === 1)
        return new Response("storage failure", { status: 500 });
      if (attempts === 2) throw new Error("response lost after commit");
      return new Response("{}");
    }),
  );
  const node = {
    apiUrl: "https://api.example",
    runtimeId: "runtime",
    runtimeToken: "token",
  };
  try {
    await expect(
      uploadSnapshot(node, "session", reference, snapshot, root),
    ).rejects.toThrow("500");
    await expect(
      uploadSnapshot(node, "session", reference, snapshot, root),
    ).rejects.toThrow("response lost");
    // Reimporting simulates a fresh process, with only the on-disk envelope shared.
    vi.resetModules();
    const fresh = await import("./distributed-auth-snapshots.js");
    await fresh.uploadSnapshot(
      node,
      "session",
      reference,
      structuredClone(snapshot),
      root,
    );
    expect(attempts).toBe(3);
    expect(decryptSnapshot(reserved!, reference, key)).toEqual(snapshot);
    await expect(
      prepareSnapshotEnvelope(root, reference, {
        ...snapshot,
        verification: { url: "https://example.com/changed" },
      }),
    ).rejects.toThrow("immutable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("concurrent publishers share the first immutable encrypted envelope", async () => {
  vi.stubEnv("DEVPROOF_AUTH_SNAPSHOT_KEY", key);
  const root = await mkdtemp(join(tmpdir(), "devproof-envelope-race-"));
  try {
    const envelopes = await Promise.all(
      Array.from({ length: 8 }, () =>
        prepareSnapshotEnvelope(root, reference, snapshot),
      ),
    );
    expect(new Set(envelopes).size).toBe(1);
    expect(decryptSnapshot(envelopes[0]!, reference, key)).toEqual(snapshot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
