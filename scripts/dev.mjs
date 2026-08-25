import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  isProcessTreeRunning,
  signalProcessTree,
  supportsDetachedProcessTrees,
  waitForProcessTrees,
} from "./dev-process-tree.mjs";

const localEnvPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(localEnvPath)) loadEnvFile(localEnvPath);

reportDatabaseTarget();

const children = new Set();
const detached = supportsDetachedProcessTrees;
let shuttingDown = false;

function reportDatabaseTarget() {
  if (!process.env.DATABASE_URL) return;
  try {
    const database = new URL(process.env.DATABASE_URL);
    const port = database.port || "5432";
    process.stdout.write(
      `Using PostgreSQL ${database.hostname}:${port}${database.pathname}.\n`,
    );
    if (
      ["localhost", "127.0.0.1", "::1"].includes(database.hostname) &&
      port !== "55432"
    ) {
      process.stdout.write(
        "DATABASE_URL does not point to the Docker Compose PostgreSQL port 55432; this run will use a separate local database.\n",
      );
    }
  } catch {
    // The API owns full environment validation and will report malformed URLs.
  }
}

function start(packageName) {
  const child = spawn("pnpm", ["--filter", packageName, "dev"], {
    detached,
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(
      `${packageName} dev exited unexpectedly (${signal ?? code ?? "unknown"}).\n`,
    );
    void shutdown(code && code > 0 ? code : 1);
  });
  return child;
}

async function waitForApi(api) {
  const healthUrl = new URL(
    "/health",
    process.env.API_PUBLIC_URL ?? "http://localhost:4433",
  );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null || api.signalCode !== null) {
      throw new Error("DevProof API exited before becoming healthy.");
    }
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The API performs its initial TypeScript build before listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for DevProof API on port 4433.");
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  const processes = [...children];
  processes.forEach((child) => signalProcessTree(child, "SIGTERM", detached));
  await waitForProcessTrees(processes, 3_000, detached);
  processes
    .filter((child) => isProcessTreeRunning(child, detached))
    .forEach((child) => signalProcessTree(child, "SIGKILL", detached));
  process.exit(exitCode);
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

try {
  const api = start("@devproof/api");
  process.stdout.write("Waiting for the DevProof API health check…\n");
  await waitForApi(api);
  process.stdout.write(
    "DevProof API is healthy; starting Web and Agent Runtimes.\n",
  );
  const agentRuntimeToken =
    process.env.DEVPROOF_AGENT_RUNTIME_TOKEN ??
    process.env.DEVPROOF_RUNTIME_TOKEN;
  if (agentRuntimeToken) {
    start("@devproof/agent-runtime");
  } else {
    process.stdout.write(
      "Agent Runtime is disabled until DEVPROOF_AGENT_RUNTIME_TOKEN is configured.\n",
    );
  }
  start("@devproof/web");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  await shutdown(1);
}
