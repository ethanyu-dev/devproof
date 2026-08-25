-- Runtime credentials carry secret-bearing machine authority. Keep them out of
-- the member-managed ToolCredential namespace and invalidate legacy tokens.
DROP TABLE "agent_runtime_configurations";

UPDATE "tool_credentials"
SET
  "revoked_at" = COALESCE("revoked_at", CURRENT_TIMESTAMP),
  "scopes" = array_remove("scopes", 'runtime:lease'),
  "updated_at" = CURRENT_TIMESTAMP
WHERE 'runtime:lease' = ANY("scopes");

CREATE TABLE "agent_runtime_credentials" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "agent_runtime_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_runtime_credentials_token_hash_key"
ON "agent_runtime_credentials"("token_hash");

CREATE UNIQUE INDEX "agent_runtime_credentials_team_id_name_key"
ON "agent_runtime_credentials"("team_id", "name");

CREATE INDEX "agent_runtime_credentials_team_id_created_at_idx"
ON "agent_runtime_credentials"("team_id", "created_at" DESC);

CREATE INDEX "agent_runtime_credentials_expires_at_idx"
ON "agent_runtime_credentials"("expires_at");

ALTER TABLE "agent_runtime_credentials"
ADD CONSTRAINT "agent_runtime_credentials_team_id_fkey"
FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
