import type { BrowserRuntimeSession } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRecoveryService } from "./session-recovery.service.js";
import {
  initialWriteState,
  refreshRecoveryWriteOutcome,
} from "./session-recovery.state.js";
import {
  hasVerifiedObservationOnlyHistory,
  potentialWriteCommandWhere,
} from "./session-write-audit.js";

function fixture() {
  const session = {
    id: "session",
    runtimeId: "runtime",
    teamId: "team",
    purpose: "EXECUTION",
    protocolMinor: 14,
    protocolMajor: 1,
    ownerTaskId: "task",
    ownerFencingToken: 5n,
    leaseToken: "lease",
    fencingToken: 3n,
    launchIdentityVersion: 1,
    launchIdentity: { version: 1, id: "launch" },
    launchHostInstanceId: "host",
    launchConnectionGeneration: 1n,
    controlGeneration: 0,
    quarantinedAt: new Date(),
    closureVerifiedAt: null,
    closureEvidenceId: null,
    status: "LOST",
  } as BrowserRuntimeSession;
  const recovery = {
    id: "recovery",
    sessionId: session.id,
    version: 1,
    writeOutcomeState: "UNKNOWN",
    closureState: "VERIFIED",
    closureEvidenceId: "evidence",
    closureVerifiedAt: new Date(),
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    browserRuntimeSession: {
      findUnique: vi.fn(async () => ({ ...session })),
      findUniqueOrThrow: vi.fn(async () => ({ ...session })),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(session, data);
        return { count: 1 };
      }),
    },
    browserExecution: {
      findFirst: vi.fn().mockResolvedValue({
        id: "execution",
        runId: "run",
        input: {},
        run: { environmentSnapshot: {} },
      }),
    },
    browserRuntimeCommand: {
      findFirst: vi.fn().mockResolvedValue({ id: "open-command" }),
      count: vi.fn().mockResolvedValue(0),
    },
    agentRuntimeTask: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: "task", fencingToken: 5n, status: "FAILED" }),
    },
    executionResourceLease: { findMany: vi.fn().mockResolvedValue([]) },
    runtimeSessionRecovery: {
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(async () => recovery),
      create: vi.fn(async ({ data }) => ({
        id: "recovery",
        version: 1,
        ...data,
      })),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(recovery, { ...data, version: recovery.version + 1 });
        return { count: 1 };
      }),
    },
    runtimeRecoveryOutbox: { upsert: vi.fn().mockResolvedValue({}) },
  };
  return { session, recovery, tx };
}

afterEach(() => vi.unstubAllEnvs());

