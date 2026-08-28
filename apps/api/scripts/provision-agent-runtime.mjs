import { createHash, randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { config as loadDotenv } from "dotenv";

for (const envPath of ["../../.env", ".env"]) {
  loadDotenv({ path: envPath, override: false, quiet: true });
}

const options = parseOptions(process.argv.slice(2));
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
const token = `dvp_rt_${randomBytes(32).toString("base64url")}`;
const tokenHash = createHash("sha256").update(token).digest("hex");

try {
  const team = await prisma.team.findUnique({ where: { slug: options.team } });
  if (!team) throw new Error(`Team slug was not found: ${options.team}`);

  await prisma.$transaction([
    prisma.toolCredential.updateMany({
      data: {
        // Historical credentials must keep a non-empty scope array. Revocation
        // and the separate AgentRuntimeCredential lookup remove their authority.
        revokedAt: new Date(),
      },
      where: { scopes: { has: "runtime:lease" }, teamId: team.id },
    }),
    prisma.agentRuntimeCredential.updateMany({
      data: { revokedAt: new Date() },
      where: { pool: "MIXED", revokedAt: null, teamId: team.id },
    }),
    prisma.agentRuntimeCredential.upsert({
      create: {
        name: options.name,
        pool: options.pool,
        teamId: team.id,
        tokenHash,
        tokenHint: `dvp_rt_••••${token.slice(-4)}`,
      },
      update: {
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        pool: options.pool,
        tokenHash,
        tokenHint: `dvp_rt_••••${token.slice(-4)}`,
      },
      where: {
        teamId_name: { name: options.name, teamId: team.id },
      },
    }),
  ]);

  process.stdout.write(
    [
      `Agent Runtime ${options.pool} credential provisioned for team ${team.slug}.`,
      "The plaintext token is shown once; store it in the Runtime deployment:",
      `DEVPROOF_AGENT_RUNTIME_TOKEN=${token}`,
    ].join("\n") + "\n",
  );
} finally {
  await prisma.$disconnect();
}

function parseOptions(args) {
  args = args.filter((argument) => argument !== "--");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(
        "Usage: pnpm runtime:provision -- --team <slug> --pool <SPEC_ANALYSIS|BROWSER_EXECUTION|POST_RUN_ANALYSIS> [--name <name>]",
      );
    }
    values.set(key.slice(2), value.trim());
  }
  for (const key of values.keys()) {
    if (!["name", "pool", "team"].includes(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
  }
  const team = values.get("team");
  const pool = values.get("pool");
  if (
    !pool ||
    !["SPEC_ANALYSIS", "BROWSER_EXECUTION", "POST_RUN_ANALYSIS"].includes(pool)
  ) {
    throw new Error(
      "--pool must be SPEC_ANALYSIS, BROWSER_EXECUTION, or POST_RUN_ANALYSIS.",
    );
  }
  const name =
    values.get("name") ??
    (pool === "SPEC_ANALYSIS"
      ? "Spec Analysis Runtime"
      : pool === "POST_RUN_ANALYSIS"
        ? "Post-run Analysis Runtime"
        : "Browser Execution Runtime");
  if (!team || !name) {
    throw new Error(
      "Usage: pnpm runtime:provision -- --team <slug> --pool <SPEC_ANALYSIS|BROWSER_EXECUTION|POST_RUN_ANALYSIS> [--name <name>]",
    );
  }
  return { name, pool, team };
}
