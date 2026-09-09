import { defineConfig } from "vitest/config";

/** Invoked only by the disposable-Postgres launcher, never by the default suite. */
export default defineConfig({
  envDir: false,
  test: {
    include: [
      "src/edge-cases.integration.ts",
      "src/agent-runtime/spec-lease-recovery.integration.ts",
      "src/browser-profiles/profile-preparation.integration.ts",
      "src/runtime/session-recovery-concurrency.integration.ts",
      "src/runtime/runtime-drain-resume.integration.ts",
      "src/verification/execution-concurrency.integration.ts",
      "src/verification/execution-hitl-cleanup.integration.ts",
    ],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      BROWSER_ISOLATED_AUTH_ENABLED: "true",
      // Existing serialization suites exercise the opt-in policy. Parallel
      // admission cases explicitly unset this to exercise the production default.
      BROWSER_EXECUTION_DATA_LOCKS_ENABLED: "true",
    },
  },
});