describe("audited observation-only recovery", () => {
  it("persists a no-write assessment for a fenced blank launch with only observations", async () => {
    const { tx, session, recovery } = fixture();
    expect(await initialWriteState(tx as never, session)).toBe(
      "NO_WRITE_VERIFIED",
    );
    const result = await refreshRecoveryWriteOutcome(
      tx as never,
      session,
      recovery as never,
    );
    expect(result).toMatchObject({
      writeOutcomeState: "NO_WRITE_VERIFIED",
      version: 2,
      resolvedAt: expect.any(Date),
    });
    expect(tx.runtimeRecoveryOutbox.upsert).toHaveBeenCalledOnce();
    expect(tx.browserRuntimeCommand.findFirst).toHaveBeenCalledWith({
      where: {
        sessionId: "session",
        commandType: "session.open",
        source: "SYSTEM",
        status: "SUCCEEDED",
        leaseToken: "lease",
        fencingToken: 3n,
        payload: { path: ["launchIdentityId"], equals: "launch" },
        result: { path: ["url"], equals: "about:blank" },
      },
      select: { id: true },
    });
  });

  it("stops admission before the first recovery assessment, so a safe task waits for closure instead of becoming UNKNOWN", async () => {
    vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true");
    const { tx, session } = fixture();
    session.quarantinedAt = null;
    session.status = "ACTIVE";
    tx.browserRuntimeCommand.findFirst.mockImplementation(async () => {
      expect(session.status).toBe("LOST");
      expect(session.quarantinedAt).toBeInstanceOf(Date);
      return { id: "open-command" };
    });
    const service = new SessionRecoveryService({
      $transaction: (callback: (value: unknown) => unknown) => callback(tx),
    } as never);
    const recovery = await service.request(session.id, "AGENT_LEASE_LOST", {
      explicitClose: true,
    });
    expect(recovery).toMatchObject({
      closureState: "REQUESTED",
      writeOutcomeState: "NO_WRITE_VERIFIED",
      resolvedAt: null,
    });
  });

  it.each([
    { purpose: "MANUAL" },
    { protocolMinor: 13 },
    { ownerTaskId: null },
    { ownerFencingToken: null },
    { launchIdentityVersion: null },
    { launchIdentity: null },
    { launchIdentity: { version: 1 } },
    { launchHostInstanceId: null },
    { launchConnectionGeneration: null },
    { controlGeneration: 1 },
    { quarantinedAt: null, closureVerifiedAt: null },
  ])(
    "does not infer safety from incomplete or human-controlled history: %j",
    async (change) => {
      const { tx, session } = fixture();
      expect(
        await hasVerifiedObservationOnlyHistory(
          tx as never,
          { ...session, ...change } as BrowserRuntimeSession,
        ),
      ).toBe(false);
      expect(tx.browserRuntimeCommand.count).not.toHaveBeenCalled();
    },
  );

  it("requires a bound execution and a successful launch from the exact epoch", async () => {
    const { tx, session } = fixture();
    tx.browserExecution.findFirst.mockResolvedValueOnce(null);
    expect(await initialWriteState(tx as never, session)).toBe("UNKNOWN");
    tx.browserRuntimeCommand.findFirst.mockResolvedValueOnce(null);
    expect(await initialWriteState(tx as never, session)).toBe("UNKNOWN");
    expect(tx.browserRuntimeCommand.count).not.toHaveBeenCalled();
  });

  it("keeps possible writes UNKNOWN regardless of actor, epoch, dispatch status or error", async () => {
    const { tx, session, recovery } = fixture();
    tx.browserRuntimeCommand.count.mockResolvedValue(1);
    expect(await initialWriteState(tx as never, session)).toBe("UNKNOWN");
    expect(
      await refreshRecoveryWriteOutcome(
        tx as never,
        session,
        recovery as never,
      ),
    ).toBe(recovery);
    expect(tx.runtimeSessionRecovery.updateMany).not.toHaveBeenCalled();
    expect(tx.browserRuntimeCommand.count).toHaveBeenCalledWith({
      where: { sessionId: session.id, ...potentialWriteCommandWhere },
    });
    const where = tx.browserRuntimeCommand.count.mock.calls[0]![0].where;
    for (const key of ["status", "source", "leaseToken", "fencingToken"])
      expect(where).not.toHaveProperty(key);
    const excluded = (where.commandType as { notIn: string[] }).notIn;
    for (const command of [
      "page.navigate",
      "page.click",
      "page.evaluate",
      "tab.new",
      "page.type",
      "page.press",
    ])
      expect(excluded).not.toContain(command);
  });

  it("never replaces a manual resolution or confirms closure from a no-write audit", async () => {
    const { tx, session, recovery } = fixture();
    const resolved = { ...recovery, writeOutcomeState: "RESOLVED" };
    expect(
      await refreshRecoveryWriteOutcome(
        tx as never,
        session,
        resolved as never,
      ),
    ).toBe(resolved);
    expect(tx.browserRuntimeCommand.count).not.toHaveBeenCalled();
    recovery.closureState = "REQUESTED";
    const assessed = await refreshRecoveryWriteOutcome(
      tx as never,
      session,
      recovery as never,
    );
    expect(assessed).toMatchObject({
      writeOutcomeState: "NO_WRITE_VERIFIED",
      closureState: "REQUESTED",
      resolvedAt: null,
    });
  });
});
