import { generateKeyPairSync, randomUUID, verify } from "node:crypto";

import { ConflictException, NotFoundException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunBrowserPreviewService } from "./run-browser-preview.service.js";

function fixture(run: unknown) {
  const findFirst = vi.fn().mockResolvedValue(run);
  const subscribe = vi.fn().mockResolvedValue(vi.fn());
  const service = new RunBrowserPreviewService(
    { executionRun: { findFirst } } as never,
    { subscribe } as never,
  );
  const current = {
    team: { id: randomUUID() },
    user: { id: randomUUID() },
  } as never;
  return { current, findFirst, service, subscribe };
}

function activeRun() {
  return {
    browserExecutions: [
      {
        runtimeSession: {
          fencingToken: 5n,
          id: randomUUID(),
          leaseToken: randomUUID(),
          profileKey: "run-profile",
          profileMode: "EPHEMERAL",
          protocolMinor: 1,
          runtime: {
            capabilities: [] as string[],
            id: randomUUID(),
            name: "Browser Runtime",
            status: "ONLINE",
          },
          runtimeId: randomUUID(),
          status: "ACTIVE",
          userBrowserProfileId: null,
        },
      },
    ],
    lifecycle: "RUNNING",
  };
}

describe("RunBrowserPreviewService", () => {
  it("reports an active execution session as ready", async () => {
    const run = activeRun();
    const { current, findFirst, service } = fixture(run);
    const runId = randomUUID();

    await expect(service.status(current, runId)).resolves.toMatchObject({
      lifecycle: "RUNNING",
      ready: true,
      runId,
      runtimeSession: {
        id: run.browserExecutions[0]?.runtimeSession.id,
        profileId: null,
        status: "ACTIVE",
      },
      unavailableReason: null,
    });
    expect(
      (await service.status(current, runId)).runtimeSession,
    ).not.toHaveProperty("profileKey");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: runId, teamId: current.team.id },
      }),
    );
  });

  it("subscribes to preview frames without claiming human control", async () => {
    const run = activeRun();
    const { current, service, subscribe } = fixture(run);
    const emit = vi.fn();

    await service.stream(current, randomUUID(), emit);

    expect(subscribe).toHaveBeenCalledWith(
      run.browserExecutions[0]?.runtimeSession,
      emit,
    );
  });

  it("rejects unavailable, closed, or cross-team execution runs", async () => {
    const missing = fixture(null);
    await expect(
      missing.service.status(missing.current, randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundException);

    const closed = activeRun();
    closed.browserExecutions[0]!.runtimeSession.status = "CLOSED";
    const unavailable = fixture(closed);
    await expect(
      unavailable.service.stream(unavailable.current, randomUUID(), vi.fn()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("read-only preview connections", () => {
  it("issues signed preview-only tickets for capable nodes without taking control", async () => {
    const run = activeRun();
    const session = run.browserExecutions[0]!.runtimeSession;
    session.runtime.capabilities = ["direct-preview-v1"];
    session.protocolMinor = 19;
    const keys = generateKeyPairSync("ed25519");
    vi.stubEnv(
      "BROWSER_DIRECT_ENDPOINTS_JSON",
      JSON.stringify({
        [session.runtimeId]: "wss://runtime.example/browser-control",
      }),
    );
    vi.stubEnv(
      "BROWSER_DIRECT_SIGNING_KEY",
      keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    const { current, service, findFirst, subscribe } = fixture(run);
    const runId = randomUUID();
    const result = await service.connection(current, runId);
    expect(result.transport).toBe("direct");
    if (result.transport !== "direct") throw new Error("Expected direct");
    const [body, signature] = result.ticket.split(".") as [string, string];
    expect(
      verify(
        null,
        Buffer.from(body),
        keys.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(body, "base64url").toString())).toMatchObject(
      {
        access: "preview",
        sessionId: session.id,
        userId: current.user.id,
        teamId: current.team.id,
        fencingToken: "5",
      },
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: runId, teamId: current.team.id },
      }),
    );
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("explicitly retains relay for older or unconfigured nodes", async () => {
    const run = activeRun();
    const session = run.browserExecutions[0]!.runtimeSession;
    const { current, service } = fixture(run);
    vi.stubEnv(
      "BROWSER_DIRECT_ENDPOINTS_JSON",
      JSON.stringify({
        [session.runtimeId]: "wss://runtime.example/browser-control",
      }),
    );
    await expect(service.connection(current, randomUUID())).resolves.toEqual({
      transport: "relay",
    });
    session.runtime.capabilities = ["direct-preview-v1"];
    vi.stubEnv("BROWSER_DIRECT_ENDPOINTS_JSON", "{}");
    await expect(service.connection(current, randomUUID())).resolves.toEqual({
      transport: "relay",
    });
  });

  it.each(["completed", "offline", "closed", "missing-session", "cross-team"])(
    "rejects %s access before issuing a ticket",
    async (reason) => {
      const run = activeRun();
      if (reason === "completed") run.lifecycle = "COMPLETED";
      if (reason === "offline")
        run.browserExecutions[0]!.runtimeSession.runtime.status = "OFFLINE";
      if (reason === "closed")
        run.browserExecutions[0]!.runtimeSession.status = "CLOSED";
      if (reason === "missing-session") run.browserExecutions = [];
      const { current, service } = fixture(
        reason === "cross-team" ? null : run,
      );
      await expect(
        service.connection(current, randomUUID()),
      ).rejects.toBeInstanceOf(
        reason === "cross-team" ? NotFoundException : ConflictException,
      );
    },
  );
});
