import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runtimeConfig } from "./config.js";

const managedKeys = [
  "DEVPROOF_API_URL",
  "DEVPROOF_AGENT_RUNTIME_TOKEN",
  "DEVPROOF_AGENT_RUNTIME_POOL",
  "DEVPROOF_AGENT_MODEL_HOST_ALLOWLIST",
  "DEVPROOF_AGENT_POLL_INTERVAL_MS",
  "DEVPROOF_AGENT_TOOL_LIMIT",
  "DEVPROOF_POST_RUN_ANALYSIS_TOOL_LIMIT",
  "DEVPROOF_AGENT_WORKER_ID",
  "DEVPROOF_RUNTIME_TOKEN",
  "FLOWPROOF_POLL_INTERVAL_MS",
  "FLOWPROOF_TOOL_LIMIT",
  "FLOWPROOF_WORKER_ID",
  "NODE_ENV",
] as const;

const originalValues = new Map(
  managedKeys.map((key) => [key, process.env[key]] as const),
);

beforeEach(() => {
  for (const key of managedKeys) delete process.env[key];
});

afterEach(() => {
  for (const key of managedKeys) {
    const value = originalValues.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Agent Runtime configuration", () => {
  it("uses the Agent Runtime environment names", () => {
    process.env.DEVPROOF_AGENT_RUNTIME_TOKEN = "agent-runtime-token";
    process.env.DEVPROOF_AGENT_RUNTIME_POOL = "BROWSER_EXECUTION";
    process.env.DEVPROOF_AGENT_POLL_INTERVAL_MS = "900";
    process.env.DEVPROOF_AGENT_TOOL_LIMIT = "42";
    process.env.DEVPROOF_POST_RUN_ANALYSIS_TOOL_LIMIT = "320";
    process.env.DEVPROOF_AGENT_WORKER_ID = "agent-worker-1";
    process.env.DEVPROOF_AGENT_MODEL_HOST_ALLOWLIST = "model-gateway.internal";

    expect(runtimeConfig()).toMatchObject({
      DEVPROOF_AGENT_POLL_INTERVAL_MS: 900,
      DEVPROOF_AGENT_RUNTIME_TOKEN: "agent-runtime-token",
      DEVPROOF_AGENT_RUNTIME_POOL: "BROWSER_EXECUTION",
      DEVPROOF_AGENT_MODEL_HOST_ALLOWLIST: "model-gateway.internal",
      DEVPROOF_AGENT_TOOL_LIMIT: 42,
      DEVPROOF_POST_RUN_ANALYSIS_TOOL_LIMIT: 320,
      DEVPROOF_AGENT_WORKER_ID: "agent-worker-1",
    });
  });

  it("accepts the legacy environment names during migration", () => {
    process.env.DEVPROOF_RUNTIME_TOKEN = "legacy-runtime-token";
    process.env.DEVPROOF_AGENT_RUNTIME_POOL = "SPEC_ANALYSIS";
    process.env.FLOWPROOF_POLL_INTERVAL_MS = "800";
    process.env.FLOWPROOF_TOOL_LIMIT = "30";
    process.env.FLOWPROOF_WORKER_ID = "legacy-worker";

    expect(runtimeConfig()).toMatchObject({
      DEVPROOF_AGENT_POLL_INTERVAL_MS: 800,
      DEVPROOF_AGENT_RUNTIME_TOKEN: "legacy-runtime-token",
      DEVPROOF_AGENT_RUNTIME_POOL: "SPEC_ANALYSIS",
      DEVPROOF_AGENT_TOOL_LIMIT: 30,
      DEVPROOF_POST_RUN_ANALYSIS_TOOL_LIMIT: 64,
      DEVPROOF_AGENT_WORKER_ID: "legacy-worker",
    });
  });

  it("requires HTTPS when provider credentials cross the production control plane", () => {
    process.env.DEVPROOF_AGENT_RUNTIME_TOKEN = "agent-runtime-token";
    process.env.DEVPROOF_AGENT_RUNTIME_POOL = "BROWSER_EXECUTION";
    process.env.DEVPROOF_API_URL = "http://api.internal:4433";
    process.env.NODE_ENV = "production";

    expect(() => runtimeConfig()).toThrow(/must use HTTPS in production/u);

    process.env.DEVPROOF_API_URL = "https://api.example.com";
    expect(runtimeConfig().DEVPROOF_API_URL).toBe("https://api.example.com");
  });

  it("requires an explicit isolated Runtime pool", () => {
    process.env.DEVPROOF_AGENT_RUNTIME_TOKEN = "agent-runtime-token";

    expect(() => runtimeConfig()).toThrow(/DEVPROOF_AGENT_RUNTIME_POOL/u);
  });
});
