import { describe, expect, it, vi } from "vitest";
import { RuntimeLeaseSweeper } from "./runtime-lease-sweeper.service.js";
import { sessionExecutionPermit } from "./session-permit.js";

function fixture() {
  const now = Date.now();
  const rows = ["session-1", "session-2"].map((id) => ({
    id,
    status: "HUMAN_CONTROL",
    controlGeneration: 1,
    leaseToken: "lease",
    fencingToken: 1n,
    leaseExpiresAt: new Date(now + 60_000),
    executionPermitExpiresAt: new Date(now - 1),
    humanControlExpiresAt: new Date(now - 1),
    humanControllerUserId: "user-1",
    closureVerifiedAt: null,
    closedAt: null,
    quarantinedAt: null,
  }));
  const writes = new Set<string>();
  const updateMany = vi.fn().mockImplementation(async ({ where, data }) => {
    const row = rows.find((item) => item.id === where.id)!;
    const values = row as unknown as Record<string, unknown>;
    for (const [key, expected] of Object.entries(where)) {
      const actual = values[key];
      if (expected && typeof expected === "object") {
        const condition = expected as { lte?: Date; not?: unknown };
        if (
          condition.lte &&
          (!(actual instanceof Date) || actual > condition.lte)
        )
          return { count: 0 };
        if ("not" in condition && actual === condition.not) return { count: 0 };
      } else if (actual !== expected) return { count: 0 };
    }
    const { controlGeneration, ...other } = data;
    Object.assign(row, other);
    if (controlGeneration) row.controlGeneration += controlGeneration.increment;
    return { count: 1 };
  });
  const prisma = {
    browserRuntimeSession: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockImplementation(async () =>
          rows.map(({ id, controlGeneration }) => ({ id, controlGeneration })),
        ),
      updateMany,
    },
    executionResourceLease: {
      updateMany: vi.fn().mockImplementation(async ({ where }) => {
        writes.add(where.sessionId);
        return { count: 1 };
      }),
      deleteMany: vi.fn(),
    },
    browserRuntimeSlot: { deleteMany: vi.fn() },
    browserRuntimeProfileLease: { deleteMany: vi.fn() },
    browserRuntimeCommand: { findMany: vi.fn().mockResolvedValue([]) },
    userBrowserProfile: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
  );
  const commands = {
    execute: vi
      .fn()
      .mockRejectedValue(new Error("Runtime execution permission expired")),
    cancel: vi.fn(),
  };
  return {
    rows,
    writes,
    prisma,
    commands,
    sweeper: new RuntimeLeaseSweeper(prisma as never, commands as never),
  };
}

describe("expired Console human control", () => {
  it("quarantines all expired control permits for reconciliation without attempting release or freeing writes", async () => {
    const { rows, writes, prisma, commands, sweeper } = fixture();
    // This is the production permit rule that made the former release command fail.
    for (const row of rows)
      await expect(
        sessionExecutionPermit(prisma as never, row as never, new Date()),
      ).resolves.toBeNull();
    await expect(sweeper.sweep()).resolves.toBeUndefined();
    expect(commands.execute).not.toHaveBeenCalled();
    expect(rows).toEqual(
      rows.map((row) =>
        expect.objectContaining({
          id: row.id,
          status: "LOST",
          controlGeneration: 2,
          humanControllerUserId: null,
          humanControlExpiresAt: null,
          closureVerifiedAt: null,
          quarantinedAt: expect.any(Date),
          lastError: expect.objectContaining({ code: "HUMAN_CONTROL_EXPIRED" }),
        }),
      ),
    );
    expect([...writes]).toEqual(["session-1", "session-2"]);
    expect(prisma.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    expect(prisma.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
    expect(prisma.browserRuntimeProfileLease.deleteMany).not.toHaveBeenCalled();
    for (const row of rows)
      await expect(
        sessionExecutionPermit(prisma as never, row as never, new Date()),
      ).resolves.toBeNull();
  });

  it("does not quarantine a newer human controller that won the generation race", async () => {
    const { rows, writes, prisma, sweeper } = fixture();
    prisma.browserRuntimeSession.findMany
      .mockReset()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        const candidates = rows.map(({ id, controlGeneration }) => ({
          id,
          controlGeneration,
        }));
        rows[0]!.controlGeneration = 3;
        rows[0]!.humanControlExpiresAt = new Date(Date.now() + 60_000);
        return candidates;
      });
    await sweeper.sweep();
    expect(rows[0]).toMatchObject({
      status: "HUMAN_CONTROL",
      controlGeneration: 3,
      quarantinedAt: null,
    });
    expect(rows[1]).toMatchObject({ status: "LOST", controlGeneration: 2 });
    expect([...writes]).toEqual(["session-2"]);
  });
});
