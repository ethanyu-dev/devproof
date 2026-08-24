import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";

for (const envPath of ["../../.env", ".env"]) {
  loadDotenv({ path: envPath, override: false });
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    shadowDatabaseUrl:
      process.env.SHADOW_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:55432/devproof_shadow?schema=public",
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:55432/devproof?schema=public",
  },
});
