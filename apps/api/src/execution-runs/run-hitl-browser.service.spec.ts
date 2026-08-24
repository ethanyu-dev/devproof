import { describe, expect, it, vi } from "vitest";

import { RunHitlBrowserService } from "./run-hitl-browser.service.js";

const runId = "285146a8-5230-4b02-832a-5eef19e8dc8a";
const interventionId = "d63bd843-b89d-48ea-90c9-caad5b51d526";
const sessionId = "a4350bbe-0ddf-4bfa-9773-a32a26d64cb9";
const userId = "188ea17e-cac6-42a5-ab62-535ee4b6112d";

const current = {
  team: {
    id: "6f090d88-8987-487f-8338-1a734beab6a6",
    name: "DevProof Team",
  },
  user: { email: "user@example.com", id: userId, name: "User" },
} as never;

describe("RunHitlBrowserService", () => {
  it("reports the preserved Run v2 browser session as ready", async () => {
    const { prisma, service } = setup();

    const status = await service.status(current, runId, interventionId);

    expect(status).toMatchObject({
      interventionId,
      ready: true,
      runId,
      runtimeSession: {
        id: sessionId,
        profileId: "4c37754e-66ce-43c9-8c93-99abc0f0e1ce",
        status: "ACTIVE",
      },
    });
    expect(prisma.humanIntervention.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: interventionId, runId }),
      }),
    );
  });

  it("takes over the same session and persists an intervention control lease", async () => {
    const { prisma, service, sessions, tx } = setup();

    const lease = await service.claim(current, runId, interventionId);

    expect(sessions.takeover).toHaveBeenCalledWith(current, sessionId, {
      ttlSeconds: 900,
    });
    expect(tx.browserHumanControlLease.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          controllerUserId: userId,
          interventionId,
          sessionId,
        }),
      }),
    );
    expect(tx.browserExecution.update).toHaveBeenCalledWith({
      data: { status: "HUMAN_CONTROL" },
      where: { id: "browser-execution-1" },
    });
    expect(lease.id).toBe("control-1");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

function setup() {
  const expiresAt = new Date(Date.now() + 60_000);
  const context = {
    attempt: {
      browserExecution: {
        id: "browser-execution-1",
        runtimeSession: {
          humanControllerUserId: null,
          id: sessionId,
          profileKey: "execution-profile",
          profileMode: "PERSISTENT",
          protocolMinor: 1,
          status: "ACTIVE",
          userBrowserProfileId: "4c37754e-66ce-43c9-8c93-99abc0f0e1ce",
        },
      },
    },
    attemptId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
    expiresAt,
    id: interventionId,
    prompt: "Complete MFA.",
    run: {
      deadlineAt: new Date(Date.now() + 120_000),
      lifecycle: "WAITING_HUMAN",
    },
    taskId: "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0",
    runId,
    status: "PENDING",
    teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
  };
  const tx = {
    browserExecution: { update: vi.fn() },
    browserHumanControlLease: {
      create: vi.fn().mockResolvedValue({ expiresAt, id: "control-1" }),
    },
    runEvent: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn((callback) => callback(tx)),
    browserHumanControlLease: {
      deleteMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    humanIntervention: {
      findFirst: vi.fn().mockResolvedValue(context),
    },
  };
  const sessions = {
    release: vi.fn(),
    takeover: vi.fn(),
  };
  const service = new RunHitlBrowserService(
    prisma as never,
    sessions as never,
    {} as never,
    {} as never,
  );
  return { prisma, service, sessions, tx };
}
