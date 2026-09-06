import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runtimeClosureEvidenceSchema,
  type RuntimeClosureRecovery,
} from "@devproof/runtime-protocol";
import { BrowserSessionManager, RuntimeClient } from "./index.js";
import { SessionClosureJournal } from "./closure-journal.js";
import {
  browserProcessMarker,
  discoverBrowserProcess,
} from "./browser-processes.js";

const identity = {
  hostInstanceId: "a".repeat(64),
  daemonInstanceId: randomUUID(),
};
const temporaryRoots: string[] = [];
const managers: BrowserSessionManager[] = [];
const sessions = new Map<BrowserSessionManager, string[]>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0))
    for (const sessionId of sessions.get(manager) ?? [])
      await manager.close(sessionId).catch(() => undefined);
  sessions.clear();
  for (const root of temporaryRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), "devproof-closure-evidence-"));
  temporaryRoots.push(root);
  const state: { sessions: Array<any>; revokedSessionIds: string[] } = {
    sessions: [],
    revokedSessionIds: [],
  };
  const store = {
    value: () => state,
    async replaceSession(session: any) {
      state.sessions = [
        ...state.sessions.filter((row) => row.sessionId !== session.sessionId),
        session,
      ];
    },
    async removeSession(id: string) {
      state.sessions = state.sessions.filter((row) => row.sessionId !== id);
    },
    async revokeSession(id: string) {
      state.revokedSessionIds.push(id);
    },
  };
  const journal = new SessionClosureJournal(join(root, "closure"));
  const create = (
    daemon = identity.daemonInstanceId,
    host = identity.hostInstanceId,
  ) => {
    const manager = new BrowserSessionManager(
      store as never,
      "http://127.0.0.1:1",
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      {
        profileRoot: join(root, "profiles"),
        closureJournal: journal,
        closureEvidenceEnabled: enabled,
        processIdentity: async () => ({
          hostInstanceId: host,
          daemonInstanceId: daemon,
        }),
      },
    );
    managers.push(manager);
    sessions.set(manager, []);
    return manager;
  };
  const manager = create();
  const command = {
    commandId: randomUUID(),
    commandType: "session.open" as const,
    type: "command.execute" as const,
    sessionId: randomUUID(),
    leaseToken: randomUUID(),
    fencingToken: "3",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    payload: { profileKey: randomUUID(), profileMode: "EPHEMERAL" },
  };
  sessions.get(manager)!.push(command.sessionId);
  const request: RuntimeClosureRecovery = {
    recoveryId: randomUUID(),
    requestId: randomUUID(),
    sessionId: command.sessionId,
    expectedLeaseToken: command.leaseToken,
    expectedFencingToken: command.fencingToken,
  };
  const close = (target = manager, recovery = request) =>
    target.execute({
      ...command,
      commandId: recovery.requestId,
      commandType: "session.close",
      payload: { recovery },
    });
  return {
    root,
    state,
    store,
    journal,
    create,
    manager,
    command,
    request,
    close,
  };
}

