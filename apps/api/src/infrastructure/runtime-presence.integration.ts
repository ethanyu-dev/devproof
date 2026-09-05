import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisService } from "./redis.service.js";
import { resetEnvForTests } from "../config/env.js";

let oldGateway: RedisService;
let newGateway: RedisService;
let inspector: Redis;
const presenceKey = (runtimeId: string) =>
  `devproof:runtime:presence:${runtimeId}`;

beforeAll(async () => {
  const socket = process.env.DEVPROOF_PRESENCE_TEST_SOCKET;
  if (
    !socket ||
    !/^\/tmp\/devproof-redis-presence-[^/]+\/redis\.sock$/.test(socket)
  )
    throw new Error(
      "Run this suite using test-runtime-presence.mjs; no existing Redis is allowed.",
    );
  if (!(await stat(socket)).isSocket())
    throw new Error("The disposable Redis Unix socket is missing.");
  const url = new URL(process.env.REDIS_URL ?? "");
  if (url.port !== "0" || url.searchParams.get("path") !== socket)
    throw new Error(
      "The Redis URL must target the launcher's disposable Unix socket.",
    );
  resetEnvForTests();
  inspector = new Redis({
    path: socket,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  await inspector.connect();
  oldGateway = new RedisService();
  newGateway = new RedisService();
  await Promise.all([oldGateway.onModuleInit(), newGateway.onModuleInit()]);
});
afterAll(async () => {
  await Promise.allSettled([
    oldGateway?.onModuleDestroy(),
    newGateway?.onModuleDestroy(),
    inspector?.quit(),
  ]);
});

describe("Runtime presence Lua against disposable real Redis", () => {
  it("runs without a TCP listener or any persistence", async () => {
    expect(await inspector.config("GET", "port")).toEqual(["port", "0"]);
    expect(await inspector.config("GET", "save")).toEqual(["save", ""]);
    expect(await inspector.config("GET", "appendonly")).toEqual([
      "appendonly",
      "no",
    ]);
  });

  it("an old gateway's delayed disconnect cannot remove newer presence", async () => {
    const runtime = randomUUID();
    await oldGateway.markRuntimeOnline(runtime, 10n);
    await newGateway.markRuntimeOnline(runtime, 11n);
    await oldGateway.removeRuntimePresence(runtime, 10n);
    expect(await inspector.get(presenceKey(runtime))).toBe(
      `11:${newGateway.instanceId}`,
    );
    expect(await newGateway.isRuntimeOnline(runtime)).toBe(true);
  });

  it("a late old heartbeat cannot overwrite the newer gateway or its expiry", async () => {
    const runtime = randomUUID();
    await newGateway.markRuntimeOnline(runtime, 101n);
    await inspector.pexpire(presenceKey(runtime), 12_000);
    await oldGateway.markRuntimeOnline(runtime, 100n);
    expect(await inspector.get(presenceKey(runtime))).toBe(
      `101:${newGateway.instanceId}`,
    );
    const ttl = await inspector.pttl(presenceKey(runtime));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(12_000);
  });

  it.each([
    [9_007_199_254_740_992n, 9_007_199_254_740_993n],
    [99_999_999_999_999_999n, 100_000_000_000_000_000n],
    [9_223_372_036_854_775_806n, 9_223_372_036_854_775_807n],
  ])(
    "preserves distinct generations %s and %s beyond floating-point precision",
    async (older, newer) => {
      const runtime = randomUUID();
      await oldGateway.markRuntimeOnline(runtime, older);
      await newGateway.markRuntimeOnline(runtime, newer);
      await oldGateway.markRuntimeOnline(runtime, older);
      await oldGateway.removeRuntimePresence(runtime, older);
      expect(await inspector.get(presenceKey(runtime))).toBe(
        `${newer}:${newGateway.instanceId}`,
      );
    },
  );

  it("a new socket on the same gateway survives the previous socket's callback", async () => {
    const runtime = randomUUID();
    await oldGateway.markRuntimeOnline(runtime, 20n);
    await oldGateway.markRuntimeOnline(runtime, 21n);
    await oldGateway.removeRuntimePresence(runtime, 20n);
    expect(await inspector.get(presenceKey(runtime))).toBe(
      `21:${oldGateway.instanceId}`,
    );
    await oldGateway.removeRuntimePresence(runtime, 21n);
    expect(await inspector.get(presenceKey(runtime))).toBeNull();
  });

  it("only the matching gateway and generation may delete presence", async () => {
    const runtime = randomUUID();
    await newGateway.markRuntimeOnline(runtime, 30n);
    await oldGateway.removeRuntimePresence(runtime, 30n);
    await newGateway.removeRuntimePresence(runtime, 29n);
    expect(await inspector.get(presenceKey(runtime))).toBe(
      `30:${newGateway.instanceId}`,
    );
    await newGateway.removeRuntimePresence(runtime, 30n);
    expect(await newGateway.isRuntimeOnline(runtime)).toBe(false);
  });

  it("concurrent delayed callbacks and heartbeat delivery converge to the newest generation", async () => {
    const runtime = randomUUID();
    await newGateway.markRuntimeOnline(runtime, 200n);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        index % 2
          ? oldGateway.markRuntimeOnline(runtime, BigInt(180 + index))
          : oldGateway.removeRuntimePresence(runtime, BigInt(180 + index)),
      ),
    );
    expect(await inspector.get(presenceKey(runtime))).toBe(
      `200:${newGateway.instanceId}`,
    );
  });
});
