import { Injectable, Logger, Optional } from "@nestjs/common";
import type { RuntimeServerMessage } from "@devproof/runtime-protocol";
import WebSocket from "ws";

import { RedisService } from "../infrastructure/redis.service.js";
import { MetricsService } from "../observability/metrics.service.js";
import { ObservabilityService } from "../observability/observability.service.js";
import { PrismaService } from "../database/prisma.service.js";

@Injectable()
export class RuntimeConnectionHub {
  private readonly logger = new Logger(RuntimeConnectionHub.name);
  private readonly connections = new Map<
    string,
    { socket: WebSocket; generation: bigint }
  >();

  constructor(
    private readonly redis: RedisService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly observability?: ObservabilityService,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    this.redis.onRuntimeDelivery((event) => {
      if (event.kind === "DISCONNECT_OLDER_GATEWAYS") {
        const current = this.connections.get(event.runtimeId);
        const generation = parseGeneration(event.connectionGeneration);
        if (
          current &&
          generation !== undefined &&
          current.generation < generation
        )
          current.socket.close(
            4001,
            "A newer gateway connection replaced this one.",
          );
        return;
      }
      const parsed = event.message as RuntimeServerMessage;
      void this.sendLocal(
        event.runtimeId,
        parsed,
        parseGeneration(event.connectionGeneration),
      ).catch((error: unknown) => {
        this.observability?.log(
          "error",
          "runtime.gateway.redis_delivery_failed",
          { messageType: parsed.type, runtimeId: event.runtimeId },
          error,
        );
      });
    });
  }

  register(runtimeId: string, socket: WebSocket, generation: bigint) {
    const previous = this.connections.get(runtimeId);
    if (
      previous &&
      previous.generation >= generation &&
      previous.socket !== socket
    ) {
      socket.close(
        4001,
        "A newer runtime connection already owns this gateway.",
      );
      return;
    }
    this.connections.set(runtimeId, { socket, generation });
    if (previous && previous.socket !== socket) {
      previous.socket.close(
        4001,
        "A newer runtime connection replaced this one.",
      );
    }
    this.metrics?.setGauge(
      "devproof_runtime_gateway_connections",
      "Active Browser Runtime gateway connections on this API instance.",
      this.connections.size,
    );
  }

  unregister(runtimeId: string, socket: WebSocket) {
    const current = this.connections.get(runtimeId);
    if (current?.socket === socket) {
      this.connections.delete(runtimeId);
      this.metrics?.setGauge(
        "devproof_runtime_gateway_connections",
        "Active Browser Runtime gateway connections on this API instance.",
        this.connections.size,
      );
      void this.redis
        .removeRuntimePresence(runtimeId, current.generation)
        .catch((error: Error) => {
          this.logger.warn(
            "Failed to clear runtime presence: " + error.message,
          );
        });
      return true;
    }
    return false;
  }

  async send(
    runtimeId: string,
    message: RuntimeServerMessage,
    generation?: bigint,
  ) {
    if (generation === undefined) {
      const runtime = await this.prisma?.browserRuntime.findUnique({
        where: { id: runtimeId },
        select: { connectionGeneration: true },
      });
      generation = this.prisma
        ? runtime?.connectionGeneration
        : this.connections.get(runtimeId)?.generation;
    }
    if (generation === undefined) return;
    if (!(await this.sendLocal(runtimeId, message, generation))) {
      this.metrics?.increment(
        "devproof_runtime_gateway_remote_deliveries_total",
        "Runtime messages forwarded over the cross-instance Redis channel.",
        { message_type: message.type },
      );
      await this.redis.publishRuntimeDelivery({
        kind: "DELIVER",
        message,
        runtimeId,
        connectionGeneration: generation.toString(),
      });
    }
  }

  async sendLocal(
    runtimeId: string,
    message: RuntimeServerMessage,
    generation?: bigint,
  ) {
    const connection = this.connections.get(runtimeId);
    if (
      !connection ||
      connection.generation !== generation ||
      connection.socket.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    const { socket } = connection;
    const error = await new Promise<Error | undefined>((resolve) => {
      try {
        socket.send(JSON.stringify(message), (sendError) => resolve(sendError));
      } catch (sendError) {
        resolve(
          sendError instanceof Error ? sendError : new Error(String(sendError)),
        );
      }
    });
    if (error) {
      this.metrics?.increment(
        "devproof_runtime_gateway_send_failures_total",
        "Runtime WebSocket send failures.",
        { message_type: message.type },
      );
      this.observability?.log(
        "error",
        "runtime.gateway.send_failed",
        { messageType: message.type, runtimeId },
        error,
      );
      return false;
    }
    return true;
  }

  close(runtimeId: string, code: number, reason: string) {
    this.connections.get(runtimeId)?.socket.close(code, reason);
  }
}

function parseGeneration(value?: string): bigint | undefined {
  return value && /^\d{1,30}$/.test(value) ? BigInt(value) : undefined;
}
