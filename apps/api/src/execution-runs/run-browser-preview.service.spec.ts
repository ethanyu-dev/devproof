import { randomUUID } from "node:crypto";

import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

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
