import {
  RUNTIME_PROTOCOL,
  runtimeClientMessageSchema,
} from "@devproof/runtime-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvForTests } from "../config/env.js";

import { RuntimeGatewayService } from "./runtime-gateway.service.js";
import type { AuthenticatedRuntimeContext } from "./session-closure.types.js";
const context: AuthenticatedRuntimeContext = {
  runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
  connectionId: "connection-1",
  connectionGeneration: 2n,
  negotiatedMinor: 14,
  capabilities: new Set(["closure-evidence-v1"]),
};
beforeEach(() => {
  vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true");
  resetEnvForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

function fixture() {
  const prisma = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ id: context.runtimeId }]),
    browserRuntime: {
      findFirst: vi.fn().mockResolvedValue({
        enabled: true,
        id: "6f090d88-8987-487f-8338-1a734beab6a6",
        networkAllowlist: ["test-console.paigod.work"],
        revokedAt: null,
      }),
      update: vi.fn().mockResolvedValue({ connectionGeneration: 2n }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    browserRuntimeSession: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    agentRuntimeTask: { findUnique: vi.fn().mockResolvedValue(null) },
    browserExecution: { findFirst: vi.fn().mockResolvedValue(null) },
    executionResourceLease: {
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    browserRuntimeProfileLease: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    browserRuntimeSlot: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  prisma.$transaction.mockImplementation(
    async (
      operation: Array<Promise<unknown>> | ((tx: typeof prisma) => unknown),
    ) =>
      Array.isArray(operation) ? Promise.all(operation) : operation(prisma),
  );
  const redis = {
    disconnectOlderGateways: vi.fn().mockResolvedValue(undefined),
    instanceId: "gateway-instance-1",
    markRuntimeOnline: vi.fn().mockResolvedValue(undefined),
  };
  const hub = { register: vi.fn() };
  const recovery = {
    request: vi.fn().mockResolvedValue({}),
    wakeRuntime: vi.fn(),
  };
  const service = new RuntimeGatewayService(
    prisma as never,
    redis as never,
    hub as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    recovery as never,
  );
  const socket = { send: vi.fn(), close: vi.fn() };
  const handleHello = Reflect.get(service, "handleHello") as (
    socket: typeof socket,
    hello: ReturnType<typeof runtimeClientMessageSchema.parse>,
  ) => Promise<AuthenticatedRuntimeContext | undefined>;
  const handleHeartbeat = Reflect.get(service, "handleHeartbeat") as (
    socket: typeof socket,
    context: AuthenticatedRuntimeContext,
    heartbeat: ReturnType<typeof runtimeClientMessageSchema.parse>,
  ) => Promise<void>;
  return {
    handleHeartbeat,
    handleHello,
    hub,
    prisma,
    recovery,
    service,
    socket,
  };
}

function hello(
  version?: string,
  protocolMinor: number = RUNTIME_PROTOCOL.minor,
) {
  return runtimeClientMessageSchema.parse({
    activeSessions: [],
    instanceNonce: "instance-nonce-123456",
    protocol: { ...RUNTIME_PROTOCOL, minor: protocolMinor },
    runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
    runtimeToken: "a".repeat(32),
    sentAt: new Date().toISOString(),
    type: "runtime.hello",
    ...(version ? { version } : {}),
  });
}

describe("RuntimeGatewayService Runtime version reporting", () => {
  it("refreshes the persisted package version when a Runtime connects", async () => {
    const { handleHello, prisma, service, socket } = fixture();

    await handleHello.call(service, socket, hello("0.2.2"));

    expect(prisma.browserRuntime.update).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: "0.2.2" }),
      where: { id: "6f090d88-8987-487f-8338-1a734beab6a6" },
    });
  });

  it("keeps the persisted version for legacy Runtime clients", async () => {
    const { handleHello, prisma, service, socket } = fixture();

    await handleHello.call(service, socket, hello());

    const update = prisma.browserRuntime.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(update.data).not.toHaveProperty("version");
  });

  it("delivers the persisted network allowlist during the handshake", async () => {
    const { handleHello, service, socket } = fixture();

    await handleHello.call(service, socket, hello("0.2.4"));

    const accepted = JSON.parse(String(socket.send.mock.calls[0]?.[0]));
    expect(accepted).toMatchObject({
      networkAllowlist: ["test-console.paigod.work"],
      protocol: { minor: RUNTIME_PROTOCOL.minor },
      type: "runtime.hello.accepted",
    });
  });

  it("negotiates protocol v1.10 with Browser Runtime 0.2.14", async () => {
    const { handleHello, prisma, service, socket } = fixture();

    await handleHello.call(service, socket, hello("0.2.14", 10));

    expect(prisma.browserRuntime.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        protocolMinor: 10,
        version: "0.2.14",
      }),
      where: { id: "6f090d88-8987-487f-8338-1a734beab6a6" },
    });
    const accepted = JSON.parse(String(socket.send.mock.calls[0]?.[0]));
    expect(accepted).toMatchObject({
      protocol: { major: 1, minor: 10 },
      type: "runtime.hello.accepted",
    });
  });

  it("negotiates protocol v1.12 for structured Runtime diagnostics", async () => {
    const { handleHello, prisma, service, socket } = fixture();

    await handleHello.call(service, socket, hello("0.2.16", 12));

    expect(prisma.browserRuntime.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        protocolMinor: 12,
        version: "0.2.16",
      }),
      where: { id: "6f090d88-8987-487f-8338-1a734beab6a6" },
    });
    const accepted = JSON.parse(String(socket.send.mock.calls[0]?.[0]));
    expect(accepted).toMatchObject({
      protocol: { major: 1, minor: 12 },
      type: "runtime.hello.accepted",
    });
  });
});

