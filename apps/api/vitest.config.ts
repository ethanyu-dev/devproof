import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      CREDENTIAL_ENCRYPTION_KEY: "ci-test-encryption-key",
      DATABASE_URL:
        "postgresql://postgres:postgres@localhost:55432/devproof_test",
      FEISHU_ALLOWED_TENANT_KEY: "ci-test-tenant",
      FEISHU_APP_ID: "ci-test-app",
      FEISHU_APP_SECRET: "ci-test-secret",
      FEISHU_REDIRECT_URI: "http://localhost:4433/auth/feishu/callback",
      NODE_ENV: "test",
    },
  },
});
