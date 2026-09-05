import { createHash, randomUUID } from "node:crypto";

import { Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PREAUTH_TIMEOUT_MS,
  RUNTIME_PROTOCOL,
  RUNTIME_HEARTBEAT_INTERVAL_MS,
  runtimeClientMessageSchema,
  type ReconcileAction,
  type RuntimeSessionPermit,
} from "@devproof/runtime-protocol";
import WebSocket, { type RawData } from "ws";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../infrastructure/redis.service.js";
import { RuntimeCommandDispatcher } from "./runtime-command-dispatcher.service.js";
import { RuntimeConnectionHub } from "./runtime-connection-hub.service.js";
import { RuntimeHumanControlRelay } from "./runtime-human-control-relay.service.js";
import { MetricsService } from "../observability/metrics.service.js";
import { ObservabilityService } from "../observability/observability.service.js";
import { sessionExecutionPermit } from "./session-permit.js";
import { quarantineSession } from "./session-resource-cleanup.js";

import { SessionRecoveryService } from "./session-recovery.service.js";
import type { AuthenticatedRuntimeContext } from "./session-closure.types.js";

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function frameLength(data: RawData) {
  if (Array.isArray(data)) {
    return data.reduce((sum, value) => sum + value.byteLength, 0);
  }
  return data.byteLength;
}

const HEARTBEAT_RENEWABLE_STATUSES = [
  "OPENING",
  "ACTIVE",
  "HUMAN_CONTROL",
] as const;

@Injectable()
export class RuntimeGatewayService {
  private readonly logger = new Logger(RuntimeGatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly hub: RuntimeConnectionHub,
    private readonly commands: RuntimeCommandDispatcher,
    private readonly humanControl: RuntimeHumanControlRelay,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly observability?: ObservabilityService,
    @Optional() private readonly recovery?: SessionRecoveryService,
  ) {}

  accept(socket: WebSocket) {
    let runtimeId: string | undefined;
    let context: AuthenticatedRuntimeContext | undefined;
    let deliveryAcknowledgements = false;
    let queue = Promise.resolve();
    const preauthTimer = setTimeout(() => {
      if (!runtimeId) {
        this.closeObserved(
          socket,
          4008,
          "hello_timeout",
          "Runtime hello timed out.",
        );
      }
    }, RUNTIME_PREAUTH_TIMEOUT_MS);

    socket.on("message", (data) => {
      queue = queue
        .then(async () => {
          if (frameLength(data) > RUNTIME_MAX_FRAME_BYTES) {
            this.closeObserved(
              socket,
              4009,
              "frame_too_large",
              "Runtime frame is too large.",
            );
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(data.toString());
          } catch {
            this.closeObserved(
              socket,
              4007,
              "invalid_json",
              "Runtime frame is not valid JSON.",
            );
            return;
          }
          const parsed = runtimeClientMessageSchema.safeParse(raw);
          if (!parsed.success) {
            if (!runtimeId) {
              this.reject(socket, "INVALID_HELLO", "Runtime hello is invalid.");
            } else {
              this.closeObserved(
                socket,
                4007,
                "invalid_message",
                "Runtime message is invalid.",
                {
                  runtimeId,
                },
              );
            }
            return;
          }
          const message = parsed.data;
          if (!runtimeId) {
            if (message.type !== "runtime.hello") {
              this.reject(
                socket,
                "INVALID_HELLO",
                "Runtime hello is required.",
              );
              return;
            }
            context = await this.handleHello(socket, message);
            runtimeId = context?.runtimeId;
            if (runtimeId) {
              deliveryAcknowledgements = message.protocol.minor >= 3;
              clearTimeout(preauthTimer);
            }
            return;
          }
          if (!context || !(await this.isCurrentConnection(context))) {
            this.closeObserved(
              socket,
              4001,
              "stale_connection",
              "A newer Runtime connection replaced this one.",
              { runtimeId },
            );
            return;
          }
          if (message.type === "runtime.hello") {
            this.closeObserved(
              socket,
              4007,
              "repeated_hello",
              "Runtime hello cannot be repeated.",
              {
                runtimeId,
              },
            );
          } else if (message.type === "runtime.heartbeat") {
            await this.handleHeartbeat(socket, context, message);
          } else if (message.type === "command.result") {
            await this.commands.acceptResult(message, context);
            if (deliveryAcknowledgements) {
              await this.acknowledgeDelivery(
                context,
                message.commandId,
                message.type,
              );
            }
          } else if (message.type === "runtime.event") {
            await this.commands.acceptEvent(message, context);
            if (deliveryAcknowledgements) {
              await this.acknowledgeDelivery(
                context,
                message.eventId,
                message.type,
              );
            }
          } else if (message.type === "profile.lifecycle") {
            await this.handleProfileLifecycle(runtimeId, message);
            if (deliveryAcknowledgements) {
              await this.acknowledgeDelivery(
                context,
                message.eventId,
                message.type,
              );
            }
          } else if (message.type === "human.preview.frame") {
            this.humanControl.acceptFrame(runtimeId, message);
          } else if (message.type === "human.input.result") {
            this.humanControl.acceptInputResult(runtimeId, message);
            if (deliveryAcknowledgements) {
              await this.acknowledgeDelivery(
                context,
                message.dispatchId,
                message.type,
              );
            }
          }
        })
        .catch((error: Error) => {
          this.logger.error("Runtime gateway message failed: " + error.message);
          this.observability?.log(
            "error",
            "runtime.gateway.message_failed",
            { runtimeId },
            error,
          );
          this.closeObserved(
            socket,
            4011,
            "message_processing_failed",
            "Runtime gateway failed to process the message.",
            { runtimeId },
          );
        });
    });

    socket.on("close", () => {
      clearTimeout(preauthTimer);
      if (runtimeId) {
        this.metrics?.increment(
          "devproof_runtime_gateway_disconnects_total",
          "Browser Runtime gateway disconnects.",
        );
        this.observability?.log("info", "runtime.gateway.disconnected", {
          runtimeId,
        });
        if (this.hub.unregister(runtimeId, socket))
          this.humanControl.runtimeDisconnected(runtimeId);
        void this.prisma.browserRuntime
          .updateMany({
            data: { gatewayInstanceId: null, status: "OFFLINE" },
            where: {
              gatewayInstanceId: this.redis.instanceId,
              connectionId: context?.connectionId ?? "",
              connectionGeneration: context?.connectionGeneration ?? -1n,
              id: runtimeId,
              revokedAt: null,
              status: { not: "REVOKED" },
            },
          })
          .catch((error: Error) => {
            this.observability?.log(
              "error",
              "runtime.gateway.disconnect_persist_failed",
              { runtimeId },
              error,
            );
          });
      }
    });

    socket.on("error", (error) => {
      this.logger.warn("Runtime socket error: " + error.message);
      this.observability?.log(
        "warn",
        "runtime.gateway.socket_error",
        { runtimeId },
        error,
      );
    });
  }

