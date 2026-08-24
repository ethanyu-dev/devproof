import { randomUUID } from "node:crypto";

import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { VerificationBrowserPreviewService } from "./verification-browser-preview.service.js";

function fixture(run: unknown) {
  const findFirst = vi.fn().mockResolvedValue(run);
  const subscribe = vi.fn().mockResolvedValue(vi.fn());
  const service = new VerificationBrowserPreviewService(
    { verificationRun: { findFirst } } as never,
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
    runtimeSession: {
      fencingToken: 5n,
      id: randomUUID(),
      leaseToken: randomUUID(),
      profileKey: "verification-profile",
      profileMode: "EPHEMERAL",
      protocolMinor: 1,
      runtime: {
        id: randomUUID(),
        name: "Browser Runtime",
        status: "ONLINE",
      },
      runtimeId: randomUUID(),
      status: "ACTIVE",
    },
  };
}

describe("VerificationBrowserPreviewService", () => {
  it("reports an active Browser Runtime session as ready", async () => {
    const run = activeRun();
    const { current, findFirst, service } = fixture(run);
    const runId = randomUUID();

    await expect(service.status(current, runId)).resolves.toMatchObject({
      ready: true,
      runId,
      runtimeSession: {
        id: run.runtimeSession.id,
        status: "ACTIVE",
      },
      unavailableReason: null,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: runId, teamId: current.team.id },
      }),
    );
  });

  it("subscribes to a read-only preview without claiming human control", async () => {
    const run = activeRun();
    const { current, service, subscribe } = fixture(run);
    const emit = vi.fn();

    await service.stream(current, randomUUID(), emit);

    expect(subscribe).toHaveBeenCalledWith(run.runtimeSession, emit);
  });

  it("rejects unavailable or cross-team verification runs", async () => {
    const missing = fixture(null);
    await expect(
      missing.service.status(missing.current, randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundException);

    const closed = activeRun();
    closed.runtimeSession.status = "CLOSED";
    const unavailable = fixture(closed);
    await expect(
      unavailable.service.stream(unavailable.current, randomUUID(), vi.fn()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
