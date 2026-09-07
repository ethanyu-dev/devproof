import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RUNTIME_PROTOCOL,
  runtimeClientMessageSchema,
} from "@devproof/runtime-protocol";
import { RuntimeGatewayService } from "./runtime-gateway.service.js";
import { leaseDigest } from "./session-recovery.state.js";
import { resetEnvForTests } from "../config/env.js";

const oldDaemon = "e4c7a0c3-d7b3-4d1d-8f1c-ceb28ade3743";
const newDaemon = "de4ac75a-9d7c-4d4e-83a6-fde573a9d2bb";

beforeEach(() => {
  vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true");
  resetEnvForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

function fixture() {
  const credential = "new-credential".repeat(4);
  const runtime = {
    id: randomUUID(),
    teamId: randomUUID(),
    enabled: false,
    status: "OFFLINE",
    drainState: "RESUMING",
    drainGeneration: 2,
    connectionGeneration: 7n,
    connectionId: null as string | null,
    gatewayInstanceId: null,
    hostInstanceId: "same-host-boot-namespace",
    daemonInstanceId: oldDaemon,
    revokedAt: null,
    tokenHash: leaseDigest(credential),
    capabilities: [],
    networkAllowlist: [],
  };
  const drain = {
    id: randomUUID(),
    runtimeId: runtime.id,
    teamId: runtime.teamId,
    state: "ATTESTED",
    drainGeneration: 2,
    connectionGeneration: 5n,
    hostInstanceId: runtime.hostInstanceId,
    attestedAt: new Date(),
    resumeGeneration: 1,
    resumeConnectionGeneration: 7n,
    resumedAt: null as Date | null,
  };
  const operator = { id: randomUUID() };
  const inventory = [
    {
      id: randomUUID(),
      runtimeId: runtime.id,
      status: "CLOSED",
      closureEvidenceId: randomUUID(),
      closureVerifiedAt: new Date(),
      fencingToken: 18n,
      leaseToken: randomUUID(),
      identityPermit: null,
      executionPermitExpiresAt: new Date(Date.now() - 1000),
    },
  ];
  const proof = {
    id: inventory[0]!.closureEvidenceId,
    sessionId: inventory[0]!.id,
    runtimeId: runtime.id,
    sessionFence: 18n,
    leaseDigest: leaseDigest(inventory[0]!.leaseToken),
  };
  const tx = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    browserRuntime: {
      findFirst: vi.fn().mockImplementation(async ({ where }) => {
        if (where.tokenHash && where.tokenHash !== runtime.tokenHash)
          return null;
        if (where.connectionId && where.connectionId !== runtime.connectionId)
          return null;
        if (
          where.connectionGeneration &&
          where.connectionGeneration !== runtime.connectionGeneration
        )
          return null;
        if (where.enabled === true && !runtime.enabled) return null;
        if (
          where.OR &&
          !where.OR.some(
            (item: { enabled: boolean; drainState: string }) =>
              item.enabled === runtime.enabled &&
              item.drainState === runtime.drainState,
          )
        )
          return null;
        return { ...runtime };
      }),
      update: vi.fn().mockImplementation(async ({ data }) => {
        const connectionGeneration =
          runtime.connectionGeneration +
          BigInt(data.connectionGeneration?.increment ?? 0);
        Object.assign(runtime, data, { connectionGeneration });
        return { ...runtime };
      }),
    },
    runtimeDrainAttestation: {
      findFirst: vi.fn().mockImplementation(async () => ({ ...drain })),
      update: vi.fn().mockImplementation(async ({ data }) => {
        Object.assign(drain, data);
        return { ...drain };
      }),
    },
    browserRuntimePairingToken: {
      findFirst: vi.fn().mockResolvedValue({ resumeRequestedBy: operator.id }),
    },
    user: { findFirst: vi.fn().mockResolvedValue(operator) },
    browserRuntimeSession: {
      findMany: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.status ? [] : inventory,
        ),
    },
    sessionClosureEvidence: { findMany: vi.fn().mockResolvedValue([proof]) },
    browserRuntimeSlot: { count: vi.fn().mockResolvedValue(0) },
    browserRuntimeProfileLease: { count: vi.fn().mockResolvedValue(0) },
    runtimeRecoveryPermit: { count: vi.fn().mockResolvedValue(0) },
    auditEvent: { create: vi.fn() },
  };
  tx.$transaction.mockImplementation((callback) => callback(tx));
  const redis = {
    instanceId: "new-gateway",
    disconnectOlderGateways: vi.fn(),
    markRuntimeOnline: vi.fn(),
  };
  const hub = { register: vi.fn() };
  const socket = { send: vi.fn(), close: vi.fn() };
  const service = new RuntimeGatewayService(
    tx as never,
    redis as never,
    hub as never,
    {} as never,
    {} as never,
  );
  const message = runtimeClientMessageSchema.parse({
    type: "runtime.hello",
    runtimeId: runtime.id,
    runtimeToken: credential,
    protocol: RUNTIME_PROTOCOL,
    activeSessions: [],
    instanceNonce: "nonce-of-new-process",
    hostInstanceId: runtime.hostInstanceId,
    daemonInstanceId: newDaemon,
    sentAt: new Date().toISOString(),
    capabilities: ["closure-evidence-v1", "session-permits-v1"],
  });
  const hello = () =>
    Reflect.get(service, "handleHello").call(service, socket, message);
  return {
    runtime,
    drain,
    tx,
    redis,
    hub,
    socket,
    message,
    hello,
    service,
    proof,
    inventory,
  };
}

