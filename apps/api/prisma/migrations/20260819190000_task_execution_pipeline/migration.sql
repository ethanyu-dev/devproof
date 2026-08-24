BEGIN;

CREATE TYPE "TaskExecutionKind" AS ENUM (
  'ISSUE_SPEC',
  'DIRECT_RUN',
  'LEGACY_RUN'
);

CREATE TYPE "TaskExecutionLifecycle" AS ENUM (
  'QUEUED',
  'RUNNING',
  'WAITING_INPUT',
  'WAITING_HUMAN',
  'COMPLETED',
  'CANCELLED',
  'TIMED_OUT'
);

CREATE TYPE "TaskExecutionStageType" AS ENUM (
  'SPEC_ANALYSIS',
  'SPEC_EXECUTION'
);

CREATE TYPE "TaskExecutionStageStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'WAITING_INPUT',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'SKIPPED'
);

CREATE TYPE "TaskStageAttemptStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT'
);

CREATE TYPE "TaskCaseDispatchStatus" AS ENUM (
  'PENDING',
  'DISPATCHING',
  'LINKED',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE "task_executions" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "kind" "TaskExecutionKind" NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_ref" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "lifecycle" "TaskExecutionLifecycle" NOT NULL DEFAULT 'QUEUED',
  "current_stage" "TaskExecutionStageType" NOT NULL DEFAULT 'SPEC_ANALYSIS',
  "waiting_reason" TEXT,
  "execution_disposition" "ExecutionDisposition",
  "verdict" "RunProductVerdict",
  "input_snapshot" JSONB NOT NULL,
  "environment_snapshot" JSONB NOT NULL DEFAULT '{}',
  "trace_id" VARCHAR(32) NOT NULL,
  "deadline_at" TIMESTAMPTZ NOT NULL,
  "cancel_requested_at" TIMESTAMPTZ,
  "projection_needed_at" TIMESTAMPTZ,
  "projected_at" TIMESTAMPTZ,
  "legacy_specification_id" UUID,
  "migration_source" TEXT NOT NULL DEFAULT 'NATIVE',
  "source_snapshot_complete" BOOLEAN NOT NULL DEFAULT TRUE,
  "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "task_executions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_executions_trace_id_hex"
    CHECK ("trace_id" ~ '^[a-f0-9]{32}$'),
  CONSTRAINT "task_executions_verdict_requires_execution"
    CHECK ("verdict" IS NULL OR "execution_disposition" = 'EXECUTED'),
  CONSTRAINT "task_executions_nonterminal_has_no_verdict"
    CHECK ("lifecycle" IN ('COMPLETED', 'CANCELLED', 'TIMED_OUT') OR "verdict" IS NULL),
  CONSTRAINT "task_executions_cancelled_has_no_verdict"
    CHECK ("lifecycle" NOT IN ('CANCELLED', 'TIMED_OUT') OR "verdict" IS NULL)
);

CREATE TABLE "task_execution_stages" (
  "id" UUID NOT NULL,
  "task_execution_id" UUID NOT NULL,
  "type" "TaskExecutionStageType" NOT NULL,
  "status" "TaskExecutionStageStatus" NOT NULL DEFAULT 'PENDING',
  "current_attempt_number" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "waiting_reason" TEXT,
  "last_error" JSONB,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "task_execution_stages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_execution_stages_attempt_bounds"
    CHECK (
      "max_attempts" > 0
      AND "current_attempt_number" >= 0
      AND "current_attempt_number" <= "max_attempts"
    )
);

CREATE TABLE "task_stage_attempts" (
  "id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "number" INTEGER NOT NULL,
  "status" "TaskStageAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "input_snapshot" JSONB NOT NULL,
  "result" JSONB,
  "error" JSONB,
  "lease_owner" TEXT,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ,
  "fencing_token" BIGINT NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "task_stage_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_stage_attempts_number_positive" CHECK ("number" > 0),
  CONSTRAINT "task_stage_attempts_lease_complete"
    CHECK (
      (
        "lease_owner" IS NULL
        AND "lease_token" IS NULL
        AND "lease_expires_at" IS NULL
      )
      OR (
        "lease_owner" IS NOT NULL
        AND "lease_token" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL
      )
    )
);

