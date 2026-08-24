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

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function frameLength(data: RawData) {
  if (Array.isArray(data)) {
    return data.reduce((sum, value) => sum + value.byteLength, 0);
  }
  return data.byteLength;
}

const ACTIVE_STATUSES = [
  "OPENING",
  "ACTIVE",
  "HUMAN_CONTROL",
  "CLOSING",
  "LOST",
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
  ) {}

  accept(socket: WebSocket) {
    let runtimeId: string | undefined;
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
            runtimeId = await this.handleHello(socket, message);
            if (runtimeId) {
              deliveryAcknowledgements = message.protocol.minor >= 3;
              clearTimeout(preauthTimer);
            }
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
            await this.handleHeartbeat(socket, runtimeId, message);
          } else if (message.type === "command.result") {
            await this.commands.acceptResult(message);
            if (deliveryAcknowledgements) {
              await this.acknowledgeDelivery(
                runtimeId,
                message.commandId,
                message.type,
              );
            }
          } else if (message.type === "runtime.event") {
            await this.commands.acceptEvent(message);
            if (deliveryAcknowledgements) {
              await this.acknowledgeDelivery(
                runtimeId,
                message.eventId,
                message.type,
              );
            }
          } else if (message.type === "profile.lifecycle") {
            await this.handleProfileLifecycle(runtimeId, message);
            if (deliveryAcknowledgements) {
              await this.acknowledgeDelivery(
                runtimeId,
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
                runtimeId,
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
        this.humanControl.runtimeDisconnected(runtimeId);
        this.hub.unregister(runtimeId, socket);
        void this.prisma.browserRuntime
          .updateMany({
            data: { gatewayInstanceId: null, status: "OFFLINE" },
            where: {
              enabled: true,
              gatewayInstanceId: this.redis.instanceId,
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
    await this.prisma.browserRuntime.update({
      data: {
        connectedAt: new Date(),
        gatewayInstanceId: this.redis.instanceId,
        lastSeenAt: new Date(),
        protocolMajor: RUNTIME_PROTOCOL.major,
        protocolMinor: selectedMinor,
        status: "ONLINE",
        ...(hello.version ? { version: hello.version } : {}),
      },
      where: { id: runtime.id },
    });
    this.hub.register(runtime.id, socket);
    await this.redis.disconnectOlderGateways(runtime.id);
    await this.redis.markRuntimeOnline(runtime.id);
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
    );
    socket.send(
      JSON.stringify({
        heartbeatIntervalMs: RUNTIME_HEARTBEAT_INTERVAL_MS,
        networkAllowlist:
          selectedMinor >= 4 ? (runtime.networkAllowlist ?? []) : [],
        protocol: { ...RUNTIME_PROTOCOL, minor: selectedMinor },
        reconcile,
        serverTime: new Date().toISOString(),
        type: "runtime.hello.accepted",
      }),
    );
    return runtime.id;
  }

  private async reconcile(
    runtimeId: string,
    localSessions: Array<{
      fencingToken: string;
      leaseToken: string;
      profileKey: string;
      profileMode: "PERSISTENT" | "EPHEMERAL";
      profileRetention?:
        | {
            inactivityTtlSeconds: number;
            kind: "USER";
          }
        | undefined;
      sessionId: string;
      state: "OPEN" | "HUMAN_CONTROL" | "INTERRUPTED";
    }>,
    protocolMinor: number,
  ) {
    const leaseExpiresAt = new Date(
      Date.now() + env().RUNTIME_LEASE_SECONDS * 1000,
    );
    const serverSessions = await this.prisma.browserRuntimeSession.findMany({
      include: {
        userBrowserProfile: {
          select: { id: true },
        },
        verificationRuns: {
          orderBy: { createdAt: "desc" },
          select: { requestSnapshot: true },
          take: 1,
        },
      },
      where: { runtimeId, status: { in: [...ACTIVE_STATUSES] } },
    });
    await this.prisma.browserRuntimeSession.updateMany({
      data: { protocolMinor },
      where: { id: { in: serverSessions.map((session) => session.id) } },
    });
    const serverById = new Map(serverSessions.map((row) => [row.id, row]));
    const handledSessionIds = new Set<string>();
    const actions: ReconcileAction[] = [];

    for (const local of localSessions) {
      const server = serverById.get(local.sessionId);
      if (server?.userBrowserProfile && protocolMinor < 9) {
        handledSessionIds.add(server.id);
        await this.markUserProfileSessionIncompatible(
          server.id,
          server.userBrowserProfile.id,
        );
        actions.push({
          action: "CLOSE_LOCAL",
          reason:
            "User Browser Profiles require Runtime protocol v1.9 or newer.",
          sessionId: local.sessionId,
        });
        continue;
      }
      const retentionMismatch = server?.userBrowserProfile
        ? !local.profileRetention
        : Boolean(local.profileRetention);
      if (
        !server ||
        server.leaseToken !== local.leaseToken ||
        server.fencingToken.toString() !== local.fencingToken ||
        server.profileMode !== local.profileMode ||
        server.profileKey !== local.profileKey ||
        retentionMismatch
      ) {
        actions.push({
          action: "CLOSE_LOCAL",
          reason: "The local session does not own the current server lease.",
          sessionId: local.sessionId,
        });
        continue;
      }
      if (local.state === "INTERRUPTED") {
        handledSessionIds.add(server.id);
        if (server.profileMode === "EPHEMERAL") {
          await this.prisma.$transaction([
            this.prisma.browserRuntimeSession.update({
              data: {
                closedAt: new Date(),
                lastError: {
                  code: "RUNTIME_RESTARTED",
                  message: "An ephemeral session cannot be restored.",
                },
                status: "LOST",
              },
              where: { id: server.id },
            }),
            this.prisma.browserRuntimeSlot.deleteMany({
              where: { sessionId: server.id },
            }),
            this.prisma.browserRuntimeProfileLease.deleteMany({
              where: { sessionId: server.id },
            }),
          ]);
          actions.push({
            action: "CLOSE_LOCAL",
            reason: "An interrupted ephemeral session cannot be restored.",
            sessionId: server.id,
          });
        } else {
          const rotated = await this.rotateLease(
            server.id,
            runtimeId,
            leaseExpiresAt,
          );
          actions.push({
            action: "RESTORE",
            allowedOrigins: [],
            fencingToken: rotated.fencingToken.toString(),
            leaseExpiresAt: leaseExpiresAt.toISOString(),
            leaseToken: rotated.leaseToken,
            profileKey: server.profileKey,
            profileMode: "PERSISTENT",
            ...(protocolMinor >= 9 && server.userBrowserProfile
              ? {
                  profileRetention: {
                    inactivityTtlSeconds: 2_592_000 as const,
                    kind: "USER" as const,
                  },
                }
              : {}),
            sessionId: server.id,
          });
        }
        continue;
      }
      handledSessionIds.add(server.id);
      await this.prisma.$transaction([
        this.prisma.browserRuntimeSession.update({
          data: {
            leaseExpiresAt,
            status:
              local.state === "HUMAN_CONTROL" ? "HUMAN_CONTROL" : "ACTIVE",
          },
          where: { id: server.id },
        }),
        this.prisma.browserRuntimeSlot.updateMany({
          data: { expiresAt: leaseExpiresAt },
          where: {
            fencingToken: server.fencingToken,
            leaseToken: server.leaseToken,
            sessionId: server.id,
          },
        }),
        this.prisma.browserRuntimeProfileLease.updateMany({
          data: { expiresAt: leaseExpiresAt },
          where: {
            fencingToken: server.fencingToken,
            leaseToken: server.leaseToken,
            sessionId: server.id,
          },
        }),
      ]);
      actions.push({
        action: "ADOPT",
        fencingToken: server.fencingToken.toString(),
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        leaseToken: server.leaseToken,
        sessionId: server.id,
      });
    }

    for (const session of serverSessions) {
      if (handledSessionIds.has(session.id)) {
        continue;
      }
      if (session.userBrowserProfile && protocolMinor < 9) {
        await this.markUserProfileSessionIncompatible(
          session.id,
          session.userBrowserProfile.id,
        );
        continue;
      }
      if (session.profileMode === "EPHEMERAL" || session.status === "CLOSING") {
        await this.prisma.$transaction([
          this.prisma.browserRuntimeSession.update({
            data: {
              closedAt: new Date(),
              lastError: {
                code: "RUNTIME_RESTARTED",
                message: "An ephemeral session cannot be restored.",
              },
              status: "LOST",
            },
            where: { id: session.id },
          }),
          this.prisma.browserRuntimeSlot.deleteMany({
            where: { sessionId: session.id },
          }),
          this.prisma.browserRuntimeProfileLease.deleteMany({
            where: { sessionId: session.id },
          }),
        ]);
        continue;
      }
      const rotated = await this.rotateLease(
        session.id,
        runtimeId,
        leaseExpiresAt,
      );
      actions.push({
        action: "RESTORE",
        allowedOrigins: [],
        fencingToken: rotated.fencingToken.toString(),
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        leaseToken: rotated.leaseToken,
        profileKey: session.profileKey,
        profileMode: "PERSISTENT",
        ...(protocolMinor >= 9 && session.userBrowserProfile
          ? {
              profileRetention: {
                inactivityTtlSeconds: 2_592_000 as const,
                kind: "USER" as const,
              },
            }
          : {}),
        sessionId: session.id,
      });
    }
    return actions;
  }

  private async markUserProfileSessionIncompatible(
    sessionId: string,
    profileId: string,
  ) {
    await this.prisma.$transaction([
      this.prisma.browserRuntimeSession.update({
        data: {
          closedAt: new Date(),
          lastError: {
            code: "USER_PROFILE_PROTOCOL_INCOMPATIBLE",
            message:
              "User Browser Profiles require Runtime protocol v1.9 or newer.",
          },
          status: "LOST",
        },
        where: { id: sessionId },
      }),
      this.prisma.browserRuntimeSlot.deleteMany({ where: { sessionId } }),
      this.prisma.browserRuntimeProfileLease.deleteMany({
        where: { sessionId },
      }),
      this.prisma.userBrowserProfile.updateMany({
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
      }),
    ]);
    this.observability?.log(
      "warn",
      "runtime.user_profile.protocol_incompatible",
      { profileId, sessionId },
    );
  }

  private async rotateLease(
    sessionId: string,
    runtimeId: string,
    leaseExpiresAt: Date,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const counter = await tx.browserRuntimeFenceCounter.upsert({
          create: { runtimeId, value: 1n },
          update: { value: { increment: 1n } },
          where: { runtimeId },
        });
        const leaseToken = randomUUID();
        const session = await tx.browserRuntimeSession.update({
          data: {
            fencingToken: counter.value,
            leaseExpiresAt,
            leaseToken,
            status: "OPENING",
          },
          where: { id: sessionId },
        });
        await tx.browserRuntimeSlot.updateMany({
          data: {
            expiresAt: leaseExpiresAt,
            fencingToken: counter.value,
            leaseToken,
          },
          where: { sessionId },
        });
        await tx.browserRuntimeProfileLease.updateMany({
          data: {
            expiresAt: leaseExpiresAt,
            fencingToken: counter.value,
            leaseToken,
          },
          where: { sessionId },
        });
        return session;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async handleHeartbeat(
    socket: WebSocket,
    runtimeId: string,
    heartbeat: Extract<
      ReturnType<typeof runtimeClientMessageSchema.parse>,
      { type: "runtime.heartbeat" }
    >,
  ) {
    const leaseExpiresAt = new Date(
      Date.now() + env().RUNTIME_LEASE_SECONDS * 1000,
    );
    const closeSessions: string[] = [];
    for (const local of heartbeat.activeSessions) {
      const renewed = await this.prisma.browserRuntimeSession.updateMany({
        data: {
          leaseExpiresAt,
          status: local.state === "HUMAN_CONTROL" ? "HUMAN_CONTROL" : "ACTIVE",
        },
        where: {
          fencingToken: BigInt(local.fencingToken),
          id: local.sessionId,
          leaseToken: local.leaseToken,
          runtimeId,
          status: { in: [...ACTIVE_STATUSES] },
        },
      });
      if (renewed.count !== 1) {
        closeSessions.push(local.sessionId);
        continue;
      }
      await this.prisma.browserRuntimeSlot.updateMany({
        data: { expiresAt: leaseExpiresAt },
        where: {
          fencingToken: BigInt(local.fencingToken),
          leaseToken: local.leaseToken,
          sessionId: local.sessionId,
        },
      });
      await this.prisma.browserRuntimeProfileLease.updateMany({
        data: { expiresAt: leaseExpiresAt },
        where: {
          fencingToken: BigInt(local.fencingToken),
          leaseToken: local.leaseToken,
          sessionId: local.sessionId,
        },
      });
    }
    await this.prisma.browserRuntime.update({
      data: {
        lastSeenAt: new Date(),
        status: "ONLINE",
      },
      where: { id: runtimeId },
    });
    await this.redis.markRuntimeOnline(runtimeId);
    socket.send(
      JSON.stringify({
        closeSessions,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
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
    runtimeId: string,
    messageId: string,
    messageType:
      | "command.result"
      | "human.input.result"
      | "runtime.event"
      | "profile.lifecycle",
  ) {
    return this.hub.send(runtimeId, {
      messageId,
      messageType,
      type: "runtime.delivery.ack",
    });
  }
}
