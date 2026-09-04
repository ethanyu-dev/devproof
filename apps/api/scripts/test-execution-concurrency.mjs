#!/usr/bin/env node
/** Run from any directory: node apps/api/scripts/test-execution-concurrency.mjs */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const api = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suffix = randomBytes(4).toString("hex");
const name = `devproof-concurrency-test-${suffix}`;
const database = `devproof_concurrency_test_${suffix}`;
const password = randomBytes(24).toString("hex");
const temporary = await mkdtemp(join(tmpdir(), `${name}-`));
let containerStarted = false;
let cleaned = false;

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: api,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise(output.trim())
        : reject(
            new Error(
              `${command} exited ${code}${output ? `: ${output}` : ""}`,
            ),
          ),
    );
  });
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (containerStarted)
    await run("docker", ["rm", "--force", name], { capture: true }).catch(
      () => undefined,
    );
  await rm(temporary, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });

try {
  await run(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_DB=${database}`,
      "--env",
      "POSTGRES_USER=devproof_test",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "postgres:17",
    ],
    { capture: true },
  );
  containerStarted = true;
  const mapping = await run("docker", ["port", name, "5432/tcp"], {
    capture: true,
  });
  const port = /^127\.0\.0\.1:(\d+)$/u.exec(mapping)?.[1];
  if (!port)
    throw new Error("Disposable Postgres did not bind only to loopback.");
  const url = `postgresql://devproof_test:${password}@127.0.0.1:${port}/${database}`;
  const env = {
    ...process.env,
    DATABASE_URL: url,
    SHADOW_DATABASE_URL: url,
    DEVPROOF_CONCURRENCY_TEST_DATABASE_URL: url,
    BROWSER_EXECUTION_ENVIRONMENTS_JSON: "",
    NODE_ENV: "test",
  };
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      await run(
        "docker",
        ["exec", name, "pg_isready", "-U", "devproof_test", "-d", database],
        { capture: true },
      );
      ready = true;
      break;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
  }
  if (!ready) throw new Error("Disposable Postgres did not become ready.");
  const config = join(temporary, "prisma.config.ts");
  // A standalone config deliberately never imports the repository's dotenv loader.
  await writeFile(
    config,
    `export default ${JSON.stringify({ schema: join(api, "prisma/schema.prisma"), migrations: { path: join(api, "prisma/migrations") }, datasource: { url } })};\n`,
    { mode: 0o600 },
  );
  console.log(
    `Testing migration and concurrent admission using disposable ${name}.`,
  );
  await run(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--config", config],
    { env, capture: true },
  );
  console.log("All migrations applied to the disposable database.");
  await run("pnpm", ["exec", "prisma", "generate", "--config", config], {
    env,
    capture: true,
  });
  await run(
    "pnpm",
    ["exec", "vitest", "run", "--config", "vitest.concurrency.config.ts"],
    { env },
  );
} finally {
  await cleanup();
}
