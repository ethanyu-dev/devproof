import {
  RUNTIME_PROTOCOL,
  runtimeClientMessageSchema,
} from "@devproof/runtime-protocol";
import { describe, expect, it, vi } from "vitest";

import { RuntimeGatewayService } from "./runtime-gateway.service.js";

function fixture() {
  const prisma = {
    $transaction: vi.fn(),
    browserRuntime: {
      findFirst: vi.fn().mockResolvedValue({
        enabled: true,
        id: "6f090d88-8987-487f-8338-1a734beab6a6",
        networkAllowlist: ["test-console.paigod.work"],
        revokedAt: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    browserRuntimeSession: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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
  const service = new RuntimeGatewayService(
    prisma as never,
    redis as never,
    hub as never,
    {} as never,
    {} as never,
  );
  const socket = { send: vi.fn() };
  const handleHello = Reflect.get(service, "handleHello") as (
    socket: typeof socket,
    hello: ReturnType<typeof runtimeClientMessageSchema.parse>,
  ) => Promise<string | undefined>;
  const handleHeartbeat = Reflect.get(service, "handleHeartbeat") as (
    socket: typeof socket,
    runtimeId: string,
    heartbeat: ReturnType<typeof runtimeClientMessageSchema.parse>,
  ) => Promise<void>;
  return { handleHeartbeat, handleHello, hub, prisma, service, socket };
}

function hello(version?: string) {
  return runtimeClientMessageSchema.parse({
    activeSessions: [],
    instanceNonce: "instance-nonce-123456",
    protocol: RUNTIME_PROTOCOL,
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
      protocol: { minor: 10 },
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

    await handleHeartbeat.call(
      service,
      socket,
      "6f090d88-8987-487f-8338-1a734beab6a6",
      heartbeat,
    );

    const update = prisma.browserRuntime.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(update.data).not.toHaveProperty("maxConcurrency");
    expect(update.data).toMatchObject({ status: "ONLINE" });
  });
});

describe("RuntimeGatewayService terminal session ownership", () => {
  it("excludes sessions with a close timestamp from reconnect reconciliation", async () => {
    const { handleHello, prisma, service, socket } = fixture();

    await handleHello.call(service, socket, hello("0.2.14"));

    expect(prisma.browserRuntimeSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          closedAt: null,
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

    await handleHeartbeat.call(
      service,
      socket,
      "6f090d88-8987-487f-8338-1a734beab6a6",
      heartbeat,
    );

    expect(prisma.browserRuntimeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ closedAt: null, id: sessionId }),
      }),
    );
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({
      closeSessions: [sessionId],
      type: "runtime.heartbeat.ack",
    });
  });

  it("does not reactivate a closing session during reconnect", async () => {
    const { prisma, service } = fixture();
    const sessionId = "cf5a946c-f906-4df4-9296-1d6482ddaf75";
    prisma.browserRuntimeSession.findMany.mockResolvedValue([
      {
        fencingToken: 7n,
        id: sessionId,
        leaseToken: "b15a5cc9-1fa7-4960-ab84-763db94e24ab",
        profileKey: "profile-key",
        profileMode: "PERSISTENT",
        status: "CLOSING",
        userBrowserProfile: null,
        verificationRuns: [],
      },
    ]);
    prisma.browserRuntimeSession.updateMany.mockResolvedValue({ count: 1 });
    const reconcile = Reflect.get(service, "reconcile") as (
      runtimeId: string,
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
    prisma.browserRuntimeSession.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
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

    await handleHeartbeat.call(
      service,
      socket,
      "6f090d88-8987-487f-8338-1a734beab6a6",
      heartbeat,
    );

    expect(prisma.browserRuntimeSession.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.not.objectContaining({ status: expect.anything() }),
        where: expect.objectContaining({ id: sessionId, status: "CLOSING" }),
      }),
    );
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({
      closeSessions: [sessionId],
    });
  });

  it("releases leases only after a closing session disappears from heartbeats", async () => {
    const { handleHeartbeat, prisma, service, socket } = fixture();
    const sessionId = "cf5a946c-f906-4df4-9296-1d6482ddaf75";
    const updatedAt = new Date("2026-08-28T01:00:00.000Z");
    prisma.browserRuntimeSession.findMany.mockResolvedValue([
      { id: sessionId, updatedAt },
    ]);
    prisma.browserRuntimeSession.updateMany.mockResolvedValue({ count: 1 });
    const heartbeat = runtimeClientMessageSchema.parse({
      activeSessions: [],
      maxConcurrency: 4,
      sentAt: new Date().toISOString(),
      type: "runtime.heartbeat",
    });

    await handleHeartbeat.call(
      service,
      socket,
      "6f090d88-8987-487f-8338-1a734beab6a6",
      heartbeat,
    );

    expect(prisma.browserRuntimeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CLOSED" }),
        where: expect.objectContaining({
          id: sessionId,
          status: "CLOSING",
          updatedAt,
        }),
      }),
    );
    expect(prisma.browserRuntimeSlot.deleteMany).toHaveBeenCalledWith({
      where: { sessionId },
    });
    expect(prisma.browserRuntimeProfileLease.deleteMany).toHaveBeenCalledWith({
      where: { sessionId },
    });
  });
});

describe("RuntimeGatewayService user Profile protocol floor", () => {
  it("does not restore a user Profile on a Runtime older than protocol v1.9", async () => {
    const updateProfile = vi.fn().mockResolvedValue({ count: 1 });
    const updateSession = vi.fn().mockResolvedValue({});
    const prisma = {
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
      ),
      browserRuntimeProfileLease: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      browserRuntimeSession: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "session-1",
            profileMode: "PERSISTENT",
            status: "ACTIVE",
            userBrowserProfile: {
              id: "profile-1",
            },
          },
        ]),
        update: updateSession,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      browserRuntimeSlot: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      userBrowserProfile: { updateMany: updateProfile },
    };
    const service = new RuntimeGatewayService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const reconcile = Reflect.get(service, "reconcile") as (
      runtimeId: string,
      localSessions: unknown[],
      protocolMinor: number,
    ) => Promise<unknown[]>;

    await expect(reconcile.call(service, "runtime-1", [], 7)).resolves.toEqual(
      [],
    );
    expect(updateSession).toHaveBeenCalledWith(
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
        where: expect.objectContaining({ id: "profile-1" }),
      }),
    );
  });
});
