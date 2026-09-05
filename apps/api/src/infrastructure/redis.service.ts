import { randomUUID } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Redis } from "ioredis";

import { env } from "../config/env.js";

const DELIVERY_CHANNEL = "devproof:runtime:delivery";
const AGENT_RUNTIME_REGISTRATION_TTL_MS = 15_000;

export function fairConcurrencyShare(
  totalConcurrency: number,
  workerIds: readonly string[],
  workerId: string,
) {
  const workers = [...new Set(workerIds)].sort();
  const index = workers.indexOf(workerId);
  if (index < 0 || workers.length === 0) return 0;
  const base = Math.floor(totalConcurrency / workers.length);
  const remainder = totalConcurrency % workers.length;
  return base + (index < remainder ? 1 : 0);
}

export type RuntimeBusEvent =
  | {
      kind: "DELIVER";
      message: unknown;
      runtimeId: string;
      connectionGeneration?: string;
    }
  | {
      exceptInstanceId: string;
      kind: "DISCONNECT_OLDER_GATEWAYS";
      runtimeId: string;
      connectionGeneration?: string;
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

  async disconnectOlderGateways(
    runtimeId: string,
    connectionGeneration: bigint,
  ) {
    await this.publishRuntimeDelivery({
      exceptInstanceId: this.instanceId,
      kind: "DISCONNECT_OLDER_GATEWAYS",
      runtimeId,
      connectionGeneration: connectionGeneration.toString(),
    });
  }

  async markRuntimeOnline(runtimeId: string, connectionGeneration: bigint) {
    // Decimal generations are compared without Lua floating-point truncation.
    await this.publisher.eval(
      `local previous = redis.call('GET', KEYS[1])
       if previous then
         local old = string.match(previous, '^([0-9]+):')
         if old and (#old > #ARGV[1] or (#old == #ARGV[1] and old > ARGV[1])) then return 0 end
       end
       redis.call('SET', KEYS[1], ARGV[1] .. ':' .. ARGV[2], 'EX', ARGV[3])
       return 1`,
      1,
      "devproof:runtime:presence:" + runtimeId,
      connectionGeneration.toString(),
      this.instanceId,
      Math.max(env().RUNTIME_LEASE_SECONDS, 45),
    );
  }

  async removeRuntimePresence(runtimeId: string, connectionGeneration: bigint) {
    const key = "devproof:runtime:presence:" + runtimeId;
    await this.publisher.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      1,
      key,
      `${connectionGeneration}:${this.instanceId}`,
    );
  }

  async isRuntimeOnline(runtimeId: string) {
    return (
      (await this.publisher.exists(
        "devproof:runtime:presence:" + runtimeId,
      )) === 1
    );
  }

  async assignAgentRuntimeConcurrency(
    teamId: string,
    workerId: string,
    totalConcurrency: number,
  ) {
    const key = `devproof:agent-runtime:browser-workers:${teamId}`;
    const now = Date.now();
    const expiresAt = now + AGENT_RUNTIME_REGISTRATION_TTL_MS;
    const result = await this.publisher.eval(
      [
        "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])",
        "redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])",
        "redis.call('PEXPIRE', KEYS[1], ARGV[4])",
        "return redis.call('ZRANGE', KEYS[1], 0, -1)",
      ].join("\n"),
      1,
      key,
      now,
      expiresAt,
      workerId,
      AGENT_RUNTIME_REGISTRATION_TTL_MS * 2,
    );
    const workers = Array.isArray(result)
      ? result.filter((item): item is string => typeof item === "string").sort()
      : [workerId];
    return fairConcurrencyShare(totalConcurrency, workers, workerId);
  }

  async ping() {
    return (await this.publisher.ping()) === "PONG";
  }
}
