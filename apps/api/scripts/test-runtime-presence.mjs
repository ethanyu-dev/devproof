#!/usr/bin/env node
/** Exercises real presence Lua using a disposable local Redis with no TCP listener. */
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";

const api = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// macOS Unix socket paths are short; the default TMPDIR is often too long.
const temporary = await mkdtemp("/tmp/devproof-redis-presence-");
const socket = join(temporary, "redis.sock");
const redisUrl = `redis://localhost:0?path=${encodeURIComponent(socket)}`;
let redisProcess;
let testProcess;
let redisOutput = "";
let cleaned = false;

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await stop(testProcess);
  await stop(redisProcess);
  await rm(temporary, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });

try {
  const binary =
    process.env.DEVPROOF_TEST_REDIS_SERVER ?? "/opt/homebrew/bin/redis-server";
  await access(binary);
  redisProcess = spawn(
    binary,
    [
      "--port",
      "0",
      "--unixsocket",
      socket,
      "--unixsocketperm",
      "700",
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      temporary,
      "--daemonize",
      "no",
      "--pidfile",
      join(temporary, "redis.pid"),
      "--loglevel",
      "warning",
    ],
    { cwd: temporary, stdio: ["ignore", "pipe", "pipe"] },
  );
  let spawnError;
  redisProcess.once("error", (error) => {
    spawnError = error;
  });
  for (const stream of [redisProcess.stdout, redisProcess.stderr])
    stream.on("data", (data) => {
      redisOutput = (redisOutput + data).slice(-8_000);
    });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (spawnError) throw spawnError;
    if (redisProcess.exitCode !== null)
      throw new Error(`Disposable Redis exited: ${redisOutput}`);
    const probe = new Redis({
      path: socket,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 500,
      commandTimeout: 500,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    probe.on("error", () => undefined);
    try {
      await probe.connect();
      ready = (await probe.ping()) === "PONG";
    } catch {
      /* The socket may not exist during startup. */
    } finally {
      probe.disconnect();
    }
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready)
    throw new Error(`Disposable Redis did not become ready: ${redisOutput}`);
  console.log(
    "Testing Runtime presence using disposable Unix-socket Redis (port 0, persistence disabled).",
  );
  const testEnv = {
    ...process.env,
    REDIS_URL: redisUrl,
    DEVPROOF_PRESENCE_TEST_SOCKET: socket,
    CREDENTIAL_ENCRYPTION_KEY: "isolated-redis-test-key",
    DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/redis_presence_test",
    FEISHU_ALLOWED_TENANT_KEY: "isolated-test-tenant",
    FEISHU_APP_ID: "isolated-test-app",
    FEISHU_APP_SECRET: "isolated-test-secret",
    FEISHU_REDIRECT_URI: "http://127.0.0.1:1/auth/feishu/callback",
    BACKGROUND_WORKERS_ENABLED: "false",
    NODE_ENV: "test",
  };
  const result = await new Promise((done, reject) => {
    testProcess = spawn(
      process.execPath,
      [
        join(api, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "vitest.redis-presence.config.ts",
      ],
      { cwd: api, env: testEnv, stdio: "inherit" },
    );
    testProcess.once("error", reject);
    testProcess.once("exit", (code) => done(code ?? 1));
  });
  if (result !== 0)
    throw new Error(`Runtime presence integration tests exited ${result}.`);
} finally {
  await cleanup();
}
