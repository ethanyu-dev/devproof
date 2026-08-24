CREATE TYPE "VerificationEventActor" AS ENUM ('SYSTEM', 'AGENT', 'RUNNER', 'HUMAN', 'WORKER');
CREATE TYPE "VerificationCheckpointStatus" AS ENUM ('PENDING', 'RESOLVED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "AgentConnectorMode" AS ENUM ('EXTERNAL', 'HTTP', 'PROCESS');
CREATE TYPE "NotificationChannel" AS ENUM ('FEISHU');
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'CANCELLED');
ALTER TYPE "RuntimeCommandSource" ADD VALUE 'AGENT';

CREATE TABLE "agent_connectors" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "provider" "AgentRuntimeProvider" NOT NULL,
  "mode" "AgentConnectorMode" NOT NULL,
  "endpoint" TEXT,
  "command" TEXT,
  "args" JSONB NOT NULL DEFAULT '[]',
  "working_directory" TEXT,
  "secret_enc" TEXT,
  "secret_hint" TEXT,
  "timeout_seconds" INTEGER NOT NULL DEFAULT 1800,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "agent_connectors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_connectors_mode_config" CHECK (
    ("mode" = 'EXTERNAL') OR
    ("mode" = 'HTTP' AND "endpoint" IS NOT NULL) OR
    ("mode" = 'PROCESS' AND "command" IS NOT NULL)
  ),
  CONSTRAINT "agent_connectors_args_array" CHECK (jsonb_typeof("args") = 'array'),
  CONSTRAINT "agent_connectors_metadata_object" CHECK (jsonb_typeof("metadata") = 'object'),
  CONSTRAINT "agent_connectors_timeout_positive" CHECK ("timeout_seconds" BETWEEN 30 AND 86400)
);

ALTER TABLE "verification_runs"
  ADD COLUMN "agent_connector_id" UUID,
  ADD COLUMN "external_agent_run_id" TEXT,
  ADD COLUMN "runner_kind" TEXT NOT NULL DEFAULT 'BROWSER',
  ADD COLUMN "runner_id" UUID,
  ADD COLUMN "runtime_session_id" UUID,
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ,
  ADD COLUMN "worker_id" TEXT,
  ADD COLUMN "worker_lease_token" UUID,
  ADD COLUMN "worker_lease_expires_at" TIMESTAMPTZ;

CREATE TABLE "verification_events" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "sequence" BIGSERIAL NOT NULL,
  "actor" "VerificationEventActor" NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verification_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verification_events_payload_object" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "verification_events_kind_format" CHECK ("kind" ~ '^[a-z][a-z0-9_.-]+$')
);

CREATE TABLE "verification_artifacts" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "event_id" UUID,
  "runtime_artifact_id" UUID,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "storage_key" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verification_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verification_artifacts_metadata_object" CHECK (jsonb_typeof("metadata") = 'object')
);

CREATE TABLE "verification_checkpoints" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "status" "VerificationCheckpointStatus" NOT NULL DEFAULT 'PENDING',
  "prompt" TEXT NOT NULL,
  "context" JSONB NOT NULL DEFAULT '{}',
  "response_schema" JSONB NOT NULL DEFAULT '{}',
  "response" JSONB,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "resolved_by_user_id" UUID,
  "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ,
  CONSTRAINT "verification_checkpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verification_checkpoints_context_object" CHECK (jsonb_typeof("context") = 'object'),
  CONSTRAINT "verification_checkpoints_schema_object" CHECK (jsonb_typeof("response_schema") = 'object'),
  CONSTRAINT "verification_checkpoints_response_object" CHECK ("response" IS NULL OR jsonb_typeof("response") = 'object')
);

CREATE TABLE "notification_outbox" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "checkpoint_id" UUID,
  "channel" "NotificationChannel" NOT NULL DEFAULT 'FEISHU',
  "event_type" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ,
  "last_error" TEXT,
  "delivered_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_outbox_payload_object" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "notification_outbox_attempts_nonnegative" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "agent_connectors_team_id_name_key" ON "agent_connectors"("team_id", "name");