describe("challenge-bound durable closure evidence", () => {
  it("requires explicit negotiated capability, even at the newest protocol minor", async () => {
    const f = await fixture(false);
    f.manager.configureProtocol(14, new Date().toISOString(), 0, []);
    await expect(f.close()).rejects.toMatchObject({
      code: "CLOSURE_CAPABILITY_REQUIRED",
    });
    expect(await f.journal.read(f.command.sessionId)).toBeUndefined();
  });

  it("closes a rejected profile launch durably without closing its existing owner", async () => {
    const f = await fixture();
    const owner = {
      ...f.command,
      sessionId: randomUUID(),
      leaseToken: randomUUID(),
      payload: {
        profileKey: "busy-profile",
        profileMode: "PERSISTENT",
        profileRetention: { kind: "USER", inactivityTtlSeconds: 2_592_000 },
        launchIdentityId: randomUUID(),
      },
    };
    sessions.get(f.manager)!.push(owner.sessionId);
    await f.manager.execute(owner);
    const rejected = {
      ...f.command,
      payload: { ...owner.payload, launchIdentityId: randomUUID() },
    };
    const request = {
      ...f.request,
      expectedLaunchIdentity: rejected.payload.launchIdentityId,
    };
    await expect(f.manager.execute(rejected)).rejects.toMatchObject({
      code: "PROFILE_IN_USE",
    });
    await expect(f.close(f.manager, request)).resolves.toMatchObject({
      result: {
        closed: true,
        closureEvidence: {
          sessionId: rejected.sessionId,
          method: "IDENTIFIED_PROCESS_SET_TERMINATED",
          networkRevoked: true,
        },
      },
    });
    expect(await discoverBrowserProcess(owner.sessionId)).not.toBeNull();
    expect(await discoverBrowserProcess(rejected.sessionId)).toBeNull();
    await expect(f.manager.execute(owner)).resolves.toHaveProperty("result");
    await expect(f.manager.execute(rejected)).rejects.toMatchObject({
      code: "SESSION_PERMIT_EXPIRED",
    });

    const restarted = f.create(randomUUID());
    await expect(
      f.close(restarted, { ...request, requestId: randomUUID() }),
    ).resolves.toMatchObject({ result: { closed: true } });
    await expect(restarted.execute(rejected)).rejects.toMatchObject({
      code: "SESSION_PERMIT_EXPIRED",
    });
  }, 30_000);

  it.each(["PERSISTENT", "AUTH_SNAPSHOT", "JOURNAL_FAILURE"])(
    "retains another opening profile's reservation after rejecting %s",
    async (mode) => {
      const f = await fixture();
      const owner = {
        ...f.command,
        sessionId: randomUUID(),
        leaseToken: randomUUID(),
        payload: {
          profileKey: "opening-profile",
          profileMode: "PERSISTENT",
          profileRetention: { kind: "USER", inactivityTtlSeconds: 2_592_000 },
          launchIdentityId: randomUUID(),
        },
      };
      sessions.get(f.manager)!.push(owner.sessionId);
      let resume!: () => void;
      const waiting = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let started!: () => void;
      const starting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const original = chromium.launchPersistentContext.bind(chromium);
      const launch = vi
        .spyOn(chromium, "launchPersistentContext")
        .mockImplementationOnce(async (...args) => {
          started();
          await waiting;
          return original(...args);
        });
      const opening = f.manager.execute(owner);
      try {
        await starting;
        for (let attempt = 0; attempt < 2; attempt++) {
          const sessionId = attempt === 0 ? f.command.sessionId : randomUUID();
          sessions.get(f.manager)!.push(sessionId);
          const rejected = {
            ...f.command,
            sessionId,
            permit: {
              sessionId,
              leaseToken: f.command.leaseToken,
              fencingToken: f.command.fencingToken,
              ownerKind: "STARTUP" as const,
              expiresAt: f.command.deadlineAt,
            },
            payload:
              mode !== "AUTH_SNAPSHOT"
                ? { ...owner.payload, launchIdentityId: randomUUID() }
                : {
                    profileKey: randomUUID(),
                    profileMode: "EPHEMERAL",
                    authSnapshot: {
                      profileKey: owner.payload.profileKey,
                      generation: 1,
                    },
                    launchIdentityId: randomUUID(),
                  },
          };
          if (mode === "JOURNAL_FAILURE" && attempt === 0) {
            const failure = vi
              .spyOn(f.journal, "recordLaunch")
              .mockRejectedValue(new Error("journal disk full"));
            try {
              await expect(f.manager.execute(rejected)).rejects.toThrow(
                "journal disk full",
              );
              expect(await f.journal.read(sessionId)).toBeUndefined();
              await expect(
                f.close(f.manager, {
                  ...f.request,
                  expectedLaunchIdentity: rejected.payload.launchIdentityId,
                }),
              ).rejects.toMatchObject({ code: "CLOSURE_UNVERIFIED" });
              expect(await f.journal.read(sessionId)).toBeUndefined();
            } finally {
              failure.mockRestore();
            }
            // A new attempt below must still see the original reservation.
            continue;
          }
          await expect(f.manager.execute(rejected)).rejects.toMatchObject({
            code: "PROFILE_IN_USE",
          });
          expect(await f.journal.read(sessionId)).toMatchObject({
            launch: { id: rejected.payload.launchIdentityId },
            closed: { method: "IDENTIFIED_PROCESS_SET_TERMINATED" },
          });
          if (attempt === 0)
            await expect(
              f.close(f.manager, {
                ...f.request,
                expectedLaunchIdentity: rejected.payload.launchIdentityId,
              }),
            ).resolves.toMatchObject({ result: { closed: true } });
        }
        expect(launch).toHaveBeenCalledTimes(1);
      } finally {
        resume();
        await opening;
      }
      expect(await discoverBrowserProcess(owner.sessionId)).not.toBeNull();
    },
    30_000,
  );

  it("fences a rejected launch when close races its initial journal write", async () => {
    const f = await fixture();
    const rejected = {
      ...f.command,
      payload: { ...f.command.payload, launchIdentityId: randomUUID() },
    };
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const recordLaunch = f.journal.recordLaunch.bind(f.journal);
    vi.spyOn(f.journal, "recordLaunch").mockImplementationOnce(
      async (...args) => {
        started();
        await waiting;
        return recordLaunch(...args);
      },
    );
    const opening = f.manager.execute(rejected);
    const openingRejected = expect(opening).rejects.toMatchObject({
      code: "SESSION_PERMIT_EXPIRED",
    });
    try {
      await starting;
      const closing = f.close(f.manager, {
        ...f.request,
        expectedLaunchIdentity: rejected.payload.launchIdentityId,
      });
      await vi.waitFor(async () => {
        expect(await f.journal.read(rejected.sessionId)).toHaveProperty(
          "revokedAt",
        );
      });
      resume();
      await openingRejected;
      await expect(closing).resolves.toMatchObject({
        result: { closed: true },
      });
      await expect(f.manager.execute(rejected)).rejects.toMatchObject({
        code: "SESSION_PERMIT_EXPIRED",
      });
      expect(await discoverBrowserProcess(rejected.sessionId)).toBeNull();
    } finally {
      resume();
      await openingRejected;
    }
  });

  it("does not prove a legacy session or unknown browser closed from an empty marker scan", async () => {
    const f = await fixture();
    await expect(f.close()).rejects.toMatchObject({
      code: "CLOSURE_UNVERIFIED",
    });
    await f.store.replaceSession({
      ...f.command,
      profileKey: "legacy",
      profileMode: "EPHEMERAL",
      state: "INTERRUPTED",
    });
    await expect(f.close()).rejects.toMatchObject({
      code: "CLOSURE_UNVERIFIED",
    });
    expect(f.state.sessions).toHaveLength(1);
    await expect(f.manager.execute(f.command)).rejects.toMatchObject({
      code: "CLOSURE_UNVERIFIED",
    });
    await expect(f.close()).rejects.toMatchObject({
      code: "CLOSURE_UNVERIFIED",
    });
    expect((await f.journal.read(f.command.sessionId))?.closed).toBeUndefined();
  });

  it("retains an interrupted launch when a crash left no complete process identity", async () => {
    const f = await fixture();
    await f.journal.recordLaunch(
      f.command,
      identity,
      browserProcessMarker(f.command.sessionId),
    );
    await expect(f.close()).rejects.toMatchObject({
      code: "CLOSURE_UNVERIFIED",
    });
    expect((await f.journal.read(f.command.sessionId))?.closed).toBeUndefined();
  });

  it("closes real Chromium, persists proof, and replays a fresh challenge after daemon restart", async () => {
    const f = await fixture();
    const opened = await f.manager.execute(f.command);
    expect(opened).toMatchObject({
      result: {
        launchIdentityVersion: 1,
        launchHostInstanceId: identity.hostInstanceId,
      },
    });
    expect(await discoverBrowserProcess(f.command.sessionId)).not.toBeNull();
    const closed = await f.close();
    const proof = runtimeClosureEvidenceSchema.parse(
      (closed as any).result.closureEvidence,
    );
    expect(proof).toMatchObject({
      method: "LIVE_SESSION_TERMINATED",
      networkRevoked: true,
      ...identity,
    });
    expect(await discoverBrowserProcess(f.command.sessionId)).toBeNull();
    expect(f.state.sessions).toHaveLength(0);
    expect(((await f.close()) as any).result.closureEvidence).toEqual(proof);
    const daemon = randomUUID();
    const restarted = f.create(daemon);
    const replay = await f.close(restarted, {
      ...f.request,
      requestId: randomUUID(),
    });
    expect((replay as any).result.closureEvidence).toMatchObject({
      daemonInstanceId: daemon,
      closureCompletedAt: proof.closureCompletedAt,
    });
    await expect(restarted.execute(f.command)).rejects.toMatchObject({
      code: "SESSION_PERMIT_EXPIRED",
    });
  }, 30_000);

  it("can close a persisted process from the same host but never from copied state on another host", async () => {
    const f = await fixture();
    await f.manager.execute(f.command);
    const foreign = f.create(randomUUID(), "b".repeat(64));
    await expect(f.close(foreign)).rejects.toMatchObject({
      code: "CLOSURE_UNVERIFIED",
    });
    expect(await discoverBrowserProcess(f.command.sessionId)).not.toBeNull();
    const restarted = f.create(randomUUID());
    const closed = await f.close(restarted);
    expect((closed as any).result.closureEvidence).toMatchObject({
      method: "IDENTIFIED_PROCESS_SET_TERMINATED",
    });
    expect(await discoverBrowserProcess(f.command.sessionId)).toBeNull();
  }, 30_000);

  it("recovers a server-registered launch when its open acknowledgement was lost", async () => {
    const f = await fixture();
    const launchIdentityId = randomUUID();
    // The API persisted this challenge before dispatch; deliberately discard the open result.
    await f.manager.execute({
      ...f.command,
      payload: { ...f.command.payload, launchIdentityId },
    });
    expect((await f.journal.read(f.command.sessionId))?.launch?.id).toBe(
      launchIdentityId,
    );
    const restarted = f.create(randomUUID());
    const response = await f.close(restarted, {
      ...f.request,
      expectedLaunchIdentity: launchIdentityId,
    });
    expect((response as any).result.closureEvidence).toMatchObject({
      method: "IDENTIFIED_PROCESS_SET_TERMINATED",
      networkRevoked: true,
    });
    expect(await discoverBrowserProcess(f.command.sessionId)).toBeNull();
  }, 30_000);

  it("rejects a wrong epoch or launch challenge before revoking the live session", async () => {
    const f = await fixture();
    await f.manager.execute(f.command);
    await expect(
      f.close(f.manager, { ...f.request, expectedFencingToken: "2" }),
    ).rejects.toMatchObject({ code: "SESSION_LOST" });
    await expect(
      f.close(f.manager, {
        ...f.request,
        expectedLaunchIdentity: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "SESSION_LOST" });
    expect(f.state.revokedSessionIds).toHaveLength(0);
    expect(await discoverBrowserProcess(f.command.sessionId)).not.toBeNull();
  }, 30_000);

  it("retains physical closure proof when video finalization and its diagnostic fail", async () => {
    const f = await fixture();
    await f.manager.execute(f.command);
    const live = (Reflect.get(f.manager, "sessions") as Map<string, any>).get(
      f.command.sessionId,
    );
    live.stepFrames.push({ data: Buffer.from("frame"), index: 1 });
    const video = vi
      .spyOn(f.manager as any, "composeClosedSessionVideo")
      .mockImplementation(async () => {
        expect(
          (await f.journal.read(f.command.sessionId))?.closed,
        ).toBeDefined();
        expect(await discoverBrowserProcess(f.command.sessionId)).toBeNull();
        throw new Error("encoder failure");
      });
    vi.spyOn(f.manager as any, "emitDiagnostic").mockRejectedValue(
      new Error("diagnostic disk full"),
    );
    const result = await f.close();
    expect((result as any).result).toMatchObject({
      closed: true,
      videoCreated: false,
      closureEvidence: { networkRevoked: true },
      videoError: { message: "encoder failure" },
    });
    expect(((await f.close()) as any).result.closureEvidence).toEqual(
      (result as any).result.closureEvidence,
    );
    expect(video).toHaveBeenCalledOnce();
  }, 30_000);

  it("renders the saved frames after closing the execution browser", async () => {
    const f = await fixture();
    await f.manager.execute(f.command);
    await Reflect.get(f.manager, "captureStepArtifact").call(
      f.manager,
      f.command.sessionId,
      "session.complete",
    );
    const result = await f.close();
    expect((result as any).result).toMatchObject({
      closed: true,
      videoCreated: true,
      closureEvidence: { networkRevoked: true },
    });
    expect((result as any).artifacts).toEqual([
      expect.objectContaining({ kind: "VIDEO", contentType: "video/webm" }),
    ]);
    expect(await discoverBrowserProcess(f.command.sessionId)).toBeNull();
  }, 30_000);

  it("cannot return success if persisting the closure tombstone fails", async () => {
    const f = await fixture();
    await f.manager.execute(f.command);
    const complete = vi
      .spyOn(f.journal, "complete")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(f.close()).rejects.toThrow("disk full");
    expect((await f.journal.read(f.command.sessionId))?.closed).toBeUndefined();
    expect(f.state.sessions).toHaveLength(1);
    complete.mockRestore();
    expect(
      ((await f.close()) as any).result.closureEvidence.networkRevoked,
    ).toBe(true);
  }, 30_000);

  it("waits for an in-flight launch, prevents revival, and then produces closure evidence", async () => {
    const f = await fixture();
    const original = chromium.launch.bind(chromium);
    let release!: () => void;
    let started!: () => void;
    const launchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(chromium, "launch").mockImplementationOnce(async (options) => {
      started();
      await barrier;
      return original(options);
    });
    const opening = f.manager.execute(f.command);
    const rejected = expect(opening).rejects.toMatchObject({
      code: "SESSION_PERMIT_EXPIRED",
    });
    await launchStarted;
    const closing = f.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await f.journal.read(f.command.sessionId))?.closed).toBeUndefined();
    release();
    await rejected;
    expect(((await closing) as any).result.closureEvidence.networkRevoked).toBe(
      true,
    );
    expect(await discoverBrowserProcess(f.command.sessionId)).toBeNull();
  }, 30_000);

  it("keeps durable close results across outbox reconstruction until acknowledgement", async () => {
    const f = await fixture();
    await f.journal.recordLaunch(
      f.command,
      identity,
      browserProcessMarker(f.command.sessionId),
    );
    await f.journal.revoke(f.command);
    await f.journal.complete(f.command, identity, "LIVE_SESSION_TERMINATED");
    const proof = await f.journal.evidence(f.request, identity);
    const response = {
      type: "command.result" as const,
      commandId: f.request.requestId,
      sessionId: f.command.sessionId,
      leaseToken: f.command.leaseToken,
      fencingToken: f.command.fencingToken,
      ok: true,
      artifacts: [],
      result: { closed: true, closureEvidence: proof },
    };
    await f.journal.queueResult(response);
    const restarted = new SessionClosureJournal(f.journal.root);
    expect(await restarted.pendingResults(identity)).toEqual([response]);
    expect(
      await restarted.pendingResults({
        ...identity,
        daemonInstanceId: randomUUID(),
      }),
    ).toEqual([]);
    await restarted.acknowledge(response.commandId);
    expect(await restarted.pendingResults(identity)).toEqual([]);
    expect(await restarted.evidence(f.request, identity)).toEqual(proof);
  });

  it("persists a close result after disconnect and waits for a new handshake before sending", async () => {
    const f = await fixture();
    await f.journal.recordLaunch(
      f.command,
      identity,
      browserProcessMarker(f.command.sessionId),
    );
    await f.journal.revoke(f.command);
    await f.journal.complete(f.command, identity, "LIVE_SESSION_TERMINATED");
    const proof = await f.journal.evidence(f.request, identity);
    const client = new RuntimeClient(
      f.store as never,
      { server: "http://127.0.0.1:1" } as never,
    );
    const manager = Reflect.get(client, "manager");
    Reflect.set(manager, "closureJournal", f.journal);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(manager, "execute").mockImplementation(async () => {
      await barrier;
      return { result: { closed: true, closureEvidence: proof } };
    });
    const send = vi.fn();
    Reflect.set(client, "socket", { readyState: 1, send });
    Reflect.set(client, "negotiatedProtocolMinor", 14);
    Reflect.set(client, "connectionReady", true);
    Reflect.set(client, "deliveryAcknowledgements", true);
    const command = {
      ...f.command,
      commandId: f.request.requestId,
      commandType: "session.close",
      payload: { recovery: f.request },
    };
    const dispatch = Reflect.get(client, "executeCommand").call(
      client,
      command,
    );
    const pending = Reflect.get(client, "pending") as Map<
      string,
      { controller: AbortController }
    >;
    pending
      .get(command.commandId)!
      .controller.abort(new Error("socket disconnected"));
    Reflect.set(client, "connectionReady", false);
    release();
    await dispatch;
    expect(send).not.toHaveBeenCalled();
    expect(await f.journal.pendingResults(identity)).toHaveLength(1);
    Reflect.set(client, "connectionReady", true);
    Reflect.get(client, "flushOutbox").call(client);
    expect(send).toHaveBeenCalledOnce();
    await Reflect.get(client, "acknowledgeOutbox").call(
      client,
      command.commandId,
      "command.result",
    );
    expect(await f.journal.pendingResults(identity)).toEqual([]);
  });

  it("fails closed on a corrupt persisted record instead of replacing it", async () => {
    const f = await fixture();
    await f.journal.recordLaunch(
      f.command,
      identity,
      browserProcessMarker(f.command.sessionId),
    );
    await writeFile(
      join(f.journal.root, "sessions", `${f.command.sessionId}.json`),
      "broken",
      "utf8",
    );
    await expect(f.close()).rejects.toThrow();
  });
});
