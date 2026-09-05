import { defineConfig } from "vitest/config";

/** Only the disposable Unix-socket launcher selects this suite. */
export default defineConfig({
  envDir: false,
  test: {
    include: ["src/infrastructure/runtime-presence.integration.ts"],
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
