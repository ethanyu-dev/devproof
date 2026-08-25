import { z } from "zod";
import { config as loadDotenv } from "dotenv";

for (const envPath of ["../../.env", ".env"]) {
  loadDotenv({ path: envPath, override: false, quiet: true });
}

const envSchema = z
  .object({
    API_PORT: z.coerce.number().int().positive().default(4433),
    API_PUBLIC_URL: z.string().url().default("http://localhost:4433"),
    AGENT_RESUME_WEBHOOK_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32).optional(),
    ),
    AGENT_RESUME_WEBHOOK_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional(),
    ),
    BROWSER_RUNTIME_API_URL: z.string().url().optional(),
    CREDENTIAL_ENCRYPTION_KEY: z.string().min(1),
    DATABASE_URL: z.string().url(),
    FEISHU_ALLOWED_TENANT_KEY: z.string().min(1),
    FEISHU_APP_ID: z.string().min(1),
    FEISHU_APP_SECRET: z.string().min(1),
    FEISHU_BOT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    FEISHU_BOT_OPEN_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    FEISHU_EVENT_ENCRYPT_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    FEISHU_EVENT_VERIFICATION_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    FEISHU_REDIRECT_URI: z.string().url(),
    FEISHU_NOTIFICATION_WEBHOOK_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    FEISHU_NOTIFICATION_WEBHOOK_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional(),
    ),
    GITHUB_API_URL: z.string().url().default("https://api.github.com"),
    GITHUB_API_VERSION: z.string().min(1).default("2022-11-28"),
    KNOWLEDGE_MCP_BEARER_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    KNOWLEDGE_MCP_STATIC_ARGUMENTS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    KNOWLEDGE_MCP_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(15_000),
    KNOWLEDGE_MCP_TOOL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    KNOWLEDGE_MCP_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional(),
    ),
    LINEAR_MCP_BEARER_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    LINEAR_MCP_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(15_000),
    LINEAR_MCP_TOOL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    LINEAR_MCP_URL: z
      .string()
      .url()
      .default("https://mcp.linear.app/mcp/readonly"),
    LINEAR_API_AUTH_MODE: z
      .enum(["PERSONAL_API_KEY", "OAUTH"])
      .default("PERSONAL_API_KEY"),
    LINEAR_API_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    LINEAR_API_URL: z.string().url().default("https://api.linear.app/graphql"),
    LINEAR_WORKSPACE_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().min(1).max(200).optional(),
    ),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(168),
    SPEC_ANALYSIS_MODE: z
      .enum(["DETERMINISTIC", "AGENT", "SHADOW"])
      .default("AGENT"),
    REDIS_URL: z
      .string()
      .url()
      .default("redis://:devproof-local-redis@localhost:56379/0"),
    RUNTIME_COMMAND_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(300)
      .default(30),
    RUNTIME_GATEWAY_WS_URL: z
      .string()
      .url()
      .default("ws://localhost:4433/runtime/connect"),
    RUNTIME_LEASE_SECONDS: z.coerce.number().int().min(30).max(300).default(60),
    AGENT_RUNTIME_TASK_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(300)
      .default(60),
    EXECUTION_WAIT_QUEUE_CAPACITY: z.coerce
      .number()
      .int()
      .min(0)
      .max(10_000)
      .default(100),
    OBJECT_STORAGE_ACCESS_KEY: z
      .string()
      .min(1)
      .default("devproof-local-access"),
    OBJECT_STORAGE_BUCKET: z
      .string()
      .min(3)
      .max(63)
      .default("devproof-artifacts"),
    OBJECT_STORAGE_ENDPOINT: z.string().url().default("http://localhost:59000"),
    OBJECT_STORAGE_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    OBJECT_STORAGE_REGION: z.string().min(1).default("us-east-1"),
    OBJECT_STORAGE_SECRET_KEY: z
      .string()
      .min(1)
      .default("devproof-local-secret-key"),
    TEAM_NAME: z.string().trim().min(1).default("DevProof Team"),
    BACKGROUND_WORKERS_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    BACKGROUND_WORKER_POLL_MS: z.coerce
      .number()
      .int()
      .min(250)
      .max(60000)
      .default(2000),
    AUDIT_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(30)
      .max(3650)
      .default(365),
    OBSERVABILITY_LOG_LEVEL: z
      .enum(["debug", "info", "warn", "error"])
      .default("info"),
    OBSERVABILITY_METRICS_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32).optional(),
    ),
    RUNTIME_DATA_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .default(30),
    TOOL_INVOCATION_STALE_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(86400)
      .default(1800),
    TOOL_INVOCATION_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .default(90),
    WEB_ORIGIN: z.string().url().default("http://localhost:3344"),
  })
  .superRefine((value, context) => {
    if (
      value.FEISHU_BOT_ENABLED &&
      (!value.FEISHU_BOT_OPEN_ID ||
        !value.FEISHU_EVENT_ENCRYPT_KEY ||
        !value.FEISHU_EVENT_VERIFICATION_TOKEN)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "FEISHU_BOT_OPEN_ID, FEISHU_EVENT_ENCRYPT_KEY, and FEISHU_EVENT_VERIFICATION_TOKEN are required when FEISHU_BOT_ENABLED=true.",
        path: ["FEISHU_BOT_ENABLED"],
      });
    }
    if (
      Boolean(value.AGENT_RESUME_WEBHOOK_URL) !==
      Boolean(value.AGENT_RESUME_WEBHOOK_SECRET)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "AGENT_RESUME_WEBHOOK_URL and AGENT_RESUME_WEBHOOK_SECRET must be configured together.",
        path: ["AGENT_RESUME_WEBHOOK_URL"],
      });
    }
    if (
      value.NODE_ENV === "production" &&
      value.KNOWLEDGE_MCP_URL &&
      new URL(value.KNOWLEDGE_MCP_URL).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        message: "KNOWLEDGE_MCP_URL must use HTTPS in production.",
        path: ["KNOWLEDGE_MCP_URL"],
      });
    }
    if (
      value.NODE_ENV === "production" &&
      new URL(value.LINEAR_MCP_URL).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        message: "LINEAR_MCP_URL must use HTTPS in production.",
        path: ["LINEAR_MCP_URL"],
      });
    }
    if (
      value.NODE_ENV === "production" &&
      new URL(value.LINEAR_API_URL).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        message: "LINEAR_API_URL must use HTTPS in production.",
        path: ["LINEAR_API_URL"],
      });
    }
    if (
      value.NODE_ENV === "production" &&
      new URL(value.GITHUB_API_URL).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        message: "GITHUB_API_URL must use HTTPS in production.",
        path: ["GITHUB_API_URL"],
      });
    }
    if (value.NODE_ENV === "production" && !value.OBSERVABILITY_METRICS_TOKEN) {
      context.addIssue({
        code: "custom",
        message:
          "OBSERVABILITY_METRICS_TOKEN is required in production so metrics cannot be exposed anonymously or silently disabled.",
        path: ["OBSERVABILITY_METRICS_TOKEN"],
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | undefined;

export function env(): AppEnv {
  cached ??= envSchema.parse({
    ...process.env,
    API_PORT: process.env.API_PORT ?? process.env.PORT,
  });
  return cached;
}

export function resetEnvForTests() {
  cached = undefined;
}
