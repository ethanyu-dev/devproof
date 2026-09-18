CREATE TABLE "browser_auth_snapshots" (
  "id" UUID NOT NULL,
  "profile_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "generation" INTEGER NOT NULL,
  "storage_key" TEXT NOT NULL,
  "uploaded_at" TIMESTAMPTZ,
  "checksum" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "browser_auth_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "browser_auth_snapshots_profile_id_generation_key" ON "browser_auth_snapshots"("profile_id", "generation");
CREATE UNIQUE INDEX "browser_auth_snapshots_storage_key_key" ON "browser_auth_snapshots"("storage_key");
CREATE INDEX "browser_auth_snapshots_created_at_idx" ON "browser_auth_snapshots"("created_at");
