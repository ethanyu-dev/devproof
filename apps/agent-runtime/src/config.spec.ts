import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runtimeConfig } from "./config.js";

const managedKeys = [
  "DEVPROOF_AGENT_RUNTIME_TOKEN",
  "DEVPROOF_AGENT_POLL_INTERVAL_MS",
  "DEVPROOF_AGENT_TOOL_LIMIT",
  "DEVPROOF_AGENT_WORKER_ID",
  "DEVPROOF_RUNTIME_TOKEN",
  "FLOWPROOF_POLL_INTERVAL_MS",
  "FLOWPROOF_TOOL_LIMIT",
  "FLOWPROOF_WORKER_ID",
  "OPENAI_API_KEY",
] as const;

const originalValues = new Map(
  managedKeys.map((key) => [key, process.env[key]] as const),
);

beforeEach(() => {
  for (const key of managedKeys) delete process.env[key];
  process.env.OPENAI_API_KEY = "test-api-key";
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
    process.env.DEVPROOF_AGENT_POLL_INTERVAL_MS = "900";
    process.env.DEVPROOF_AGENT_TOOL_LIMIT = "42";
    process.env.DEVPROOF_AGENT_WORKER_ID = "agent-worker-1";

    expect(runtimeConfig()).toMatchObject({
      DEVPROOF_AGENT_POLL_INTERVAL_MS: 900,
      DEVPROOF_AGENT_RUNTIME_TOKEN: "agent-runtime-token",
      DEVPROOF_AGENT_TOOL_LIMIT: 42,
      DEVPROOF_AGENT_WORKER_ID: "agent-worker-1",
    });
  });

  it("accepts the legacy environment names during migration", () => {
    process.env.DEVPROOF_RUNTIME_TOKEN = "legacy-runtime-token";
    process.env.FLOWPROOF_POLL_INTERVAL_MS = "800";
    process.env.FLOWPROOF_TOOL_LIMIT = "30";
    process.env.FLOWPROOF_WORKER_ID = "legacy-worker";

    expect(runtimeConfig()).toMatchObject({
      DEVPROOF_AGENT_POLL_INTERVAL_MS: 800,
      DEVPROOF_AGENT_RUNTIME_TOKEN: "legacy-runtime-token",
      DEVPROOF_AGENT_TOOL_LIMIT: 30,
      DEVPROOF_AGENT_WORKER_ID: "legacy-worker",
    });
  });
});