CREATE TABLE "task_specification_snapshots" (
  "id" UUID NOT NULL,
  "task_execution_id" UUID NOT NULL,
  "stage_attempt_id" UUID NOT NULL,
  "source_hash" CHAR(64) NOT NULL,
  "generator_kind" TEXT NOT NULL,
  "generator_version" TEXT NOT NULL,
  "context" JSONB NOT NULL,
  "completeness" TEXT NOT NULL,
  "diagnostics" JSONB NOT NULL DEFAULT '[]',
  "summary" TEXT NOT NULL,
  "primary_pull_request_url" TEXT,
  "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_specification_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_specification_snapshots_source_hash_sha256"
    CHECK ("source_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "task_specification_snapshots_completeness"
    CHECK ("completeness" IN ('COMPLETE', 'PARTIAL'))
);

CREATE TABLE "task_generated_test_cases" (
  "id" UUID NOT NULL,
  "snapshot_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "definition" JSONB NOT NULL,
  "definition_hash" CHAR(64) NOT NULL,
  "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_generated_test_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_generated_test_cases_position_nonnegative"
    CHECK ("position" >= 0),
  CONSTRAINT "task_generated_test_cases_definition_hash_sha256"
    CHECK ("definition_hash" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "task_case_executions" (
  "id" UUID NOT NULL,
  "task_execution_id" UUID NOT NULL,
  "case_id" UUID NOT NULL,
  "execution_ordinal" INTEGER NOT NULL DEFAULT 1,
  "run_id" UUID,
  "dispatch_status" "TaskCaseDispatchStatus" NOT NULL DEFAULT 'PENDING',
  "dispatch_attempts" INTEGER NOT NULL DEFAULT 0,
  "dispatch_last_error" JSONB,
  "dispatch_requested_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "task_case_executions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_case_executions_ordinal_positive"
    CHECK ("execution_ordinal" > 0),
  CONSTRAINT "task_case_executions_attempts_nonnegative"
    CHECK ("dispatch_attempts" >= 0)
);

CREATE TABLE "task_execution_events" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "task_execution_id" UUID NOT NULL,
  "sequence" BIGSERIAL NOT NULL,
  "actor" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_execution_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "execution_runs"
  ADD COLUMN "task_execution_id" UUID;

CREATE UNIQUE INDEX "task_executions_team_id_idempotency_key_key"
  ON "task_executions"("team_id", "idempotency_key");
CREATE INDEX "task_executions_team_id_lifecycle_created_at_idx"
  ON "task_executions"("team_id", "lifecycle", "created_at" DESC);
CREATE INDEX "task_executions_team_id_source_kind_source_ref_idx"
  ON "task_executions"("team_id", "source_kind", "source_ref");
CREATE INDEX "task_executions_projection_needed_at_idx"
  ON "task_executions"("projection_needed_at");
CREATE INDEX "task_executions_legacy_specification_id_idx"
  ON "task_executions"("legacy_specification_id");

CREATE UNIQUE INDEX "task_execution_stages_task_execution_id_type_key"
  ON "task_execution_stages"("task_execution_id", "type");
CREATE INDEX "task_execution_stages_status_updated_at_idx"
  ON "task_execution_stages"("status", "updated_at");

CREATE UNIQUE INDEX "task_stage_attempts_stage_id_number_key"
  ON "task_stage_attempts"("stage_id", "number");
CREATE INDEX "task_stage_attempts_status_lease_expires_at_created_at_idx"
  ON "task_stage_attempts"("status", "lease_expires_at", "created_at");

CREATE UNIQUE INDEX "task_specification_snapshots_stage_attempt_id_key"
  ON "task_specification_snapshots"("stage_attempt_id");
CREATE UNIQUE INDEX "task_specification_snapshots_task_hash_generator_key"
  ON "task_specification_snapshots"(
    "task_execution_id",
    "source_hash",
    "generator_version"
  );
CREATE INDEX "task_specification_snapshots_task_generated_at_idx"
  ON "task_specification_snapshots"("task_execution_id", "generated_at" DESC);

CREATE UNIQUE INDEX "task_generated_test_cases_snapshot_id_position_key"
  ON "task_generated_test_cases"("snapshot_id", "position");
CREATE INDEX "task_generated_test_cases_snapshot_id_generated_at_idx"
  ON "task_generated_test_cases"("snapshot_id", "generated_at");

CREATE UNIQUE INDEX "task_case_executions_run_id_key"
  ON "task_case_executions"("run_id");
CREATE UNIQUE INDEX "task_case_executions_task_case_ordinal_key"
  ON "task_case_executions"(
    "task_execution_id",
    "case_id",
    "execution_ordinal"
  );
CREATE INDEX "task_case_executions_task_status_idx"
  ON "task_case_executions"("task_execution_id", "dispatch_status");
CREATE INDEX "task_case_executions_case_ordinal_idx"
  ON "task_case_executions"("case_id", "execution_ordinal");
CREATE INDEX "task_case_executions_dispatch_requested_at_idx"
  ON "task_case_executions"("dispatch_requested_at");

CREATE UNIQUE INDEX "task_execution_events_task_execution_id_sequence_key"
  ON "task_execution_events"("task_execution_id", "sequence");
CREATE INDEX "task_execution_events_team_task_sequence_idx"
  ON "task_execution_events"("team_id", "task_execution_id", "sequence");

CREATE INDEX "execution_runs_task_execution_id_lifecycle_idx"
  ON "execution_runs"("task_execution_id", "lifecycle");

ALTER TABLE "task_executions"
  ADD CONSTRAINT "task_executions_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_execution_stages"
  ADD CONSTRAINT "task_execution_stages_task_execution_id_fkey"
  FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_stage_attempts"
  ADD CONSTRAINT "task_stage_attempts_stage_id_fkey"
  FOREIGN KEY ("stage_id") REFERENCES "task_execution_stages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_specification_snapshots"
  ADD CONSTRAINT "task_specification_snapshots_task_execution_id_fkey"
  FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_specification_snapshots_stage_attempt_id_fkey"
  FOREIGN KEY ("stage_attempt_id") REFERENCES "task_stage_attempts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_generated_test_cases"
  ADD CONSTRAINT "task_generated_test_cases_snapshot_id_fkey"
  FOREIGN KEY ("snapshot_id") REFERENCES "task_specification_snapshots"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_case_executions"
  ADD CONSTRAINT "task_case_executions_task_execution_id_fkey"
  FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_case_executions_case_id_fkey"
  FOREIGN KEY ("case_id") REFERENCES "task_generated_test_cases"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_case_executions_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "execution_runs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "task_execution_events"
  ADD CONSTRAINT "task_execution_events_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_execution_events_task_execution_id_fkey"
  FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "execution_runs"
  ADD CONSTRAINT "execution_runs_task_execution_id_fkey"
  FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "protect_task_specification_snapshot"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'task specification snapshots are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_specification_snapshot_immutable"
BEFORE UPDATE ON "task_specification_snapshots"
FOR EACH ROW EXECUTE FUNCTION "protect_task_specification_snapshot"();

CREATE FUNCTION "protect_task_generated_test_case"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'task generated test cases are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_generated_test_case_immutable"
BEFORE UPDATE ON "task_generated_test_cases"
FOR EACH ROW EXECUTE FUNCTION "protect_task_generated_test_case"();

COMMIT;
