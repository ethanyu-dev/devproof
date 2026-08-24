import { config as loadDotenv } from "dotenv";
import { z } from "zod";

for (const envPath of ["../../.env", ".env"]) {
  loadDotenv({ path: envPath, override: false, quiet: true });
}

const configSchema = z.object({
  DEVPROOF_API_URL: z.string().url().default("http://localhost:4433"),
  DEVPROOF_AGENT_RUNTIME_TOKEN: z.string().min(16),
  DEVPROOF_AGENT_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(10_000)
    .default(750),
  DEVPROOF_AGENT_TOOL_LIMIT: z.coerce
    .number()
    .int()
    .min(5)
    .max(200)
    .default(60),
  DEVPROOF_AGENT_WORKER_ID: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .default(`agent-runtime-${process.pid}`),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-5.4"),
});

export type RuntimeConfig = z.infer<typeof configSchema>;

export function runtimeConfig(): RuntimeConfig {
  return configSchema.parse({
    ...process.env,
    DEVPROOF_AGENT_POLL_INTERVAL_MS:
      process.env.DEVPROOF_AGENT_POLL_INTERVAL_MS ??
      process.env.FLOWPROOF_POLL_INTERVAL_MS,
    DEVPROOF_AGENT_RUNTIME_TOKEN:
      process.env.DEVPROOF_AGENT_RUNTIME_TOKEN ??
      process.env.DEVPROOF_RUNTIME_TOKEN,
    DEVPROOF_AGENT_TOOL_LIMIT:
      process.env.DEVPROOF_AGENT_TOOL_LIMIT ?? process.env.FLOWPROOF_TOOL_LIMIT,
    DEVPROOF_AGENT_WORKER_ID:
      process.env.DEVPROOF_AGENT_WORKER_ID ?? process.env.FLOWPROOF_WORKER_ID,
  });
}
