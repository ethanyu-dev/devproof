ALTER TABLE "browser_runtime_profile_leases"
  ADD COLUMN "team_id" UUID;

UPDATE "browser_runtime_profile_leases" AS lease
SET "team_id" = session."team_id"
FROM "browser_runtime_sessions" AS session
WHERE session."id" = lease."session_id";

ALTER TABLE "browser_runtime_profile_leases"
  ALTER COLUMN "team_id" SET NOT NULL;

DROP INDEX "browser_runtime_profile_leases_runtime_id_profile_key_key";

CREATE UNIQUE INDEX "browser_runtime_profile_leases_team_id_profile_key_key"
  ON "browser_runtime_profile_leases"("team_id", "profile_key");

CREATE INDEX "browser_runtime_profile_leases_runtime_id_profile_key_idx"
  ON "browser_runtime_profile_leases"("runtime_id", "profile_key");

ALTER TABLE "browser_runtime_profile_leases"
  ADD CONSTRAINT "browser_runtime_profile_leases_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
