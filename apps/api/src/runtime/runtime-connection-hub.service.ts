import { Injectable, Logger, Optional } from "@nestjs/common";
import type { RuntimeServerMessage } from "@devproof/runtime-protocol";
import WebSocket from "ws";

import { RedisService } from "../infrastructure/redis.service.js";
import { MetricsService } from "../observability/metrics.service.js";
import { ObservabilityService } from "../observability/observability.service.js";

@Injectable()
export class RuntimeConnectionHub {
  private readonly logger = new Logger(RuntimeConnectionHub.name);
  private readonly connections = new Map<string, WebSocket>();

  constructor(
    private readonly redis: RedisService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly observability?: ObservabilityService,
  ) {
    this.redis.onRuntimeDelivery((event) => {
      if (event.kind === "DISCONNECT_OLDER_GATEWAYS") {
        if (event.exceptInstanceId !== this.redis.instanceId) {
          this.close(
            event.runtimeId,
            4001,
            "A newer gateway connection replaced this one.",
          );
        }
        return;
      }
      const parsed = event.message as RuntimeServerMessage;
      void this.sendLocal(event.runtimeId, parsed).catch((error: unknown) => {
        this.observability?.log(
          "error",
          "runtime.gateway.redis_delivery_failed",
          { messageType: parsed.type, runtimeId: event.runtimeId },
          error,
        );
      });
    });
  }

  register(runtimeId: string, socket: WebSocket) {
    const previous = this.connections.get(runtimeId);
    if (previous && previous !== socket) {
      previous.close(4001, "A newer runtime connection replaced this one.");
    }
    this.connections.set(runtimeId, socket);
    this.metrics?.setGauge(
      "devproof_runtime_gateway_connections",
      "Active Browser Runtime gateway connections on this API instance.",
      this.connections.size,
    );
  }

  unregister(runtimeId: string, socket: WebSocket) {
    if (this.connections.get(runtimeId) === socket) {
      this.connections.delete(runtimeId);
      this.metrics?.setGauge(
        "devproof_runtime_gateway_connections",
        "Active Browser Runtime gateway connections on this API instance.",
        this.connections.size,
      );
      void this.redis.removeRuntimePresence(runtimeId).catch((error: Error) => {
        this.logger.warn("Failed to clear runtime presence: " + error.message);
      });
    }
  }

  async send(runtimeId: string, message: RuntimeServerMessage) {
    if (!(await this.sendLocal(runtimeId, message))) {
      this.metrics?.increment(
        "devproof_runtime_gateway_remote_deliveries_total",
        "Runtime messages forwarded over the cross-instance Redis channel.",
        { message_type: message.type },
      );
      await this.redis.publishRuntimeDelivery({
        kind: "DELIVER",
        message,
        runtimeId,
      });
    }
  }

  async sendLocal(runtimeId: string, message: RuntimeServerMessage) {
    const socket = this.connections.get(runtimeId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
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
    this.connections.get(runtimeId)?.close(code, reason);
  }
}
