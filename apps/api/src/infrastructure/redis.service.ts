import { randomUUID } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Redis } from "ioredis";

import { env } from "../config/env.js";

const DELIVERY_CHANNEL = "devproof:runtime:delivery";

export type RuntimeBusEvent =
  | {
      kind: "DELIVER";
      message: unknown;
      runtimeId: string;
    }
  | {
      exceptInstanceId: string;
      kind: "DISCONNECT_OLDER_GATEWAYS";
      runtimeId: string;
    };

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly instanceId = randomUUID();
  private readonly logger = new Logger(RedisService.name);
  private readonly publisher = new Redis(env().REDIS_URL, {
    commandTimeout: 3_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  private readonly subscriber = this.publisher.duplicate({
    commandTimeout: 3_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  private deliveryHandler?: (delivery: RuntimeBusEvent) => void;

  async onModuleInit() {
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe(DELIVERY_CHANNEL);
    this.subscriber.on("message", (channel: string, raw: string) => {
      if (channel !== DELIVERY_CHANNEL || !this.deliveryHandler) {
        return;
      }
      try {
        this.deliveryHandler(JSON.parse(raw) as RuntimeBusEvent);
      } catch (error) {
        this.logger.warn(
          "Ignored an invalid runtime delivery: " + (error as Error).message,
        );
      }
    });
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }

  onRuntimeDelivery(handler: (delivery: RuntimeBusEvent) => void) {
    this.deliveryHandler = handler;
  }

  async publishRuntimeDelivery(delivery: RuntimeBusEvent) {
    await this.publisher.publish(DELIVERY_CHANNEL, JSON.stringify(delivery));
  }

  async disconnectOlderGateways(runtimeId: string) {
    await this.publishRuntimeDelivery({
      exceptInstanceId: this.instanceId,
      kind: "DISCONNECT_OLDER_GATEWAYS",
      runtimeId,
    });
  }

  async markRuntimeOnline(runtimeId: string) {
    await this.publisher.set(
      "devproof:runtime:presence:" + runtimeId,
      this.instanceId,
      "EX",
      Math.max(env().RUNTIME_LEASE_SECONDS, 45),
    );
  }

  async removeRuntimePresence(runtimeId: string) {
    const key = "devproof:runtime:presence:" + runtimeId;
    const owner = await this.publisher.get(key);
    if (owner === this.instanceId) {
      await this.publisher.del(key);
    }
  }

  async isRuntimeOnline(runtimeId: string) {
    return (
      (await this.publisher.exists(
        "devproof:runtime:presence:" + runtimeId,
      )) === 1
    );
  }

  async ping() {
    return (await this.publisher.ping()) === "PONG";
  }
}