describe("RuntimeGatewayService capacity ownership", () => {
  it("does not overwrite the console capacity from Runtime heartbeats", async () => {
    const { handleHeartbeat, prisma, service, socket } = fixture();
    const heartbeat = runtimeClientMessageSchema.parse({
      activeSessions: [],
      maxConcurrency: 8,
      sentAt: new Date().toISOString(),
      type: "runtime.heartbeat",
    });

    await handleHeartbeat.call(service, socket, context, heartbeat);

    const update = prisma.browserRuntime.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(update.data).not.toHaveProperty("maxConcurrency");
    expect(update.data).toMatchObject({ status: "ONLINE" });
  });
});

describe("RuntimeGatewayService terminal session ownership", () => {
  it("excludes sessions with a close timestamp from reconnect reconciliation", async () => {
    const { handleHello, prisma, service, socket } = fixture();

    await handleHello.call(service, socket, hello("0.2.15"));

    expect(prisma.browserRuntimeSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          closureVerifiedAt: null,
          status: { in: expect.arrayContaining(["LOST"]) },
        }),
      }),
    );
  });

  it("asks the Runtime to close a local session that cannot be renewed", async () => {
    const { handleHeartbeat, prisma, service, socket } = fixture();
    const sessionId = "cf5a946c-f906-4df4-9296-1d6482ddaf75";
    const heartbeat = runtimeClientMessageSchema.parse({
      activeSessions: [
        {
          fencingToken: "7",
          leaseToken: "b15a5cc9-1fa7-4960-ab84-763db94e24ab",
          sessionId,
          state: "OPEN",
        },
      ],
      maxConcurrency: 4,
      sentAt: new Date().toISOString(),
      type: "runtime.heartbeat",
    });

    await handleHeartbeat.call(service, socket, context, heartbeat);

    expect(prisma.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({
      closeSessions: [sessionId],
      type: "runtime.heartbeat.ack",
    });
  });

  it("does not reactivate a closing session during reconnect", async () => {
    const { prisma, service } = fixture();
    const sessionId = "cf5a946c-f906-4df4-9296-1d6482ddaf75";
    prisma.browserRuntimeSession.findUnique.mockResolvedValue({
      runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
      fencingToken: 7n,
      id: sessionId,
      leaseToken: "b15a5cc9-1fa7-4960-ab84-763db94e24ab",
      profileKey: "profile-key",
      profileMode: "PERSISTENT",
      status: "CLOSING",
      userBrowserProfile: null,
      verificationRuns: [],
    });
    prisma.browserRuntimeSession.updateMany.mockResolvedValue({ count: 1 });
    const reconcile = Reflect.get(service, "reconcile") as (
      context: AuthenticatedRuntimeContext,
      sessions: Array<Record<string, unknown>>,
      protocolMinor: number,
    ) => Promise<Array<Record<string, unknown>>>;

    const actions = await reconcile.call(
      service,
      "6f090d88-8987-487f-8338-1a734beab6a6",
      [
        {
          fencingToken: "7",
          leaseToken: "b15a5cc9-1fa7-4960-ab84-763db94e24ab",
          profileKey: "profile-key",
          profileMode: "PERSISTENT",
          sessionId,
          state: "OPEN",
        },
      ],
      10,
    );

    expect(actions).toEqual([
      expect.objectContaining({ action: "CLOSE_LOCAL", sessionId }),
    ]);
    expect(prisma.browserRuntimeSession.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACTIVE" }),
      }),
    );
  });

  it("preserves CLOSING while asking the Runtime to force-close the session", async () => {
    const { handleHeartbeat, prisma, service, socket } = fixture();
    const sessionId = "cf5a946c-f906-4df4-9296-1d6482ddaf75";
    prisma.browserRuntimeSession.findUnique.mockResolvedValue({
      id: sessionId,
      runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
      fencingToken: 7n,
      leaseToken: "b15a5cc9-1fa7-4960-ab84-763db94e24ab",
      status: "CLOSING",
    });
    const heartbeat = runtimeClientMessageSchema.parse({
      activeSessions: [
        {
          fencingToken: "7",
          leaseToken: "b15a5cc9-1fa7-4960-ab84-763db94e24ab",
          sessionId,
          state: "OPEN",
        },
      ],
      maxConcurrency: 4,
      sentAt: new Date().toISOString(),
      type: "runtime.heartbeat",
    });

    await handleHeartbeat.call(service, socket, context, heartbeat);

    expect(prisma.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({
      closeSessions: [sessionId],
    });
  });

  it("requests proof without releasing resources when a session disappears from inventory", async () => {
    const { handleHeartbeat, prisma, recovery, service, socket } = fixture();
    const sessionId = "cf5a946c-f906-4df4-9296-1d6482ddaf75";
    const updatedAt = new Date("2026-08-28T01:00:00.000Z");
    prisma.browserRuntimeSession.findMany.mockResolvedValue([
      {
        id: sessionId,
        updatedAt,
        fencingToken: 7n,
        leaseToken: "b15a5cc9-1fa7-4960-ab84-763db94e24ab",
      },
    ]);
    prisma.browserRuntimeSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.browserRuntimeSession.findUnique.mockResolvedValue({
      status: "CLOSED",
      closureVerifiedAt: new Date(),
      ownerTaskId: null,
    });
    const heartbeat = runtimeClientMessageSchema.parse({
      activeSessions: [],
      maxConcurrency: 4,
      sentAt: new Date().toISOString(),
      type: "runtime.heartbeat",
    });

    await handleHeartbeat.call(service, socket, context, heartbeat);

    expect(recovery.request).toHaveBeenCalledWith(
      sessionId,
      "RUNTIME_INVENTORY_MISSING",
    );
    expect(prisma.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
    expect(prisma.browserRuntimeProfileLease.deleteMany).not.toHaveBeenCalled();
  });
});

