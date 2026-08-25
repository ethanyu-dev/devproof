-- Runtime credentials carry secret-bearing machine authority. Keep them out of
-- the member-managed ToolCredential namespace and invalidate legacy tokens.
-- Keep the migration atomic for fresh upgrades. `IF EXISTS` also lets a failed
-- pre-deploy retry recover when an earlier, non-transactional attempt already
-- dropped the legacy configuration table.
BEGIN;

DROP TABLE IF EXISTS "agent_runtime_configurations";

UPDATE "tool_credentials"
SET
  "revoked_at" = COALESCE("revoked_at", CURRENT_TIMESTAMP),
  -- A legacy Runtime-only credential cannot be left with an empty scope array
  -- because tool_credentials_scopes_nonempty still protects historical rows.
  -- Runtime authentication no longer reads this table, and the row is revoked,
  -- so retaining this inert scope is safe.
  "scopes" = CASE
    WHEN cardinality(array_remove("scopes", 'runtime:lease')) > 0
      THEN array_remove("scopes", 'runtime:lease')
    ELSE "scopes"
  END,
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

COMMIT;
