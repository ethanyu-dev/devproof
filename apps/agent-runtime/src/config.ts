import { config as loadDotenv } from "dotenv";
import { z } from "zod";

for (const envPath of ["../../.env", ".env"]) {
  loadDotenv({ path: envPath, override: false, quiet: true });
}

const configSchema = z
  .object({
    DEVPROOF_API_URL: z.string().url().default("http://localhost:4433"),
    DEVPROOF_AGENT_RUNTIME_TOKEN: z.string().min(16),
    DEVPROOF_AGENT_MODEL_HOST_ALLOWLIST: z.string().default(""),
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
    DEVPROOF_POST_RUN_ANALYSIS_TOOL_LIMIT: z.coerce
      .number()
      .int()
      .min(10)
      .max(1_000)
      .default(64),
    DEVPROOF_AGENT_WORKER_ID: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .default(`agent-runtime-${process.pid}`),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  })
  .superRefine((value, context) => {
    if (
      value.NODE_ENV === "production" &&
      new URL(value.DEVPROOF_API_URL).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "DEVPROOF_API_URL must use HTTPS in production because model credentials cross this connection.",
        path: ["DEVPROOF_API_URL"],
      });
    }
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
