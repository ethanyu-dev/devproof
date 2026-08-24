-- DevProof becomes a machine-callable verification broker. Browser Runtime
-- remains the first concrete execution runner and keeps its existing tables.

CREATE TYPE "AgentRuntimeProvider" AS ENUM (
  'CODEX',
  'CLAUDE',
  'LOOPX',
  'GENERIC'
);

CREATE TYPE "VerificationRunStatus" AS ENUM (
  'QUEUED',
  'RUNNING',
  'WAITING_HUMAN',
  'PASSED',
  'FAILED',
  'INCONCLUSIVE',
  'CANCELLED',
  'TIMED_OUT'
);

CREATE TABLE "tool_credentials" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "token_hint" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expires_at" TIMESTAMPTZ,
  "last_used_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "tool_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_credentials_scopes_nonempty"
    CHECK (cardinality("scopes") > 0),
  CONSTRAINT "tool_credentials_scopes_known"
    CHECK (
      "scopes" <@ ARRAY[
        'verification:read',
        'verification:write',
        'verification:cancel'
      ]::TEXT[]
    )
);

CREATE TABLE "verification_runs" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "caller_credential_id" UUID NOT NULL,
  "status" "VerificationRunStatus" NOT NULL DEFAULT 'QUEUED',
  "goal" TEXT NOT NULL,
  "agent_provider" "AgentRuntimeProvider" NOT NULL DEFAULT 'GENERIC',
  "idempotency_key" TEXT NOT NULL,
  "request_snapshot" JSONB NOT NULL,
  "request_sha256" TEXT NOT NULL,
  "result" JSONB,
  "error" JSONB,
  "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "cancelled_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "verification_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verification_runs_request_v1"
    CHECK (
      jsonb_typeof("request_snapshot") = 'object'
      AND "request_snapshot" @> '{"schemaVersion": 1}'::JSONB
    ),
  CONSTRAINT "verification_runs_result_object"
    CHECK ("result" IS NULL OR jsonb_typeof("result") = 'object'),
  CONSTRAINT "verification_runs_error_object"
    CHECK ("error" IS NULL OR jsonb_typeof("error") = 'object')
);

CREATE UNIQUE INDEX "tool_credentials_token_hash_key"
  ON "tool_credentials"("token_hash");
CREATE UNIQUE INDEX "tool_credentials_team_id_name_key"
  ON "tool_credentials"("team_id", "name");
CREATE INDEX "tool_credentials_team_id_created_at_idx"
  ON "tool_credentials"("team_id", "created_at" DESC);
CREATE INDEX "tool_credentials_expires_at_idx"
  ON "tool_credentials"("expires_at");

CREATE UNIQUE INDEX "verification_runs_team_id_idempotency_key_key"
  ON "verification_runs"("team_id", "idempotency_key");
CREATE INDEX "verification_runs_team_id_status_created_at_idx"
  ON "verification_runs"("team_id", "status", "created_at" DESC);
CREATE INDEX "verification_runs_caller_credential_id_created_at_idx"
  ON "verification_runs"("caller_credential_id", "created_at" DESC);

ALTER TABLE "tool_credentials"
  ADD CONSTRAINT "tool_credentials_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_credentials_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "verification_runs"
  ADD CONSTRAINT "verification_runs_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "verification_runs_caller_credential_id_fkey"
  FOREIGN KEY ("caller_credential_id") REFERENCES "tool_credentials"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A queued verification captures the caller's request. Workers may only move
-- lifecycle and result fields; they cannot rewrite the goal or execution plan.
CREATE FUNCTION "protect_verification_run_request"()
RETURNS trigger AS $$
BEGIN
  IF OLD."team_id" IS DISTINCT FROM NEW."team_id"
    OR OLD."caller_credential_id" IS DISTINCT FROM NEW."caller_credential_id"
    OR OLD."goal" IS DISTINCT FROM NEW."goal"
    OR OLD."agent_provider" IS DISTINCT FROM NEW."agent_provider"
    OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
    OR OLD."request_snapshot" IS DISTINCT FROM NEW."request_snapshot"
    OR OLD."request_sha256" IS DISTINCT FROM NEW."request_sha256"
  THEN
    RAISE EXCEPTION 'verification run request is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "verification_runs_protect_request"
BEFORE UPDATE ON "verification_runs"
FOR EACH ROW EXECUTE FUNCTION "protect_verification_run_request"();