describe("attested Runtime first recovery handshake", () => {
  it("enables only a fresh daemon on the preserved host after proof and lease checks", async () => {
    const f = fixture();
    await expect(f.hello()).resolves.toMatchObject({
      connectionGeneration: 8n,
      daemonInstanceId: newDaemon,
    });
    expect(f.runtime).toMatchObject({
      enabled: true,
      drainState: "NONE",
      status: "ONLINE",
      connectionGeneration: 8n,
    });
    expect(f.drain.state).toBe("ATTESTED");
    expect(f.drain.resumedAt).toBeInstanceOf(Date);
    expect(f.tx.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "runtime.drain.resumed" }),
      }),
    );
    expect(f.tx.sessionClosureEvidence.findMany).toHaveBeenCalled();
    expect(f.hub.register).toHaveBeenCalledWith(f.runtime.id, f.socket, 8n);
  });

  it.each([
    ["another host", { hostInstanceId: "different-boot" }],
    ["the old daemon", { daemonInstanceId: oldDaemon }],
    ["missing daemon identity", { daemonInstanceId: undefined }],
    ["old protocol", { protocol: { major: 1, minor: 13 } }],
    ["missing closure capability", { capabilities: ["session-permits-v1"] }],
    ["missing permit capability", { capabilities: ["closure-evidence-v1"] }],
    ["old runtime credential", { runtimeToken: "old-token".repeat(5) }],
    [
      "local session inventory",
      {
        activeSessions: [
          {
            sessionId: randomUUID(),
            fencingToken: "18",
            leaseToken: randomUUID(),
            profileKey: "old",
            profileMode: "PERSISTENT",
            state: "INTERRUPTED",
          },
        ],
      },
    ],
  ])("rejects %s without enabling the node", async (_name, change) => {
    const f = fixture();
    Object.assign(f.message, change);
    await expect(f.hello()).resolves.toBeUndefined();
    expect(f.runtime.enabled).toBe(false);
    expect(f.drain.resumedAt).toBeNull();
    expect(f.hub.register).not.toHaveBeenCalled();
  });

  it.each(["scope", "proof", "slot", "issuer", "barrier"])(
    "rechecks %s before enabling",
    async (change) => {
      const f = fixture();
      if (change === "scope") f.drain.resumeConnectionGeneration = 6n;
      if (change === "proof") f.proof.sessionFence = 17n;
      if (change === "slot") f.tx.browserRuntimeSlot.count.mockResolvedValue(1);
      if (change === "issuer") f.tx.user.findFirst.mockResolvedValue(null);
      if (change === "barrier")
        vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "false");
      await expect(f.hello()).resolves.toBeUndefined();
      expect(f.runtime.enabled).toBe(false);
      expect(f.tx.runtimeDrainAttestation.update).not.toHaveBeenCalled();
    },
  );

  it("rejects a hello that passed initial authentication before a replacement ticket fenced it", async () => {
    const f = fixture();
    f.tx.$transaction.mockImplementation(async (callback) => {
      f.runtime.tokenHash = leaseDigest("replacement-credential");
      f.runtime.connectionGeneration = 8n;
      f.runtime.drainState = "ATTESTED";
      return callback(f.tx);
    });
    await expect(f.hello()).resolves.toBeUndefined();
    expect(f.tx.browserRuntime.update).not.toHaveBeenCalled();
    expect(f.hub.register).not.toHaveBeenCalled();
  });

  it("keeps normal reconnects available and rejects old connection callbacks after recovery", async () => {
    const f = fixture();
    const first = await f.hello();
    await expect(f.hello()).resolves.toMatchObject({
      connectionGeneration: 9n,
    });
    expect(f.tx.runtimeDrainAttestation.update).toHaveBeenCalledTimes(1);
    const isCurrent = Reflect.get(f.service, "isCurrentConnection");
    await expect(isCurrent.call(f.service, first)).resolves.toBe(false);
  });

  it("does not downgrade an in-flight recovery hello to ordinary reconnect after another hello wins", async () => {
    const f = fixture();
    Object.assign(f.message, {
      hostInstanceId: "another-host-namespace",
      daemonInstanceId: oldDaemon,
    });
    f.tx.$transaction.mockImplementation(async (callback) => {
      f.runtime.drainState = "NONE";
      f.runtime.enabled = true;
      f.runtime.status = "ONLINE";
      f.runtime.connectionGeneration = 8n;
      f.drain.resumedAt = new Date();
      return callback(f.tx);
    });
    await expect(f.hello()).resolves.toBeUndefined();
    expect(f.tx.browserRuntime.update).not.toHaveBeenCalled();
    expect(f.hub.register).not.toHaveBeenCalled();
  });
});
