ALTER TABLE "github_access_configurations"
RENAME TO "github_access_credentials";

ALTER TABLE "github_access_credentials"
RENAME CONSTRAINT "github_access_configurations_pkey"
TO "github_access_credentials_pkey";

ALTER TABLE "github_access_credentials"
RENAME CONSTRAINT "github_access_configurations_team_id_fkey"
TO "github_access_credentials_team_id_fkey";

ALTER TABLE "github_access_credentials"
RENAME CONSTRAINT "github_access_configurations_configured_by_user_id_fkey"
TO "github_access_credentials_configured_by_user_id_fkey";

DROP INDEX "github_access_configurations_team_id_key";

ALTER TABLE "github_access_credentials"
ADD COLUMN "name" TEXT,
ADD COLUMN "organizations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "repositories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

UPDATE "github_access_credentials"
SET "name" = 'Default GitHub credential';

ALTER TABLE "github_access_credentials"
ALTER COLUMN "name" SET NOT NULL;

CREATE UNIQUE INDEX "github_access_credentials_team_id_name_key"
ON "github_access_credentials"("team_id", "name");

CREATE INDEX "github_access_credentials_team_id_enabled_priority_idx"
ON "github_access_credentials"("team_id", "enabled", "priority" DESC);
