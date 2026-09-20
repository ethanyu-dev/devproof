import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { config } from "dotenv";
config({ path: "../../.env", quiet: true });
const require = createRequire(import.meta.url);
const { Client } = createRequire(require.resolve("@prisma/adapter-pg"))("pg");
const database = `devproof_metrics_test_${randomBytes(4).toString("hex")}`;
const base = new URL(
  process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:55432/devproof",
);
base.pathname = "/postgres";
const admin = new Client({ connectionString: base.toString() });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  base.pathname = `/${database}`;
  const env = {
    ...process.env,
    DATABASE_URL: base.toString(),
    DEVPROOF_METRICS_TEST_DATABASE_URL: base.toString(),
  };
  for (const args of [
    ["exec", "prisma", "migrate", "deploy"],
    ["exec", "vitest", "run", "src/task-executions/task-metrics.db.spec.ts"],
  ]) {
    const result = spawnSync("pnpm", args, { env, stdio: "inherit" });
    if (result.status !== 0)
      throw new Error(`Metrics database check failed (${result.status}).`);
  }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
}
