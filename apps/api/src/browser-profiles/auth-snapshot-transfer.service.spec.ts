import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSnapshotTransferService } from "./auth-snapshot-transfer.service.js";

beforeEach(() =>
  vi.stubEnv("BROWSER_AUTH_SNAPSHOT_DISTRIBUTION_ENABLED", "true"),
);
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const profile = {
    id: "profile",
    teamId: "team",
    ownerUserId: "user",
    runtimeProfileKey: "site-a",
    version: 4,
    assignedRuntimeId: "source",
    status: "VERIFYING",
    executionMode: "ISOLATED_AUTH",
    authSnapshotGeneration: 3,
    inactivityExpiresAt: new Date(Date.now() + 60_000),
    owner: { status: "ACTIVE", memberships: [{ teamId: "team" }] },
  };
  const session = {
    purpose: "PROFILE_PREPARATION",
    humanControllerUserId: "user",
    humanControlExpiresAt: new Date(Date.now() + 60_000),
    authSnapshotGeneration: 3,
    userBrowserProfile: profile,
  };
  const objects = new Map<string, Buffer>();
  const rows: Array<Record<string, any>> = [];
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    browserRuntime: {
      findFirst: vi.fn(async () => ({ teamId: "team", protocolMinor: 19 })),
    },
    browserRuntimeSession: {
      findFirst: vi.fn(async () => session),
      count: vi.fn(async () => 0),
    },
    userBrowserProfile: {
      findUniqueOrThrow: vi.fn(async () => profile),
      findUnique: vi.fn(async () => profile),
    },
    browserAuthSnapshot: {
      findUnique: vi.fn(
        async ({ where }) =>
          rows.find((r) =>
            where.id
              ? r.id === where.id
              : r.profileId === where.profileId_generation.profileId &&
                r.generation === where.profileId_generation.generation,
          ) ?? null,
      ),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error("Missing snapshot");
        return row;
      }),
      updateMany: vi.fn(async ({ data }) => {
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
      create: vi.fn(async ({ data }) => {
        const row = {
          ...data,
          id: "snapshot",
          uploadedAt: null,
          deletedAt: null,
        };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ data }) => Object.assign(rows[0]!, data)),
      findMany: vi.fn(async ({ where }) => (where.id ? [] : rows)),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const storage = {
    put: vi.fn(async (key: string, _type: string, body: Buffer) => {
      objects.set(key, body);
    }),
    get: vi.fn(async (key: string) => ({ body: objects.get(key)! })),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };
  const service = new AuthSnapshotTransferService(
    prisma as never,
    storage as never,
  );
  return { service, prisma, storage, profile, session, rows, objects };
}
describe("distributed authentication authorization and publication", () => {
  it("publishes once and refuses conflicting or stale generations", async () => {
    const f = fixture();
    await f.service.upload("source", "Bearer token", "login", 4, "ciphertext");
    expect(f.rows[0]?.uploadedAt).toBeInstanceOf(Date);
    await f.service.upload("source", "Bearer token", "login", 4, "ciphertext");
    expect(f.storage.put).toHaveBeenCalledTimes(1);
    await expect(
      f.service.upload("source", "Bearer token", "login", 4, "replacement"),
    ).rejects.toThrow("immutable");
    await expect(
      f.service.upload("source", "Bearer token", "login", 3, "old"),
    ).rejects.toThrow("superseded");
  });
  it("leaves failed uploads unpublished and retryable", async () => {
    const f = fixture();
    f.storage.put.mockRejectedValueOnce(new Error("offline"));
    await expect(
      f.service.upload("source", "Bearer token", "login", 4, "ciphertext"),
    ).rejects.toThrow("offline");
    expect(f.rows[0]?.uploadedAt).toBeNull();
    await f.service.upload("source", "Bearer token", "login", 4, "ciphertext");
    expect(f.rows[0]?.uploadedAt).toBeInstanceOf(Date);
  });
  it("serves only the generation pinned to the destination session", async () => {
    const f = fixture();
    await f.service.upload("source", "Bearer token", "login", 4, "ciphertext");
    f.profile.status = "READY";
    f.profile.authSnapshotGeneration = 5;
    f.session.purpose = "EXECUTION";
    f.session.authSnapshotGeneration = 4;
    expect(
      await f.service.download("destination", "Bearer token", "execution"),
    ).toEqual({ envelope: "ciphertext", profileKey: "site-a", generation: 4 });
    expect(f.prisma.browserRuntimeSession.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runtimeId: "destination",
          id: "execution",
          teamId: "team",
        }),
      }),
    );
    f.profile.status = "DISABLED";
    await expect(
      f.service.download("destination", "Bearer token", "execution"),
    ).rejects.toThrow();
  });
  it("does not accept execution writes, wrong nodes, or inactive membership", async () => {
    const f = fixture();
    await expect(
      f.service.upload("destination", "Bearer token", "login", 4, "ciphertext"),
    ).rejects.toThrow();
    f.session.purpose = "EXECUTION";
    await expect(
      f.service.upload("source", "Bearer token", "login", 4, "ciphertext"),
    ).rejects.toThrow();
    f.session.purpose = "PROFILE_PREPARATION";
    f.profile.owner.memberships = [];
    await expect(
      f.service.upload("source", "Bearer token", "login", 4, "ciphertext"),
    ).rejects.toThrow();
    expect(f.storage.put).not.toHaveBeenCalled();
  });
  it("keeps active versions and live session pins, then physically deletes unreferenced generations", async () => {
    const f = fixture();
    await f.service.upload("source", "Bearer token", "login", 4, "ciphertext");
    f.profile.status = "READY";
    f.profile.authSnapshotGeneration = 4;
    await f.service.collect();
    expect(f.storage.delete).not.toHaveBeenCalled();
    f.profile.authSnapshotGeneration = 5;
    f.prisma.browserRuntimeSession.count.mockResolvedValueOnce(1);
    await f.service.collect();
    expect(f.storage.delete).not.toHaveBeenCalled();
    await f.service.collect();
    expect(f.storage.delete).toHaveBeenCalledOnce();
  });
  it("rejects corrupted encrypted objects", async () => {
    const f = fixture();
    await f.service.upload("source", "Bearer token", "login", 4, "ciphertext");
    f.profile.status = "READY";
    f.session.purpose = "EXECUTION";
    f.session.authSnapshotGeneration = 4;
    f.storage.get.mockResolvedValueOnce({ body: Buffer.from("corrupt") });
    await expect(
      f.service.download("destination", "Bearer token", "execution"),
    ).rejects.toThrow("integrity");
    expect(f.prisma.browserRuntime.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tokenHash: createHash("sha256").update("token").digest("hex"),
        }),
      }),
    );
  });
});

