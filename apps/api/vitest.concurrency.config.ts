import { defineConfig } from "vitest/config";

/** Invoked only by the disposable-Postgres launcher, never by the default suite. */
export default defineConfig({
  envDir: false,
  test: {
    include: [
      "src/edge-cases.integration.ts",
      "src/agent-runtime/spec-lease-recovery.integration.ts",
      "src/verification/execution-concurrency.integration.ts",
      "src/verification/execution-hitl-cleanup.integration.ts",
    ],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { NODE_ENV: "test", BROWSER_ISOLATED_AUTH_ENABLED: "true" },
  },
});
