import { describe, expect, it, vi } from "vitest";
import { SessionRecoveryService } from "./session-recovery.service.js";
import { recoveryListWhere } from "./session-recovery-query.js";

const current = { team: { id: "team-a" } } as never;
const now = new Date("2026-09-07T00:00:00Z");
function setup() {
  const rows = Array.from({ length: 11 }, (_, index) => ({
    id: `recovery-${index}`,
    sessionId: `session-${index}`,
    runtimeId: "runtime-a",
    sourceRunId: "run-a",
    closureState: "VERIFIED",
    writeOutcomeState: "UNKNOWN",
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
  const db = {
    runtimeSessionRecovery: {
      findFirst: vi.fn().mockResolvedValue({ id: "cursor" }),
      findMany: vi.fn().mockResolvedValue(rows),
      count: vi.fn().mockResolvedValue(61),
    },
    browserRuntime: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "runtime-a", name: "测试执行节点" }]),
    },
    executionRun: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "run-a", goal: "验证订单提交" }]),
    },
  };
  return { db, service: new SessionRecoveryService(db as never) };
}

describe("recovery list and summary", () => {
  it("counts beyond the visible page and includes names scoped to the current team", async () => {
    const { db, service } = setup();
    const result = await service.list(current, {
      view: "pending",
      limit: 10,
      runtimeId: "runtime-a",
      state: "VERIFIED",
      writeState: "UNKNOWN",
    });
    expect(result.total).toBe(61);
    expect(result.items).toHaveLength(10);
    expect(result.nextCursor).toBe("recovery-9");
    expect(result.items[0]).toMatchObject({
      runtimeName: "测试执行节点",
      sourceRunGoal: "验证订单提交",
    });
    const where = db.runtimeSessionRecovery.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      teamId: "team-a",
      runtimeId: "runtime-a",
      closureState: "VERIFIED",
      writeOutcomeState: "UNKNOWN",
      resolvedAt: null,
    });
    expect(db.runtimeSessionRecovery.count).toHaveBeenCalledWith({ where });
    expect(db.executionRun.findMany.mock.calls[0]![0].where.teamId).toBe(
      "team-a",
    );
    expect(db.browserRuntime.findMany.mock.calls[0]![0].where.teamId).toBe(
      "team-a",
    );
  });
  it("rejects a cursor from another team before reading records or labels", async () => {
    const { db, service } = setup();
    db.runtimeSessionRecovery.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.list(current, { cursor: "foreign-cursor" }),
    ).rejects.toThrow("Recovery cursor was not found");
    expect(db.runtimeSessionRecovery.findMany).not.toHaveBeenCalled();
    expect(db.executionRun.findMany).not.toHaveBeenCalled();
  });
  it("keeps historical records accessible and excludes healthy observed sessions from pending counts", async () => {
    const { db, service } = setup();
    db.runtimeSessionRecovery.count
      .mockResolvedValueOnce(61)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4);
    expect(await service.summary(current)).toEqual({
      pending: 61,
      needsOperator: 2,
      awaitingWrite: 4,
    });
    expect(db.runtimeSessionRecovery.count.mock.calls[0]![0].where).toEqual(
      recoveryListWhere("team-a", { view: "pending" }),
    );
    expect(
      recoveryListWhere("team-a", { view: "pending", state: "OBSERVED" }),
    ).toMatchObject({
      closureState: "OBSERVED",
      AND: [{ closureState: { not: "OBSERVED" } }],
    });
    expect(recoveryListWhere("team-a", { view: "all" })).toEqual({
      teamId: "team-a",
    });
    expect(
      db.runtimeSessionRecovery.count.mock.calls[2]![0].where.AND,
    ).toContainEqual({
      closureState: "VERIFIED",
      writeOutcomeState: { in: ["UNKNOWN", "UNASSESSED"] },
    });
  });
});