describe("RuntimeGatewayService user Profile protocol floor", () => {
  it("quarantines incompatible user Profiles without freeing unverified browser resources", async () => {
    const { prisma, service } = fixture();
    const updateProfile = vi.fn().mockResolvedValue({ count: 1 });
    Object.assign(prisma, {
      userBrowserProfile: { updateMany: updateProfile },
    });
    prisma.browserRuntimeSession.findMany.mockResolvedValue([
      { id: "session-1", userBrowserProfileId: "profile-1" },
    ]);
    prisma.browserRuntimeSession.updateMany.mockResolvedValue({ count: 1 });
    const reconcile = Reflect.get(service, "reconcile") as (
      ...args: unknown[]
    ) => Promise<unknown>;
    await expect(reconcile.call(service, "runtime-1", [], 7)).resolves.toEqual(
      [],
    );
    expect(prisma.browserRuntimeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "LOST",
          lastError: expect.objectContaining({
            code: "USER_PROFILE_PROTOCOL_INCOMPATIBLE",
          }),
        }),
      }),
    );
    expect(updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "MIGRATION_REQUIRED" }),
      }),
    );
    expect(prisma.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
  });
});

function activeSession(overrides: Record<string, unknown> = {}) {
  const lease = {
    leaseToken: "b15a5cc9-1fa7-4960-ab84-763db94e24ab",
    fencingToken: 7n,
  };
  return {
    ...lease,
    id: "cf5a946c-f906-4df4-9296-1d6482ddaf75",
    runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
    status: "ACTIVE",
    profileMode: "EPHEMERAL",
    protocolMinor: 13,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    closedAt: null,
    quarantinedAt: null,
    slot: lease,
    ownerTaskId: null,
    ...overrides,
  };
}

function heartbeatFor(session: ReturnType<typeof activeSession>) {
  return runtimeClientMessageSchema.parse({
    type: "runtime.heartbeat",
    maxConcurrency: 4,
    sentAt: new Date().toISOString(),
    activeSessions: [
      {
        sessionId: session.id,
        leaseToken: session.leaseToken,
        fencingToken: session.fencingToken.toString(),
        state: "OPEN",
      },
    ],
  });
}

