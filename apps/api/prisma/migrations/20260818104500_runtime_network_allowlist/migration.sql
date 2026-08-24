ALTER TABLE "browser_runtimes"
ADD COLUMN "network_allowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
