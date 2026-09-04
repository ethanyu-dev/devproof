import { describe, expect, it, vi } from "vitest";
import { RuntimeSessionsService } from "./runtime-sessions.service.js";
import { sessionExecutionPermit } from "./session-permit.js";

const current = {
  sessionId: "cookie",
  team: { id: "team-1", name: "Team", slug: "team" },
  user: {
    id: "user-1",
    name: "User",
    email: "user@example.com",
    avatarUrl: null,
  },
};

function fixture() {
  const expiresAt = new Date(Date.now() + 120_000);
  const row = {
    id: "session-1",
    teamId: "team-1",
    status: "ACTIVE",
    controlGeneration: 0,
    fencingToken: 1n,
    leaseToken: "lease-1",
    leaseExpiresAt: expiresAt,
    ownerTaskId: "task-1" as string | null,
    ownerFencingToken: 3n as bigint | null,
    executionPermitExpiresAt: expiresAt,
    humanControllerUserId: null as string | null,
    humanControlExpiresAt: null as Date | null,
    closedAt: null as Date | null,
    closureVerifiedAt: null as Date | null,
    quarantinedAt: null,
    artifacts: [],
    commands: [],
    events: [],
    runtime: {},
  };
  const task = {
    id: "task-1",
    fencingToken: 3n,
    status: "RUNNING",
    leaseExpiresAt: expiresAt,
    run: { lifecycle: "RUNNING", deadlineAt: expiresAt },
  };
  const prisma = {
    runtimeSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    browserExecution: {
      findFirst: vi.fn().mockResolvedValue({ id: "execution-1" }),
    },
    agentRuntimeTask: { findUnique: vi.fn().mockResolvedValue(task) },
    browserRuntimeSession: {
      findFirst: vi.fn().mockImplementation(async () => ({ ...row })),
      updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
        for (const [key, value] of Object.entries(where)) {
          const actual = row[key as keyof typeof row];
          if (key === "leaseExpiresAt") {
            if (row.leaseExpiresAt <= (value as { gt: Date }).gt)
              return { count: 0 };
          } else if (actual !== value) return { count: 0 };
        }
        Object.assign(row, data, {
          controlGeneration:
            row.controlGeneration + (data.controlGeneration?.increment ?? 0),
        });
        return { count: 1 };
      }),
    },
  };
  const commands = {
    execute: vi.fn().mockResolvedValue({ status: "SUCCEEDED" }),
  };
  const service = new RuntimeSessionsService(
    prisma as never,
    {} as never,
    commands as never,
    {} as never,
    { record: vi.fn() } as never,
  );
  const permit = () =>
    sessionExecutionPermit(prisma as never, row as never, new Date());
  return { row, task, prisma, commands, service, permit };
}

describe("Console human control generations", () => {
  it("resumes the same running Agent across repeated takeover/release cycles", async () => {
    const { row, task, service, commands, permit } = fixture();
    const sentPermits: unknown[] = [];
    commands.execute.mockImplementation(async () => {
      sentPermits.push(await permit());
      return { status: "SUCCEEDED" };
    });
    await expect(permit()).resolves.toMatchObject({
      ownerKind: "AGENT",
      controlGeneration: 0,
      ownerFencingToken: "3",
    });
    for (const generation of [1, 3]) {
      await service.takeover(current, row.id, { ttlSeconds: 60 });
      expect(row).toMatchObject({
        status: "HUMAN_CONTROL",
        controlGeneration: generation,
      });
      await service.release(current, row.id);
      await expect(permit()).resolves.toMatchObject({
        ownerKind: "AGENT",
        controlGeneration: generation + 1,
        ownerFencingToken: "3",
      });
    }
    expect(sentPermits).toEqual(
      [1, 1, 3, 3].map((controlGeneration) =>
        expect.objectContaining({
          ownerKind: "HUMAN",
          controlGeneration,
          ownerFencingToken: "3",
        }),
      ),
    );
    expect(task).toMatchObject({ status: "RUNNING", fencingToken: 3n });
  });

  it("fences a delayed takeover permit when a rejected takeover rolls back", async () => {
    const { row, service, commands, permit } = fixture();
    commands.execute.mockResolvedValue({ status: "FAILED" });
    await expect(
      service.takeover(current, row.id, { ttlSeconds: 60 }),
    ).rejects.toThrow("rejected human control");
    expect(row).toMatchObject({
      status: "ACTIVE",
      controlGeneration: 2,
      humanControllerUserId: null,
    });
    await expect(permit()).resolves.toMatchObject({
      ownerKind: "AGENT",
      controlGeneration: 2,
      ownerFencingToken: "3",
    });
  });

  it("gives an unclaimed browser a bounded startup handoff after human release", async () => {
    const { row, service, permit } = fixture();
    row.ownerTaskId = null;
    row.ownerFencingToken = null;
    row.executionPermitExpiresAt = new Date(Date.now() - 1_000);
    await service.takeover(current, row.id, { ttlSeconds: 60 });
    await service.release(current, row.id);
    await expect(permit()).resolves.toMatchObject({
      ownerKind: "STARTUP",
      controlGeneration: 2,
    });
    expect(row.executionPermitExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.executionPermitExpiresAt.getTime()).toBeLessThanOrEqual(
      row.leaseExpiresAt.getTime(),
    );
    expect(row.executionPermitExpiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 120_000,
    );
  });

  it.each(["release", "takeover"])(
    "does not resurrect a closed Session after a late %s response",
    async (operation) => {
      const { row, service, commands } = fixture();
      if (operation === "release")
        await service.takeover(current, row.id, { ttlSeconds: 60 });
      commands.execute.mockImplementation(async () => {
        row.status = "CLOSED";
        row.closedAt = new Date();
        row.closureVerifiedAt = row.closedAt;
        return { status: operation === "release" ? "SUCCEEDED" : "FAILED" };
      });
      await expect(
        operation === "release"
          ? service.release(current, row.id)
          : service.takeover(current, row.id, { ttlSeconds: 60 }),
      ).rejects.toThrow();
      expect(row.status).toBe("CLOSED");
    },
  );
});