describe("Runtime Gateway executor permission", () => {
  it("never resurrects LOST ownership even when its node is online", async () => {
    const { prisma, handleHeartbeat, service, socket } = fixture();
    const session = activeSession({
      status: "LOST",
      leaseExpiresAt: new Date(Date.now() - 1),
      slot: null,
    });
    prisma.browserRuntimeSession.findUnique.mockResolvedValue(session);
    prisma.browserRuntimeSession.updateMany.mockResolvedValue({ count: 1 });
    await handleHeartbeat.call(service, socket, context, heartbeatFor(session));
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({
      closeSessions: [session.id],
      sessionPermits: [],
    });
    expect(prisma.browserRuntimeSession.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACTIVE" }),
      }),
    );
    expect(prisma.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
  });

  it("revokes execution when Agent ownership expires despite healthy Browser heartbeats", async () => {
    const { prisma, handleHeartbeat, service, socket } = fixture();
    const session = activeSession({
      ownerTaskId: "agent-1",
      ownerFencingToken: 3n,
    });
    prisma.browserRuntimeSession.findUnique.mockResolvedValue(session);
    prisma.agentRuntimeTask.findUnique.mockResolvedValue({
      id: "agent-1",
      fencingToken: 3n,
      status: "RUNNING",
      leaseExpiresAt: new Date(Date.now() - 1),
      run: { lifecycle: "RUNNING", deadlineAt: new Date(Date.now() + 60_000) },
    });
    prisma.browserRuntimeSession.updateMany.mockResolvedValue({ count: 1 });
    await handleHeartbeat.call(service, socket, context, heartbeatFor(session));
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({
      closeSessions: [session.id],
      sessionPermits: [],
    });
    expect(prisma.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
  });

  it("caps renewed execution permission by the current Agent epoch and lease", async () => {
    const { prisma, handleHeartbeat, service, socket } = fixture();
    const session = activeSession({
      ownerTaskId: "e7d10322-6a99-49f2-8974-7cb87b407e7f",
      ownerFencingToken: 3n,
    });
    const expiresAt = new Date(Date.now() + 25_000);
    prisma.browserRuntimeSession.findUnique.mockResolvedValue(session);
    prisma.agentRuntimeTask.findUnique.mockResolvedValue({
      id: session.ownerTaskId,
      fencingToken: 3n,
      status: "RUNNING",
      leaseExpiresAt: expiresAt,
      run: {
        lifecycle: "RUNNING",
        cancelRequestedAt: null,
        deadlineAt: new Date(Date.now() + 60_000),
      },
    });
    prisma.browserRuntimeSession.updateMany.mockResolvedValue({ count: 1 });
    await handleHeartbeat.call(service, socket, context, heartbeatFor(session));
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({
      closeSessions: [],
      sessionPermits: [
        {
          ownerKind: "AGENT",
          ownerFencingToken: "3",
          expiresAt: expiresAt.toISOString(),
        },
      ],
    });
  });
});

describe("Runtime handshake fencing", () => {
  it("rejects a Runtime disabled between authentication and generation registration", async () => {
    const { handleHello, prisma, hub, service, socket } = fixture();
    prisma.browserRuntime.findFirst
      .mockResolvedValueOnce({
        id: context.runtimeId,
        enabled: true,
        revokedAt: null,
      } as never)
      .mockResolvedValueOnce(null as never);
    await expect(
      handleHello.call(service, socket, hello()),
    ).resolves.toBeUndefined();
    expect(prisma.browserRuntime.update).not.toHaveBeenCalled();
    expect(hub.register).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(
      4003,
      expect.stringContaining("disabled or drained"),
    );
  });
  it("does not inherit closure capability from a previous connection", async () => {
    const { handleHello, prisma, service, socket } = fixture();
    prisma.browserRuntime.findFirst.mockResolvedValue({
      id: context.runtimeId,
      enabled: true,
      revokedAt: null,
      capabilities: ["browser", "closure-evidence-v1"],
    } as never);
    const accepted = await handleHello.call(
      service,
      socket,
      hello("0.2.16", 12),
    );
    expect(accepted?.capabilities.has("closure-evidence-v1")).toBe(false);
    expect(prisma.browserRuntime.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ capabilities: ["browser"] }),
      }),
    );
  });
  it("wakes recoveries after a new capable connection authenticates", async () => {
    const { handleHello, recovery, service, socket } = fixture();
    const greeting = runtimeClientMessageSchema.parse({
      ...hello(),
      capabilities: ["closure-evidence-v1"],
      hostInstanceId: "host-instance-0000001",
      daemonInstanceId: "c7f9b873-b1e0-4b05-94a6-a1d96682305c",
    });
    await handleHello.call(service, socket, greeting);
    expect(recovery.wakeRuntime).toHaveBeenCalledWith(context.runtimeId);
  });
});
