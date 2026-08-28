ALTER TYPE "AgentRuntimePool" ADD VALUE IF NOT EXISTS 'POST_RUN_ANALYSIS';

CREATE TYPE "PostRunAnalysisStatus" AS ENUM (
  'PENDING_CAPTURE',
  'READY',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "ImprovementWorkItemStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

CREATE TABLE "post_run_analysis_jobs" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "task_execution_id" UUID NOT NULL,
  "analyzer_version" TEXT NOT NULL,
  "status" "PostRunAnalysisStatus" NOT NULL DEFAULT 'PENDING_CAPTURE',
  "attempt_number" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "input_storage_key" TEXT,
  "input_sha256" CHAR(64),
  "input_byte_size" INTEGER,
  "input_completeness" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB,
  "error" JSONB,
  "lease_owner" TEXT,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ,
  "fencing_token" BIGINT NOT NULL DEFAULT 0,
  "completion_id" UUID,
  "deadline_at" TIMESTAMPTZ NOT NULL,
  "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "post_run_analysis_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "post_run_analysis_events" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "analysis_id" UUID NOT NULL,
  "sequence" BIGSERIAL NOT NULL,
  "actor" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "post_run_analysis_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "improvement_work_items" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "source_task_execution_id" UUID NOT NULL,
  "analysis_id" UUID NOT NULL,
  "dedupe_key" CHAR(64) NOT NULL,
  "status" "ImprovementWorkItemStatus" NOT NULL DEFAULT 'OPEN',
  "provider" TEXT NOT NULL DEFAULT 'INTERNAL',
  "external_ref" TEXT,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "finding_count" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "improvement_work_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "analysis_findings" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "analysis_id" UUID NOT NULL,
  "work_item_id" UUID,
  "fingerprint" CHAR(64) NOT NULL,
  "category" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "title" TEXT NOT NULL,
  "root_cause" TEXT NOT NULL,
  "impact" TEXT NOT NULL,
  "recommendation" TEXT NOT NULL,
  "component" TEXT NOT NULL,
  "evidence_refs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "analysis_findings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "post_run_analysis_jobs_completion_id_key"
  ON "post_run_analysis_jobs"("completion_id");
CREATE UNIQUE INDEX "post_run_analysis_jobs_task_execution_id_analyzer_version_key"
  ON "post_run_analysis_jobs"("task_execution_id", "analyzer_version");
CREATE INDEX "post_run_analysis_jobs_team_id_status_created_at_idx"
  ON "post_run_analysis_jobs"("team_id", "status", "created_at");
CREATE INDEX "post_run_analysis_jobs_status_lease_expires_at_created_at_idx"
  ON "post_run_analysis_jobs"("status", "lease_expires_at", "created_at");

CREATE UNIQUE INDEX "post_run_analysis_events_analysis_id_sequence_key"
  ON "post_run_analysis_events"("analysis_id", "sequence");
CREATE INDEX "post_run_analysis_events_team_id_analysis_id_sequence_idx"
  ON "post_run_analysis_events"("team_id", "analysis_id", "sequence");

CREATE UNIQUE INDEX "improvement_work_items_analysis_id_key"
  ON "improvement_work_items"("analysis_id");
CREATE UNIQUE INDEX "improvement_work_items_team_id_dedupe_key_key"
  ON "improvement_work_items"("team_id", "dedupe_key");
CREATE INDEX "improvement_work_items_team_id_status_created_at_idx"
  ON "improvement_work_items"("team_id", "status", "created_at" DESC);
CREATE INDEX "improvement_work_items_source_task_execution_id_idx"
  ON "improvement_work_items"("source_task_execution_id");

CREATE UNIQUE INDEX "analysis_findings_analysis_id_fingerprint_key"
  ON "analysis_findings"("analysis_id", "fingerprint");
CREATE INDEX "analysis_findings_team_id_fingerprint_created_at_idx"
  ON "analysis_findings"("team_id", "fingerprint", "created_at");
CREATE INDEX "analysis_findings_work_item_id_idx"
  ON "analysis_findings"("work_item_id");

ALTER TABLE "post_run_analysis_jobs"
  ADD CONSTRAINT "post_run_analysis_jobs_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_run_analysis_jobs"
  ADD CONSTRAINT "post_run_analysis_jobs_task_execution_id_fkey"
  FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_run_analysis_events"
  ADD CONSTRAINT "post_run_analysis_events_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_run_analysis_events"
  ADD CONSTRAINT "post_run_analysis_events_analysis_id_fkey"
  FOREIGN KEY ("analysis_id") REFERENCES "post_run_analysis_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "improvement_work_items"
  ADD CONSTRAINT "improvement_work_items_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "improvement_work_items"
  ADD CONSTRAINT "improvement_work_items_source_task_execution_id_fkey"
  FOREIGN KEY ("source_task_execution_id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "improvement_work_items"
  ADD CONSTRAINT "improvement_work_items_analysis_id_fkey"
  FOREIGN KEY ("analysis_id") REFERENCES "post_run_analysis_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "analysis_findings"
  ADD CONSTRAINT "analysis_findings_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "analysis_findings"
  ADD CONSTRAINT "analysis_findings_analysis_id_fkey"
  FOREIGN KEY ("analysis_id") REFERENCES "post_run_analysis_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "analysis_findings"
  ADD CONSTRAINT "analysis_findings_work_item_id_fkey"
  FOREIGN KEY ("work_item_id") REFERENCES "improvement_work_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