describe("snapshot deletion races", () => {
  it("cleans a late upload after purge and retains its tombstone", async () => {
    const f = fixture();
    let resume!: () => void;
    let entered!: () => void;
    const uploading = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const put = f.storage.put.getMockImplementation()!;
    f.storage.put.mockImplementation(async (...args) => {
      entered();
      await gate;
      return put(...args);
    });
    const upload = f.service.upload(
      "source",
      "Bearer token",
      "login",
      4,
      "ciphertext",
    );
    const rejected = expect(upload).rejects.toThrow();
    await uploading;
    f.profile.status = "DISABLED";
    await f.service.purgeProfile("profile");
    expect(f.rows[0]!.deletedAt).toBeInstanceOf(Date);
    resume();
    await rejected;
    expect(f.objects.size).toBe(0);
    expect(f.rows).toHaveLength(1);
    expect(f.storage.delete).toHaveBeenCalledTimes(2);
  });
  it("retries cleanup when compensation fails or a timed-out write finishes later", async () => {
    const f = fixture();
    await f.service.upload("source", "Bearer token", "login", 4, "ciphertext");
    f.profile.status = "DISABLED";
    f.storage.delete.mockRejectedValueOnce(new Error("S3 offline"));
    await expect(f.service.purgeProfile("profile")).rejects.toThrow(
      "S3 offline",
    );
    expect(f.rows[0]!.deletedAt).toBeInstanceOf(Date);
    await f.service.collect();
    expect(f.objects.size).toBe(0);
    // Simulate a PUT finishing after its worker has crashed, even after cleanup.
    f.objects.set(f.rows[0]!.storageKey, Buffer.from("late ciphertext"));
    await f.service.collect();
    expect(f.objects.size).toBe(0);
    expect(f.rows).toHaveLength(1);
    f.profile.status = "VERIFYING";
    await expect(
      f.service.upload("source", "Bearer token", "login", 4, "ciphertext"),
    ).rejects.toThrow("deleted");
    f.profile.status = "READY";
    f.session.purpose = "EXECUTION";
    f.session.authSnapshotGeneration = 4;
    await expect(
      f.service.download("destination", "Bearer token", "execution"),
    ).rejects.toThrow("unavailable");
  });
});
