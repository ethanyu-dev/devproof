import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { BrowserSessionManager } from "./index.js";
import { discoverBrowserProcess } from "./browser-processes.js";

function memoryStore() {
  const state: {
    sessions: Array<Record<string, unknown>>;
    revokedSessionIds: string[];
  } = { sessions: [], revokedSessionIds: [] };
  return {
    value: () => state,
    replaceSession: async (session: Record<string, unknown>) => {
      state.sessions = [
        ...state.sessions.filter((row) => row.sessionId !== session.sessionId),
        session,
      ];
    },
    removeSession: async (id: string) => {
      state.sessions = state.sessions.filter((row) => row.sessionId !== id);
    },
    revokeSession: async (id: string) => {
      state.revokedSessionIds.push(id);
    },
  };
}

describe("browser session fencing and closure", () => {
  it("waits for a pending snapshot probe browser before confirming session closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "devproof-probe-cancel-"));
    const manager = new BrowserSessionManager(
      memoryStore() as never,
      "http://127.0.0.1:1",
      () => undefined,
      () => undefined,
      () => undefined,
      undefined,
      { profileRoot: root, requirePermits: true },
    );
    const id = randomUUID();
    const token = randomUUID();
    const command = {
      commandId: randomUUID(),
      type: "command.execute" as const,
      commandType: "session.open" as const,
      sessionId: id,
      fencingToken: "1",
      leaseToken: token,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      permit: {
        sessionId: id,
        fencingToken: "1",
        leaseToken: token,
        ownerKind: "SYSTEM" as const,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
      payload: {
        profileKey: "probe-source",
        profileMode: "PERSISTENT",
        profileRetention: { kind: "USER", inactivityTtlSeconds: 2_592_000 },
      },
    };
    await manager.execute(command);
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = chromium.launch.bind(chromium);
    const launch = vi
      .spyOn(chromium, "launch")
      .mockImplementationOnce(async (options) => {
        started();
        await wait;
        return original(options);
      });
    const snapshot = manager.execute({
      ...command,
      commandType: "profile.snapshot",
      payload: {
        profileKey: "probe-source",
        generation: 1,
        verification: { url: "http://127.0.0.1:1/protected" },
        probeConcurrency: 4,
      },
    });
    const failedProbe = expect(snapshot).rejects.toMatchObject({
      code: "AUTH_SNAPSHOT_PROBE_FAILED",
    });
    try {
      await starting;
      let closed = false;
      const closing = manager.close(id).then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closed).toBe(false);
      resume();
      await failedProbe;
      await closing;
      expect(await discoverBrowserProcess(id)).toBeNull();
      expect(manager.descriptors()).toHaveLength(0);
    } finally {
      resume();
      launch.mockRestore();
      await manager.close(id);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("confirms closure of a persisted Chromium process before acknowledging restart cleanup", async () => {
    const store = memoryStore();
    const events = vi.fn();
    const original = new BrowserSessionManager(
      store as never,
      "http://127.0.0.1:1",
      events,
      () => undefined,
    );
    const id = randomUUID();
    const token = randomUUID();
    await original.execute({
      commandId: randomUUID(),
      commandType: "session.open",
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      fencingToken: "1",
      leaseToken: token,
      permit: {
        sessionId: id,
        leaseToken: token,
        fencingToken: "1",
        ownerKind: "STARTUP",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
      payload: { profileKey: `restart-${id}`, profileMode: "EPHEMERAL" },
      sessionId: id,
      type: "command.execute",
    });
    expect(await discoverBrowserProcess(id)).not.toBeNull();
    const restarted = new BrowserSessionManager(
      store as never,
      "http://127.0.0.1:1",
      events,
      () => undefined,
    );
    try {
      await restarted.close(id);
      expect(await discoverBrowserProcess(id)).toBeNull();
      expect(store.value().sessions).toHaveLength(0);
      expect(events).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: id }),
        "SESSION_INTERRUPTED",
        { reason: "RESTART_CLEANUP", localClosureVerified: true },
      );
    } finally {
      await original.close(id);
    }
  }, 30_000);

  it("waits for an in-flight browser launch before acknowledging cancellation and fences its late completion", async () => {
    const manager = new BrowserSessionManager(
      memoryStore() as never,
      "http://127.0.0.1:1",
      () => undefined,
      () => undefined,
    );
    const id = randomUUID();
    const token = randomUUID();
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = chromium.launch.bind(chromium);
    const launch = vi
      .spyOn(chromium, "launch")
      .mockImplementationOnce(async (options) => {
        await wait;
        return original(options);
      });
    const command = {
      commandId: randomUUID(),
      commandType: "session.open" as const,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      fencingToken: "1",
      leaseToken: token,
      payload: { profileKey: `cancel-${id}`, profileMode: "EPHEMERAL" },
      sessionId: id,
      type: "command.execute" as const,
    };
    const opening = manager.execute(command);
    const rejectedOpening = expect(opening).rejects.toMatchObject({
      code: "SESSION_PERMIT_EXPIRED",
    });
    await expect(
      manager.execute({ ...command, fencingToken: "0" }),
    ).rejects.toMatchObject({ code: "SESSION_LOST" });
    await expect(
      manager.execute({
        ...command,
        commandType: "session.close",
        payload: {},
        fencingToken: "0",
      }),
    ).rejects.toMatchObject({ code: "SESSION_LOST" });
    let closed = false;
    const closing = manager.close(id).then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resume();
    try {
      await rejectedOpening;
      await closing;
      expect(manager.descriptors()).toHaveLength(0);
      expect(await discoverBrowserProcess(id)).toBeNull();
      await expect(manager.execute(command)).rejects.toMatchObject({
        code: "SESSION_PERMIT_EXPIRED",
      });
    } finally {
      launch.mockRestore();
      await manager.close(id);
    }
  }, 30_000);

  it("does not report a closed session when the browser refuses to close", async () => {
    const manager = new BrowserSessionManager(
      memoryStore() as never,
      "http://127.0.0.1:1",
      () => undefined,
      () => undefined,
    );
    const close = vi
      .fn()
      .mockRejectedValue(new Error("browser refused closure"));
    const id = randomUUID();
    const session = {
      sessionId: id,
      fencingToken: "2",
      leaseToken: randomUUID(),
      profileKey: "ephemeral-test",
      profileMode: "EPHEMERAL",
      state: "OPEN",
      // A Context close event is not proof that its parent Browser stopped.
      browserClosed: true,
      context: { unrouteAll: vi.fn().mockResolvedValue(undefined) },
      browser: { close, isConnected: () => true },
      networkFaultPolicies: new Map(),
      networkProxy: {
        setEnabled: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      },
    };
    (Reflect.get(manager, "sessions") as Map<string, unknown>).set(id, session);
    await expect(manager.close(id)).rejects.toThrow("browser refused closure");
    expect(manager.descriptors()).toMatchObject([
      { sessionId: id, state: "INTERRUPTED" },
    ]);
    expect(session.networkProxy.setEnabled).toHaveBeenCalledWith(false);
    close.mockResolvedValue(undefined);
    await manager.close(id);
    expect(manager.descriptors()).toHaveLength(0);
  });

  it("retains unverified persisted processes after a restart", async () => {
    const store = memoryStore();
    const id = randomUUID();
    await store.replaceSession({
      sessionId: id,
      leaseToken: randomUUID(),
      fencingToken: "2",
      profileKey: "old-profile",
      profileMode: "PERSISTENT",
      authSnapshot: { profileKey: "snapshot-source", generation: 1 },
      state: "INTERRUPTED",
    });
    const manager = new BrowserSessionManager(
      store as never,
      "http://127.0.0.1:1",
      () => undefined,
      () => undefined,
    );
    await expect(
      manager.execute({
        commandId: randomUUID(),
        type: "command.execute",
        commandType: "session.close",
        sessionId: id,
        leaseToken: randomUUID(),
        fencingToken: "1",
        payload: {},
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "SESSION_LOST" });
    expect(store.value().revokedSessionIds).toHaveLength(0);
    for (const profileKey of ["old-profile", "snapshot-source"])
      await expect(
        manager.execute({
          commandId: randomUUID(),
          type: "command.execute",
          commandType: "profile.purge",
          sessionId: randomUUID(),
          leaseToken: randomUUID(),
          fencingToken: "1",
          payload: { profileKey },
          deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        }),
      ).rejects.toMatchObject({ code: "PROFILE_IN_USE" });
    await expect(manager.close(id)).rejects.toMatchObject({
      code: "CLOSURE_UNVERIFIED",
    });
    expect(store.value().sessions).toHaveLength(1);
  });
});