  private async handleHello(
    socket: WebSocket,
    hello: Extract<
      ReturnType<typeof runtimeClientMessageSchema.parse>,
      { type: "runtime.hello" }
    >,
  ) {
    if (hello.protocol.major !== RUNTIME_PROTOCOL.major) {
      this.reject(
        socket,
        "PROTOCOL_MISMATCH",
        "Runtime protocol major version is not supported.",
      );
      return undefined;
    }
    const runtime = await this.prisma.browserRuntime.findFirst({
      where: {
        id: hello.runtimeId,
        tokenHash: hashToken(hello.runtimeToken),
      },
    });
    if (!runtime) {
      this.reject(socket, "AUTH_FAILED", "Runtime credentials are invalid.");
      return undefined;
    }
    if (!runtime.enabled || runtime.revokedAt) {
      this.reject(socket, "RUNTIME_DISABLED", "Runtime has been disabled.");
      return undefined;
    }

    const selectedMinor = Math.min(
      hello.protocol.minor,
      RUNTIME_PROTOCOL.minor,
    );
    const connectionId = randomUUID();
    const capabilities = (hello.capabilities ?? []).filter((value) =>
      value === "closure-evidence-v1"
        ? selectedMinor >= 14
        : ["auth-snapshot-v1", "session-permits-v1"].includes(value) &&
          selectedMinor >= 13,
    );
    const connected = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM browser_runtimes WHERE id = ${runtime.id}::uuid FOR UPDATE`;
      const current = await tx.browserRuntime.findFirst({
        where: {
          id: runtime.id,
          tokenHash: hashToken(hello.runtimeToken),
          enabled: true,
          revokedAt: null,
          drainState: "NONE",
        },
      });
      if (!current) return null;
      return tx.browserRuntime.update({
        data: {
          connectionId,
          connectionGeneration: { increment: 1 },
          hostInstanceId: hello.hostInstanceId ?? null,
          daemonInstanceId: hello.daemonInstanceId ?? null,
          connectedAt: new Date(),
          gatewayInstanceId: this.redis.instanceId,
          lastSeenAt: new Date(),
          protocolMajor: RUNTIME_PROTOCOL.major,
          protocolMinor: selectedMinor,
          status: "ONLINE",
          ...(hello.version ? { version: hello.version } : {}),
          capabilities: [
            ...new Set([
              ...(Array.isArray(runtime.capabilities)
                ? runtime.capabilities
                : []
              ).filter(
                (capability): capability is string =>
                  typeof capability === "string" &&
                  ![
                    "auth-snapshot-v1",
                    "session-permits-v1",
                    "closure-evidence-v1",
                  ].includes(capability),
              ),
              ...capabilities,
            ]),
          ],
        },
        where: { id: runtime.id },
      });
    });
    if (!connected) {
      this.reject(
        socket,
        "RUNTIME_DISABLED",
        "Runtime was disabled or drained during its handshake.",
      );
      return undefined;
    }
    const context: AuthenticatedRuntimeContext = {
      runtimeId: runtime.id,
      connectionId,
      connectionGeneration: connected.connectionGeneration,
      negotiatedMinor: selectedMinor,
      capabilities: new Set(capabilities),
      ...(hello.hostInstanceId ? { hostInstanceId: hello.hostInstanceId } : {}),
      ...(hello.daemonInstanceId
        ? { daemonInstanceId: hello.daemonInstanceId }
        : {}),
    };
    this.hub.register(runtime.id, socket, context.connectionGeneration);
    await this.redis.disconnectOlderGateways(
      runtime.id,
      context.connectionGeneration,
    );
    await this.redis.markRuntimeOnline(
      runtime.id,
      context.connectionGeneration,
    );
    this.metrics?.increment(
      "devproof_runtime_gateway_connections_total",
      "Accepted Browser Runtime gateway connections.",
      { protocol_minor: selectedMinor },
    );
    this.observability?.log("info", "runtime.gateway.connected", {
      protocolMajor: RUNTIME_PROTOCOL.major,
      protocolMinor: selectedMinor,
      runtimeId: runtime.id,
    });

    const reconcile = await this.reconcile(
      runtime.id,
      hello.activeSessions,
      selectedMinor,
      context,
    );
    socket.send(
      JSON.stringify({
        capabilities,
        heartbeatIntervalMs: RUNTIME_HEARTBEAT_INTERVAL_MS,
        networkAllowlist:
          selectedMinor >= 4 ? (runtime.networkAllowlist ?? []) : [],
        protocol: { ...RUNTIME_PROTOCOL, minor: selectedMinor },
        reconcile,
        serverTime: new Date().toISOString(),
        type: "runtime.hello.accepted",
      }),
    );
    if (
      env().RUNTIME_SESSION_RECOVERY_ENABLED &&
      capabilities.includes("closure-evidence-v1")
    )
      await this.recovery?.wakeRuntime(runtime.id);
    return context;
  }

  private async isCurrentConnection(context: AuthenticatedRuntimeContext) {
    return Boolean(
      await this.prisma.browserRuntime.findFirst({
        where: {
          id: context.runtimeId,
          connectionId: context.connectionId,
          connectionGeneration: context.connectionGeneration,
          enabled: true,
          revokedAt: null,
        },
        select: { id: true },
      }),
    );
  }

  private async reconcile(
    runtimeId: string,
    localSessions: Array<{
      sessionId: string;
      fencingToken: string;
      leaseToken: string;
      profileKey: string;
      profileMode: "PERSISTENT" | "EPHEMERAL";
      state: "OPEN" | "HUMAN_CONTROL" | "INTERRUPTED";
      live?: boolean | undefined;
    }>,
    protocolMinor: number,
    context?: AuthenticatedRuntimeContext,
  ) {
    const actions: ReconcileAction[] = [];
    if (protocolMinor < 9) {
      const incompatible = await this.prisma.browserRuntimeSession.findMany({
        where: {
          runtimeId,
          closedAt: null,
          userBrowserProfileId: { not: null },
        },
      });
      for (const session of incompatible)
        if (session.userBrowserProfileId)
          await this.markUserProfileSessionIncompatible(
            session.id,
            session.userBrowserProfileId,
          );
    }
    const seen = new Set(localSessions.map((local) => local.sessionId));
    for (const local of localSessions) {
      const session = await this.prisma.browserRuntimeSession.findUnique({
        where: { id: local.sessionId },
      });
      if (
        !session ||
        session.runtimeId !== runtimeId ||
        session.leaseToken !== local.leaseToken ||
        session.fencingToken.toString() !== local.fencingToken ||
        session.profileKey !== local.profileKey ||
        session.profileMode !== local.profileMode
      ) {
        actions.push({
          action: "CLOSE_LOCAL",
          sessionId: local.sessionId,
          reason: "The local session no longer owns the server lease.",
        });
        continue;
      }
      if (session.userBrowserProfileId && protocolMinor < 9) {
        actions.push({
          action: "CLOSE_LOCAL",
          sessionId: session.id,
          reason:
            "User browser Profiles require Runtime protocol v1.9 or newer.",
        });
        continue;
      }
      if (
        local.live === false ||
        (local.live === undefined && local.state === "INTERRUPTED")
      ) {
        await this.prisma.$transaction((tx) =>
          quarantineSession(tx, session.id, "RUNTIME_RESTARTED_UNVERIFIED"),
        );
        actions.push({
          action: "CLOSE_LOCAL",
          sessionId: session.id,
          reason:
            "An interrupted browser requires verified termination before replacement.",
        });
        continue;
      }
      const renewed = await this.renewSession(
        runtimeId,
        local,
        protocolMinor,
        context,
      );
      if (!renewed) {
        actions.push({
          action: "CLOSE_LOCAL",
          sessionId: session.id,
          reason: "The browser or executor lease is no longer valid.",
        });
        continue;
      }
      actions.push({
        action: "ADOPT",
        sessionId: session.id,
        fencingToken: session.fencingToken.toString(),
        leaseToken: session.leaseToken,
        leaseExpiresAt: renewed.expiresAt.toISOString(),
        ...(renewed.permit ? { permit: renewed.permit } : {}),
      });
    }
    // Inventory absence schedules verification; it is not itself closure proof.
    await this.finalizeMissingClosedSessions(runtimeId, seen);
    return actions;
  }

  private async renewSession(
    runtimeId: string,
    local: { sessionId: string; fencingToken: string; leaseToken: string },
    protocolMinor?: number,
    context?: AuthenticatedRuntimeContext,
  ) {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + env().RUNTIME_LEASE_SECONDS * 1_000,
    );
    const result = await this.prisma.$transaction(
      async (tx) => {
        if (context) {
          const current = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT id FROM browser_runtimes WHERE id = ${runtimeId}::uuid
              AND connection_id = ${context.connectionId}::uuid
              AND connection_generation = ${context.connectionGeneration}
              AND enabled = true AND revoked_at IS NULL FOR UPDATE
          `);
          if (!current.length) return null;
        }
        const session = await tx.browserRuntimeSession.findUnique({
          include: { slot: true, profileLease: true },
          where: { id: local.sessionId },
        });
        if (
          !session ||
          session.runtimeId !== runtimeId ||
          session.leaseToken !== local.leaseToken ||
          session.fencingToken.toString() !== local.fencingToken
        )
          return null;
        const intactSlot =
          session.slot &&
          session.slot.leaseToken === session.leaseToken &&
          session.slot.fencingToken === session.fencingToken;
        const intactProfile =
          session.profileMode !== "PERSISTENT" ||
          (session.profileLease &&
            session.profileLease.leaseToken === session.leaseToken &&
            session.profileLease.fencingToken === session.fencingToken);
        if (
          session.status === "CLOSING" ||
          session.status === "CLOSED" ||
          session.closedAt
        )
          return null;
        if (
          !intactSlot ||
          !intactProfile ||
          session.quarantinedAt ||
          session.leaseExpiresAt <= now ||
          !HEARTBEAT_RENEWABLE_STATUSES.includes(
            session.status as (typeof HEARTBEAT_RENEWABLE_STATUSES)[number],
          )
        ) {
          await quarantineSession(tx, session.id, "LEASE_EXPIRED");
          return null;
        }
        const minor = protocolMinor ?? session.protocolMinor;
        const permit =
          minor >= 13 || session.ownerTaskId
            ? await sessionExecutionPermit(
                tx,
                { ...session, leaseExpiresAt: expiresAt },
                now,
              )
            : null;
        if ((minor >= 13 || session.ownerTaskId) && !permit) {
          await quarantineSession(tx, session.id, "EXECUTOR_LEASE_EXPIRED");
          return null;
        }
        const updated = await tx.browserRuntimeSession.updateMany({
          data: {
            leaseExpiresAt: expiresAt,
            ...(protocolMinor === undefined ? {} : { protocolMinor }),
            ...(permit
              ? { executionPermitExpiresAt: new Date(permit.expiresAt) }
              : {}),
          },
          where: {
            id: session.id,
            leaseToken: session.leaseToken,
            fencingToken: session.fencingToken,
            leaseExpiresAt: { gt: now },
            status: { in: [...HEARTBEAT_RENEWABLE_STATUSES] },
            quarantinedAt: null,
          },
        });
        if (updated.count !== 1) return null;
        await tx.browserRuntimeSlot.updateMany({
          data: { expiresAt },
          where: {
            sessionId: session.id,
            fencingToken: session.fencingToken,
            leaseToken: session.leaseToken,
          },
        });
        await tx.browserRuntimeProfileLease.updateMany({
          data: { expiresAt },
          where: {
            sessionId: session.id,
            fencingToken: session.fencingToken,
            leaseToken: session.leaseToken,
          },
        });
        return { expiresAt, permit };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return result;
  }

  private async finalizeMissingClosedSessions(
    runtimeId: string,
    localIds: Set<string>,
  ) {
    if (!env().RUNTIME_SESSION_RECOVERY_ENABLED) return;
    const sessions = await this.prisma.browserRuntimeSession.findMany({
      where: {
        runtimeId,
        closureVerifiedAt: null,
        status: { in: ["CLOSING", "LOST", "FAILED"] },
        updatedAt: {
          lte: new Date(Date.now() - RUNTIME_HEARTBEAT_INTERVAL_MS),
        },
        ...(localIds.size ? { id: { notIn: [...localIds] } } : {}),
      },
      take: 100,
    });
    for (const session of sessions)
      await this.recovery?.request(session.id, "RUNTIME_INVENTORY_MISSING");
  }

  private async markUserProfileSessionIncompatible(
    sessionId: string,
    profileId: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await quarantineSession(
        tx,
        sessionId,
        "USER_PROFILE_PROTOCOL_INCOMPATIBLE",
      );
      await tx.userBrowserProfile.updateMany({
        data: {
          status: "MIGRATION_REQUIRED",
          verificationError: {
            code: "USER_PROFILE_PROTOCOL_INCOMPATIBLE",
            message:
              "The assigned Browser Runtime must be upgraded to protocol v1.9 or newer.",
          },
        },
        where: {
          id: profileId,
        },
      });
    });
    this.observability?.log(
      "warn",
      "runtime.user_profile.protocol_incompatible",
      { profileId, sessionId },
    );
  }

  private async handleHeartbeat(
    socket: WebSocket,
    context: AuthenticatedRuntimeContext,
    heartbeat: Extract<
      ReturnType<typeof runtimeClientMessageSchema.parse>,
      { type: "runtime.heartbeat" }
    >,
  ) {
    const runtimeId = context.runtimeId;
    const closeSessions: string[] = [];
    const sessionPermits: RuntimeSessionPermit[] = [];
    for (const local of heartbeat.activeSessions) {
      const renewed = await this.renewSession(
        runtimeId,
        local,
        undefined,
        context,
      );
      if (!renewed) {
        closeSessions.push(local.sessionId);
      } else if (renewed.permit) sessionPermits.push(renewed.permit);
    }
    await this.finalizeMissingClosedSessions(
      runtimeId,
      new Set(heartbeat.activeSessions.map((session) => session.sessionId)),
    );
    const updated = await this.prisma.browserRuntime.updateMany({
      data: { lastSeenAt: new Date(), status: "ONLINE" },
      where: {
        id: runtimeId,
        connectionId: context.connectionId,
        connectionGeneration: context.connectionGeneration,
        enabled: true,
        revokedAt: null,
      },
    });
    if (updated.count !== 1) return;
    await this.redis.markRuntimeOnline(runtimeId, context.connectionGeneration);
    socket.send(
      JSON.stringify({
        closeSessions,
        sessionPermits,
        ...(heartbeat.heartbeatId
          ? { heartbeatId: heartbeat.heartbeatId }
          : {}),
        leaseExpiresAt: new Date(
          Date.now() + env().RUNTIME_LEASE_SECONDS * 1_000,
        ).toISOString(),
        serverTime: new Date().toISOString(),
        type: "runtime.heartbeat.ack",
      }),
    );
  }

  private async handleProfileLifecycle(
    runtimeId: string,
    message: Extract<
      ReturnType<typeof runtimeClientMessageSchema.parse>,
      { type: "profile.lifecycle" }
    >,
  ) {
    const profile = await this.prisma.userBrowserProfile.findFirst({
      select: { id: true, teamId: true },
      where: {
        assignedRuntimeId: runtimeId,
        runtimeProfileKey: message.profileKey,
      },
    });
    if (!profile) {
      this.observability?.log("warn", "runtime.profile.expiry_unmatched", {
        runtimeId,
      });
      return;
    }
    const deletedAt = new Date(message.purgedAt);
    const lastUsedAt = new Date(message.lastUsedAt);
    await this.prisma.$transaction(async (tx) => {
      const bindings = await tx.taskProfileBinding.findMany({
        select: { taskExecutionId: true },
        where: { resolvedProfileId: profile.id, status: "RESOLVED" },
      });
      if (bindings.length) {
        const taskIds = bindings.map((binding) => binding.taskExecutionId);
        await tx.taskProfileBinding.updateMany({
          data: {
            failureCode: "PROFILE_INACTIVITY_EXPIRED",
            failureMessage:
              "The selected user profile was deleted after 30 days of inactivity.",
            resolvedAt: null,
            resolvedProfileId: null,
            status: "WAITING_INPUT",
          },
          where: { taskExecutionId: { in: taskIds } },
        });
        await tx.taskExecution.updateMany({
          data: {
            currentStage: "PROFILE_RESOLUTION",
            lifecycle: "WAITING_INPUT",
            projectionNeededAt: null,
            waitingReason: "PROFILE_INACTIVITY_EXPIRED",
          },
          where: {
            id: { in: taskIds },
            lifecycle: { in: ["QUEUED", "RUNNING", "WAITING_INPUT"] },
          },
        });
        await tx.taskExecutionStage.updateMany({
          data: {
            finishedAt: null,
            status: "WAITING_INPUT",
            waitingReason: "PROFILE_INACTIVITY_EXPIRED",
          },
          where: {
            taskExecutionId: { in: taskIds },
            type: "PROFILE_RESOLUTION",
          },
        });
        await tx.taskExecutionEvent.createMany({
          data: taskIds.map((taskExecutionId) => ({
            actor: "BROWSER_RUNTIME",
            kind: "task.profile.expired",
            payload: {
              deletedAt: deletedAt.toISOString(),
              lastUsedAt: lastUsedAt.toISOString(),
              profileId: profile.id,
              runtimeId,
            },
            taskExecutionId,
            teamId: profile.teamId,
          })),
        });
      }
      await tx.userBrowserProfile.delete({ where: { id: profile.id } });
    });
    this.metrics?.increment(
      "devproof_browser_profile_expirations_total",
      "User browser profiles purged by Browser Runtime after inactivity.",
    );
    this.observability?.log("info", "runtime.profile.expired", {
      profileId: profile.id,
      runtimeId,
    });
  }

  private reject(
    socket: WebSocket,
    code:
      | "AUTH_FAILED"
      | "PROTOCOL_MISMATCH"
      | "RUNTIME_DISABLED"
      | "INVALID_HELLO",
    message: string,
  ) {
    this.metrics?.increment(
      "devproof_runtime_gateway_rejections_total",
      "Rejected Browser Runtime gateway handshakes by reason.",
      { reason: code.toLowerCase() },
    );
    this.observability?.log("warn", "runtime.gateway.rejected", { code });
    socket.send(
      JSON.stringify({
        code,
        message,
        supportedProtocol: RUNTIME_PROTOCOL,
        type: "runtime.hello.rejected",
      }),
    );
    socket.close(4003, message);
  }

  private closeObserved(
    socket: WebSocket,
    code: number,
    reason: string,
    message: string,
    fields: Record<string, unknown> = {},
  ) {
    this.metrics?.increment(
      "devproof_runtime_gateway_protocol_closures_total",
      "Runtime gateway connections closed for protocol or processing errors.",
      { reason },
    );
    this.observability?.log("warn", "runtime.gateway.protocol_closed", {
      ...fields,
      closeCode: code,
      reason,
    });
    socket.close(code, message);
  }

  private acknowledgeDelivery(
    context: AuthenticatedRuntimeContext,
    messageId: string,
    messageType:
      | "command.result"
      | "human.input.result"
      | "runtime.event"
      | "profile.lifecycle",
  ) {
    return this.hub.send(
      context.runtimeId,
      {
        messageId,
        messageType,
        type: "runtime.delivery.ack",
      },
      context.connectionGeneration,
    );
  }
}