CREATE INDEX "agent_connectors_team_id_provider_enabled_idx" ON "agent_connectors"("team_id", "provider", "enabled");
CREATE UNIQUE INDEX "verification_events_run_id_sequence_key" ON "verification_events"("run_id", "sequence");
CREATE INDEX "verification_events_team_id_run_id_sequence_idx" ON "verification_events"("team_id", "run_id", "sequence");
CREATE UNIQUE INDEX "verification_artifacts_run_id_runtime_artifact_id_key" ON "verification_artifacts"("run_id", "runtime_artifact_id");
CREATE INDEX "verification_artifacts_team_id_run_id_created_at_idx" ON "verification_artifacts"("team_id", "run_id", "created_at");
CREATE INDEX "verification_artifacts_event_id_idx" ON "verification_artifacts"("event_id");
CREATE INDEX "verification_checkpoints_team_id_run_id_status_idx" ON "verification_checkpoints"("team_id", "run_id", "status");
CREATE INDEX "verification_checkpoints_status_expires_at_idx" ON "verification_checkpoints"("status", "expires_at");
CREATE UNIQUE INDEX "verification_checkpoints_one_pending_per_run_key" ON "verification_checkpoints"("run_id") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "notification_outbox_dedupe_key_key" ON "notification_outbox"("dedupe_key");
CREATE INDEX "notification_outbox_status_next_attempt_at_lease_expires_at_idx" ON "notification_outbox"("status", "next_attempt_at", "lease_expires_at");
CREATE INDEX "notification_outbox_team_id_created_at_idx" ON "notification_outbox"("team_id", "created_at" DESC);
CREATE INDEX "verification_runs_status_next_attempt_at_worker_lease_expir_idx" ON "verification_runs"("status", "next_attempt_at", "worker_lease_expires_at");
CREATE INDEX "verification_runs_agent_connector_id_created_at_idx" ON "verification_runs"("agent_connector_id", "created_at" DESC);
CREATE INDEX "verification_runs_runtime_session_id_idx" ON "verification_runs"("runtime_session_id");

ALTER TABLE "agent_connectors" ADD CONSTRAINT "agent_connectors_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_agent_connector_id_fkey" FOREIGN KEY ("agent_connector_id") REFERENCES "agent_connectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_runtime_session_id_fkey" FOREIGN KEY ("runtime_session_id") REFERENCES "browser_runtime_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "verification_events" ADD CONSTRAINT "verification_events_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verification_events" ADD CONSTRAINT "verification_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "verification_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verification_artifacts" ADD CONSTRAINT "verification_artifacts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verification_artifacts" ADD CONSTRAINT "verification_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "verification_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verification_artifacts" ADD CONSTRAINT "verification_artifacts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "verification_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "verification_artifacts" ADD CONSTRAINT "verification_artifacts_runtime_artifact_id_fkey" FOREIGN KEY ("runtime_artifact_id") REFERENCES "browser_runtime_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "verification_checkpoints" ADD CONSTRAINT "verification_checkpoints_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verification_checkpoints" ADD CONSTRAINT "verification_checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "verification_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verification_checkpoints" ADD CONSTRAINT "verification_checkpoints_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "verification_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_checkpoint_id_fkey" FOREIGN KEY ("checkpoint_id") REFERENCES "verification_checkpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "enforce_verification_run_lifecycle"()
RETURNS trigger AS $$
DECLARE
  allowed BOOLEAN := false;
BEGIN
  IF OLD."status" = NEW."status" THEN
    IF OLD."status" IN ('PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED', 'TIMED_OUT')
      AND (
        OLD."result" IS DISTINCT FROM NEW."result"
        OR OLD."error" IS DISTINCT FROM NEW."error"
        OR OLD."finished_at" IS DISTINCT FROM NEW."finished_at"
        OR OLD."cancelled_at" IS DISTINCT FROM NEW."cancelled_at"
      )
    THEN
      RAISE EXCEPTION 'terminal verification outcome is immutable';
    END IF;
    RETURN NEW;
  END IF;
  allowed := CASE OLD."status"
    WHEN 'QUEUED' THEN NEW."status" IN ('RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT')
    WHEN 'RUNNING' THEN NEW."status" IN ('QUEUED', 'WAITING_HUMAN', 'PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED', 'TIMED_OUT')
    WHEN 'WAITING_HUMAN' THEN NEW."status" IN ('RUNNING', 'PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED', 'TIMED_OUT')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid verification lifecycle transition: % -> %', OLD."status", NEW."status";
  END IF;
  IF NEW."status" IN ('PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED', 'TIMED_OUT') AND NEW."finished_at" IS NULL THEN
    RAISE EXCEPTION 'terminal verification state requires finished_at';
  END IF;
  IF NEW."status" IN ('PASSED', 'FAILED', 'INCONCLUSIVE') AND NEW."result" IS NULL THEN
    RAISE EXCEPTION 'verification verdict state requires result';
  END IF;
  IF NEW."status" IN ('PASSED', 'FAILED', 'INCONCLUSIVE')
    AND NEW."result"->>'verdict' IS DISTINCT FROM NEW."status"::TEXT
  THEN
    RAISE EXCEPTION 'verification result verdict must match lifecycle status';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "verification_runs_enforce_lifecycle"
BEFORE UPDATE ON "verification_runs"
FOR EACH ROW EXECUTE FUNCTION "enforce_verification_run_lifecycle"();

CREATE FUNCTION "protect_verification_event_append_only"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'verification events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "verification_events_append_only"
BEFORE UPDATE OR DELETE ON "verification_events"
FOR EACH ROW EXECUTE FUNCTION "protect_verification_event_append_only"();
