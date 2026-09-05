import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "../config/env.js";
import { RuntimeCommandDispatcher } from "./runtime-command-dispatcher.service.js";

beforeEach(() => {
  vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true");
  resetEnvForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});
function fixture(type = "session.open") {
  const context = {
    runtimeId: randomUUID(),
    connectionId: randomUUID(),
    connectionGeneration: 2n,
    negotiatedMinor: 14,
    hostInstanceId: "host-instance-0000001",
    daemonInstanceId: "c7f9b873-b1e0-4b05-94a6-a1d96682305c",
    capabilities: new Set(["closure-evidence-v1"]),
  };
  const runtime = {
    id: context.runtimeId,
    protocolMinor: 14,
    connectionGeneration: 2n,
    enabled: true,
    revokedAt: null,
    hostInstanceId: "host-instance-0000001",
    capabilities: ["closure-evidence-v1"],
  };
  const session = {
    id: randomUUID(),
    runtimeId: runtime.id,
    purpose: "EXECUTION",
    status: "OPENING",
    protocolMinor: 12,
    leaseToken: randomUUID(),
    fencingToken: 7n,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    launchIdentity: null as unknown,
    launchHostInstanceId: null,
    launchConnectionGeneration: null,
    closureVerifiedAt: null,
    quarantinedAt: null,
  };
  const command = {
    id: randomUUID(),
    sessionId: session.id,
    commandType: type,
    leaseToken: session.leaseToken,
    fencingToken: 7n,
    status: "PENDING",
    deadlineAt: new Date(Date.now() + 50_000),
    payload: {} as Record<string, unknown>,
    createdAt: new Date(),
    session,
  };
  const order: string[] = [];
  const prisma = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    browserRuntime: {
      findUnique: vi.fn().mockResolvedValue(runtime),
      findUniqueOrThrow: vi.fn().mockResolvedValue(runtime),
      findFirst: vi.fn().mockResolvedValue(runtime),
    },
    browserRuntimeSession: {
      findUnique: vi.fn().mockResolvedValue(session),
      findUniqueOrThrow: vi.fn().mockResolvedValue(session),
      update: vi.fn(({ data }) => {
        Object.assign(session, data);
        order.push("identity");
        return session;
      }),
      updateMany: vi.fn(),
    },
    browserRuntimeCommand: {
      findUnique: vi.fn().mockResolvedValue(command),
      findUniqueOrThrow: vi.fn().mockResolvedValue(command),
      create: vi.fn(),
      update: vi.fn(({ data }) => {
        Object.assign(command, data);
        order.push("payload");
        return command;
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  prisma.$transaction.mockImplementation((operation) => operation(prisma));
  const hub = {
    send: vi.fn(() => {
      order.push("send");
    }),
  };
  const closure = { acceptRuntimeEvidence: vi.fn().mockResolvedValue(true) };
  const recovery = {
    prepareClose: vi.fn().mockResolvedValue({ requestId: command.id }),
  };
  const dispatcher = new RuntimeCommandDispatcher(
    prisma as never,
    hub as never,
    {} as never,
    undefined,
    undefined,
    closure as never,
    recovery as never,
  );
  Reflect.set(
    dispatcher,
    "waitForCompletion",
    vi.fn().mockResolvedValue(command),
  );
  return {
    dispatcher,
    prisma,
    hub,
    closure,
    recovery,
    context,
    session,
    command,
    order,
  };
}

describe("Command delivery and closure evidence", () => {
  it("registers a stable launch identity and command payload before sending OPEN", async () => {
    const f = fixture();
    const input = {
      sessionId: f.session.id,
      commandId: f.command.id,
      commandType: "session.open" as const,
      source: "SYSTEM" as const,
    };
    await f.dispatcher.execute(input);
    const identity = f.command.payload.launchIdentityId;
    expect(identity).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.session.launchIdentity).toMatchObject({
      id: identity,
      version: 1,
    });
    expect(f.order).toEqual(["identity", "payload", "send"]);
    await f.dispatcher.execute(input);
    expect(f.command.payload.launchIdentityId).toBe(identity);
    expect(f.hub.send).toHaveBeenCalledWith(
      f.context.runtimeId,
      expect.objectContaining({ payload: { launchIdentityId: identity } }),
      2n,
    );
  });
  it("does not send OPEN when identity persistence fails", async () => {
    const f = fixture();
    f.prisma.browserRuntimeSession.update.mockRejectedValue(
      new Error("database unavailable") as never,
    );
    await expect(
      f.dispatcher.execute({
        sessionId: f.session.id,
        commandId: f.command.id,
        commandType: "session.open",
        source: "SYSTEM",
      }),
    ).rejects.toThrow("database unavailable");
    expect(f.hub.send).not.toHaveBeenCalled();
  });
  it("does not reopen a launch on a different host", async () => {
    const f = fixture();
    Object.assign(f.session, {
      launchIdentity: { id: randomUUID() },
      launchHostInstanceId: "old-host",
    });
    await expect(
      f.dispatcher.execute({
        sessionId: f.session.id,
        commandId: f.command.id,
        commandType: "session.open",
        source: "SYSTEM",
      }),
    ).rejects.toThrow("another Runtime host");
    expect(f.hub.send).not.toHaveBeenCalled();
  });
  it("reuses the recovery's durable close command id without inserting another command", async () => {
    const f = fixture("session.close");
    await f.dispatcher.execute({
      sessionId: f.session.id,
      commandType: "session.close",
      source: "SYSTEM",
    });
    expect(f.recovery.prepareClose).toHaveBeenCalledOnce();
    expect(f.prisma.browserRuntimeCommand.create).not.toHaveBeenCalled();
    expect(f.hub.send).toHaveBeenCalledWith(
      f.context.runtimeId,
      expect.objectContaining({ commandId: f.command.id }),
      2n,
    );
  });
  function result(
    f: ReturnType<typeof fixture>,
    output: Record<string, unknown>,
  ) {
    return {
      type: "command.result" as const,
      commandId: f.command.id,
      sessionId: f.session.id,
      leaseToken: f.session.leaseToken,
      fencingToken: "7",
      ok: true,
      artifacts: [],
      result: output,
    };
  }
  it("does not turn a successful bare close ACK into closure proof", async () => {
    const f = fixture("session.close");
    await f.dispatcher.acceptResult(result(f, {}), f.context);
    expect(f.closure.acceptRuntimeEvidence).not.toHaveBeenCalled();
    expect(f.prisma.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
  });
  it("accepts authenticated physical proof after the close command timed out", async () => {
    const f = fixture("session.close");
    f.command.status = "TIMED_OUT";
    const proof = {
      evidenceId: randomUUID(),
      recoveryId: randomUUID(),
      requestId: f.command.id,
      sessionId: f.session.id,
      leaseToken: f.session.leaseToken,
      fencingToken: "7",
      hostInstanceId: "host-instance-0000001",
      daemonInstanceId: "c7f9b873-b1e0-4b05-94a6-a1d96682305c",
      launchIdentityVersion: 1,
      method: "LIVE_SESSION_TERMINATED",
      networkRevoked: true,
      closureCompletedAt: new Date().toISOString(),
    };
    await f.dispatcher.acceptResult(
      result(f, { closureEvidence: proof }),
      f.context,
    );
    expect(f.closure.acceptRuntimeEvidence).toHaveBeenCalledWith(
      f.context,
      proof,
    );
    expect(f.prisma.browserRuntimeCommand.updateMany).not.toHaveBeenCalled();
    f.prisma.browserRuntime.findFirst.mockResolvedValue(null as never);
    f.closure.acceptRuntimeEvidence.mockClear();
    await f.dispatcher.acceptResult(
      result(f, { closureEvidence: proof }),
      f.context,
    );
    expect(f.closure.acceptRuntimeEvidence).not.toHaveBeenCalled();
  });
});
