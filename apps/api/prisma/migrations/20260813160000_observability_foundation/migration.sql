CREATE TYPE "ToolInvocationStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');
CREATE TYPE "VerificationTraceStatus" AS ENUM ('INFO', 'STARTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

ALTER TABLE "verification_runs"
  ADD COLUMN "trace_id" VARCHAR(32),
  ADD COLUMN "retention_until" TIMESTAMPTZ,
  ADD COLUMN "purged_at" TIMESTAMPTZ;

UPDATE "verification_runs"
SET
  "trace_id" = md5("id"::text || "created_at"::text),
  "retention_until" = COALESCE("finished_at", "created_at") +
    CASE
      WHEN "request_snapshot" #>> '{evidencePolicy,retentionDays}' ~ '^[0-9]+$'
      THEN ("request_snapshot" #>> '{evidencePolicy,retentionDays}')::INTEGER * INTERVAL '1 day'
      ELSE INTERVAL '90 days'
    END;

ALTER TABLE "verification_runs"
  ALTER COLUMN "trace_id" SET NOT NULL,
  ALTER COLUMN "retention_until" SET NOT NULL;

CREATE INDEX "verification_runs_retention_until_purged_at_idx"
  ON "verification_runs"("retention_until", "purged_at");

CREATE TABLE "tool_invocations" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "credential_id" UUID NOT NULL,
  "run_id" UUID,
  "transport" TEXT NOT NULL,
  "tool_name" TEXT NOT NULL,
  "status" "ToolInvocationStatus" NOT NULL DEFAULT 'STARTED',
  "request_id" TEXT NOT NULL,
  "mcp_request_id" TEXT,
  "trace_id" VARCHAR(32) NOT NULL,
  "span_id" VARCHAR(16) NOT NULL,
  "client_name" TEXT,
  "client_version" TEXT,
  "input_summary" JSONB NOT NULL DEFAULT '{}',
  "output_summary" JSONB,
  "error_code" TEXT,
  "error_message" TEXT,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ,
  "duration_ms" INTEGER,
  CONSTRAINT "tool_invocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_invocations_duration_nonnegative" CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0)
);

CREATE INDEX "tool_invocations_team_id_started_at_idx" ON "tool_invocations"("team_id", "started_at" DESC);
CREATE INDEX "tool_invocations_run_id_started_at_idx" ON "tool_invocations"("run_id", "started_at");
CREATE INDEX "tool_invocations_credential_id_started_at_idx" ON "tool_invocations"("credential_id", "started_at" DESC);
CREATE INDEX "tool_invocations_tool_name_status_started_at_idx" ON "tool_invocations"("tool_name", "status", "started_at");
CREATE INDEX "tool_invocations_trace_id_started_at_idx" ON "tool_invocations"("trace_id", "started_at");

ALTER TABLE "tool_invocations"
  ADD CONSTRAINT "tool_invocations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "tool_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "verification_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "verification_events"
  ADD COLUMN "status" "VerificationTraceStatus" NOT NULL DEFAULT 'INFO',
  ADD COLUMN "duration_ms" INTEGER,
  ADD COLUMN "error_code" TEXT,
  ADD COLUMN "error_message" TEXT,
  ADD COLUMN "request_id" TEXT,
  ADD COLUMN "trace_id" VARCHAR(32),
  ADD COLUMN "span_id" VARCHAR(16),
  ADD COLUMN "credential_id" UUID,
  ADD COLUMN "tool_invocation_id" UUID,
  ADD COLUMN "runtime_command_id" UUID,
  ADD CONSTRAINT "verification_events_duration_nonnegative" CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0),
  ADD CONSTRAINT "verification_events_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "tool_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "verification_events_tool_invocation_id_fkey" FOREIGN KEY ("tool_invocation_id") REFERENCES "tool_invocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "verification_events_trace_id_occurred_at_idx" ON "verification_events"("trace_id", "occurred_at");
CREATE INDEX "verification_events_credential_id_occurred_at_idx" ON "verification_events"("credential_id", "occurred_at");
CREATE INDEX "verification_events_tool_invocation_id_idx" ON "verification_events"("tool_invocation_id");
CREATE INDEX "verification_events_runtime_command_id_idx" ON "verification_events"("runtime_command_id");

CREATE OR REPLACE FUNCTION "protect_verification_event_append_only"()
RETURNS trigger AS $$
BEGIN
  IF current_setting('devproof.retention_purge', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'verification events are append-only';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
