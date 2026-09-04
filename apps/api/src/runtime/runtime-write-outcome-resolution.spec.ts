import { describe, expect, it, vi } from "vitest";

import { RuntimeSessionsService } from "./runtime-sessions.service.js";
import { ExecutionRunService } from "../execution-runs/execution-run.service.js";
import { UnifiedRunCleanupWorker } from "../execution-runs/unified-run-cleanup.worker.js";
import {
  releaseCompletedSessionData,
  releaseVerifiedSessionResources,
} from "./session-resource-cleanup.js";

const current = {
  sessionId: "login-session",
  team: { id: "team-1", name: "Team", slug: "team" },
  user: {
    avatarUrl: null,
    email: "operator@example.com",
    id: "operator-1",
    name: "Operator",
  },
};
const note = "Verified the business record and reconciled the previous write.";

function fixture() {
  const session = {
    id: "session-1",
    ownerTaskId: "task-1",
    status: "CLOSED",
    closureVerifiedAt: new Date("2026-09-04T08:00:00Z") as Date | null,
    quarantinedAt: new Date("2026-09-04T07:59:00Z") as Date | null,
    browserExecutions: [{ runId: "run-1", attemptId: "attempt-1" }],
  };
  const owner = {
    id: "task-1",
    status: "FAILED",
    recoveryStatus: "WRITE_OUTCOME_UNKNOWN" as string | null,
    fencingToken: 3n,
    completionId: null,
    result: null,
    run: {
      id: "run-1",
      lifecycle: "COMPLETED",
      concurrencyPolicy: { accessMode: "MUTATING" },
    },
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: "" }]),
    browserRuntimeSession: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(session),
      findUnique: vi.fn().mockResolvedValue(session),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentRuntimeTask: {
      findUnique: vi.fn().mockResolvedValue(owner),
      updateMany: vi.fn().mockImplementation(async ({ data }) => {
        Object.assign(owner, data);
        return { count: 1 };
      }),
      create: vi.fn(),
    },
    executionResourceLease: {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    browserRuntimeSlot: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    browserRuntimeProfileLease: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    runEvent: { create: vi.fn().mockResolvedValue({}) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    runAttempt: { create: vi.fn() },
  };
  const prisma = {
    browserRuntimeSession: { findFirst: vi.fn().mockResolvedValue(session) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const audit = { record: vi.fn() };
  const service = new RuntimeSessionsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    audit as never,
  );
  return { service, prisma, tx, session, owner, audit };
}

describe("manual reconciliation of uncertain browser writes", () => {
  it("requires the session to belong to the current team before starting reconciliation", async () => {
    const { service, prisma, tx } = fixture();
    prisma.browserRuntimeSession.findFirst.mockResolvedValue(null as never);
    await expect(
      service.resolveWriteOutcome(current, "session-1", note),
    ).rejects.toThrow("not found");
    expect(prisma.browserRuntimeSession.findFirst).toHaveBeenCalledWith({
      where: { id: "session-1", teamId: current.team.id },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    { status: "CLOSED", closureVerifiedAt: null },
    { status: "LOST", closureVerifiedAt: null },
    { status: "CLOSING", closureVerifiedAt: new Date() },
  ])(
    "requires positive closure evidence and CLOSED status: $status",
    async (state) => {
      const { service, session, tx } = fixture();
      Object.assign(session, state);
      await expect(
        service.resolveWriteOutcome(current, "session-1", note),
      ).rejects.toThrow("closed");
      expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
      expect(tx.agentRuntimeTask.updateMany).not.toHaveBeenCalled();
      expect(tx.auditEvent.create).not.toHaveBeenCalled();
    },
  );

  it.each(["PENDING", "RUNNING", "WAITING_HUMAN"])(
    "rejects an owner still in %s even when its browser is closed",
    async (status) => {
      const { service, owner, tx } = fixture();
      owner.status = status;
      await expect(
        service.resolveWriteOutcome(current, "session-1", note),
      ).rejects.toThrow("must stop");
      expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
      expect(tx.auditEvent.create).not.toHaveBeenCalled();
    },
  );

  it.each(["QUEUED", "PREPARING", "RUNNING", "WAITING_HUMAN"])(
    "rejects a stopped task while its Run is still %s",
    async (lifecycle) => {
      const { service, owner, tx } = fixture();
      owner.run.lifecycle = lifecycle;
      await expect(
        service.resolveWriteOutcome(current, "session-1", note),
      ).rejects.toThrow("must stop");
      expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    },
  );

  it.each([null, "PENDING", "CLOSING", "RETRY_SCHEDULED", "EXHAUSTED"])(
    "does not race an unsettled or unrelated recovery state %s",
    async (recoveryStatus) => {
      const { service, owner, tx } = fixture();
      owner.recoveryStatus = recoveryStatus;
      await expect(
        service.resolveWriteOutcome(current, "session-1", note),
      ).rejects.toThrow("lease recovery");
      expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
      expect(tx.agentRuntimeTask.updateMany).not.toHaveBeenCalled();
    },
  );

  it("does not release data when a concurrent owner transition wins the CAS", async () => {
    const { service, tx } = fixture();
    tx.agentRuntimeTask.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.resolveWriteOutcome(current, "session-1", note),
    ).rejects.toThrow("changed");
    expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });

  it("releases only this session's quarantine with a durable audit and no automatic replay", async () => {
    const { service, tx, audit, owner } = fixture();
    await expect(
      service.resolveWriteOutcome(current, "session-1", note),
    ).resolves.toEqual({ released: 2 });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.agentRuntimeTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-1",
        status: "FAILED",
        recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
        fencingToken: 3n,
      },
      data: { recoveryStatus: "RESOLVED", recoveryNextAttemptAt: null },
    });
    expect(owner.recoveryStatus).toBe("RESOLVED");
    expect(tx.executionResourceLease.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: "session-1", quarantined: true },
    });
    expect(tx.browserRuntimeSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: { quarantinedAt: null },
    });
    expect(tx.runEvent.create).toHaveBeenCalledWith({
      data: {
        teamId: current.team.id,
        runId: "run-1",
        attemptId: "attempt-1",
        actor: "HUMAN",
        kind: "runtime.write_outcome.reconciled",
        payload: { note, resolvedByUserId: current.user.id },
      },
    });
    expect(tx.auditEvent.create).toHaveBeenCalledWith({
      data: {
        action: "runtime.write_outcome.reconciled",
        actorUserId: current.user.id,
        entityId: "session-1",
        entityType: "browser_runtime_session",
        metadata: { note, released: 2 },
        teamId: current.team.id,
      },
    });
    expect(audit.record).not.toHaveBeenCalled();
    expect(tx.runAttempt.create).not.toHaveBeenCalled();
    expect(tx.agentRuntimeTask.create).not.toHaveBeenCalled();
  });

  it("aborts the release transaction if its durable audit cannot be recorded", async () => {
    const { service, tx, prisma, audit } = fixture();
    tx.auditEvent.create.mockRejectedValue(new Error("audit storage failed"));
    await expect(
      service.resolveWriteOutcome(current, "session-1", note),
    ).rejects.toThrow("audit storage failed");
    await expect(prisma.$transaction.mock.results[0]!.value).rejects.toThrow(
      "audit storage failed",
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(["CANCELLED", "TIMED_OUT"])(
    "preserves a manual resolution when duplicate closure arrives for a %s task",
    async (status) => {
      const { service, tx, owner } = fixture();
      owner.status = status;
      owner.run.lifecycle = status;
      await service.resolveWriteOutcome(current, "session-1", note);
      tx.agentRuntimeTask.updateMany.mockClear();
      tx.executionResourceLease.updateMany.mockClear();

      await releaseVerifiedSessionResources(tx as never, "session-1");
      expect(owner.recoveryStatus).toBe("RESOLVED");
      expect(tx.agentRuntimeTask.updateMany).not.toHaveBeenCalled();
      expect(tx.executionResourceLease.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    { transition: "cancel", taskStatus: "CANCELLED", lifecycle: "CANCELLED" },
    {
      transition: "hitl-cancel",
      taskStatus: "CANCELLED",
      lifecycle: "CANCELLED",
    },
    {
      transition: "hitl-inconclusive",
      taskStatus: "FAILED",
      lifecycle: "COMPLETED",
    },
    {
      transition: "run-timeout",
      taskStatus: "TIMED_OUT",
      lifecycle: "TIMED_OUT",
    },
  ])(
    "keeps a WAITING_HUMAN write isolated through $transition, closure and reconciliation",
    async ({ transition, taskStatus, lifecycle }) => {
      const { service, tx, session, owner, prisma } = fixture();
      Object.assign(session, {
        status: "ACTIVE",
        closureVerifiedAt: null,
        quarantinedAt: null,
        purpose: "EXECUTION",
        protocolMinor: 13,
      });
      Object.assign(owner, {
        completionId: "human-wait-completion",
        result: { kind: "WAITING_HUMAN" },
        status: "WAITING_HUMAN",
        recoveryStatus: null,
      });
      Object.assign(owner.run, {
        lifecycle: "WAITING_HUMAN",
        startedAt: new Date(),
        executionPolicy: {
          hitl: {
            enabled: true,
            notificationChannels: [],
            onTimeout: transition === "hitl-cancel" ? "CANCEL" : "INCONCLUSIVE",
            timeoutSeconds: 3600,
          },
        },
      });
      let lease: { quarantined: boolean } | null = { quarantined: false };
      tx.executionResourceLease.count.mockImplementation(async () =>
        lease?.quarantined ? 1 : 0,
      );
      tx.executionResourceLease.updateMany.mockImplementation(async () => {
        if (!lease) return { count: 0 };
        lease.quarantined = true;
        return { count: 1 };
      });
      tx.executionResourceLease.deleteMany.mockImplementation(
        async ({ where }) => {
          if (
            !lease ||
            (where.quarantined !== undefined &&
              where.quarantined !== lease.quarantined)
          )
            return { count: 0 };
          lease = null;
          return { count: 1 };
        },
      );
      tx.browserRuntimeSession.updateMany.mockImplementation(
        async ({ data }) => {
          Object.assign(session, data);
          return { count: 1 };
        },
      );
      Object.assign(tx, {
        browserRuntimeCommand: { count: vi.fn().mockResolvedValue(1) },
        executionRun: {
          findFirst: vi.fn().mockResolvedValue(owner.run),
          update: vi.fn(async ({ data }) => Object.assign(owner.run, data)),
          updateMany: vi.fn(async ({ data }) => {
            Object.assign(owner.run, data);
            return { count: 1 };
          }),
        },
        runAttempt: { updateMany: vi.fn() },
        humanIntervention: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      });

      await releaseCompletedSessionData(tx as never, owner.id);
      expect(lease).toEqual({ quarantined: false });
      if (transition === "cancel") {
        const runs = new ExecutionRunService(prisma as never, {} as never);
        vi.spyOn(runs, "detail").mockResolvedValue({} as never);
        await runs.cancel(
          { ...current, credential: { id: "console-credential" } } as never,
          "run-1",
        );
      } else {
        Object.assign(prisma, {
          humanIntervention: {
            findMany: vi.fn().mockResolvedValue(
              transition.startsWith("hitl-")
                ? [
                    {
                      id: "intervention-1",
                      run: owner.run,
                      runId: "run-1",
                      taskId: "task-1",
                      attemptId: "attempt-1",
                      teamId: current.team.id,
                      expiresAt: new Date(Date.now() - 1000),
                    },
                  ]
                : [],
            ),
          },
          executionRun: {
            findMany: vi
              .fn()
              .mockResolvedValue(
                transition === "run-timeout" ? [owner.run] : [],
              ),
          },
          browserExecution: {
            findMany: vi.fn().mockResolvedValue([]),
          },
        });
        await new UnifiedRunCleanupWorker(prisma as never, {} as never).tick();
      }

      expect(owner.status).toBe(taskStatus);
      expect(owner.run.lifecycle).toBe(lifecycle);
      expect(owner.completionId).toBe("human-wait-completion");
      expect(owner.result).toEqual({ kind: "WAITING_HUMAN" });
      Object.assign(session, {
        status: "CLOSED",
        closureVerifiedAt: new Date(),
      });
      await releaseVerifiedSessionResources(tx as never, session.id);
      expect(lease).toEqual({ quarantined: true });
      expect(owner.recoveryStatus).toBe("WRITE_OUTCOME_UNKNOWN");
      expect(session.quarantinedAt).toBeInstanceOf(Date);
      expect(tx.browserRuntimeSlot.deleteMany).toHaveBeenCalled();

      await expect(
        service.resolveWriteOutcome(current, session.id, note),
      ).resolves.toEqual({ released: 1 });
      expect(lease).toBeNull();
      expect(owner.recoveryStatus).toBe("RESOLVED");
      expect(session.quarantinedAt).toBeNull();
      await releaseVerifiedSessionResources(tx as never, session.id);
      expect(lease).toBeNull();
      expect(owner.recoveryStatus).toBe("RESOLVED");
      expect(session.quarantinedAt).toBeNull();
    },
  );
});
