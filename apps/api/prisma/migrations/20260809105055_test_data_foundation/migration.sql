-- CreateEnum
CREATE TYPE "TestProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TestCaseStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TestRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_HUMAN', 'PASSED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "TestRunTrigger" AS ENUM ('MANUAL', 'CI', 'REPLAY');

-- CreateEnum
CREATE TYPE "TestTraceActor" AS ENUM ('SYSTEM', 'BROWSER', 'HUMAN');

-- CreateEnum
CREATE TYPE "TestTraceStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TestRunCheckpointStatus" AS ENUM ('PENDING', 'RESOLVED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "test_projects" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "TestProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "test_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_environments" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "secrets_enc" TEXT,
    "secret_keys" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "test_environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "TestCaseStatus" NOT NULL DEFAULT 'DRAFT',
    "latest_version_number" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_case_versions" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "definition_sha256" TEXT NOT NULL,
    "change_summary" TEXT NOT NULL DEFAULT '',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_case_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_runs" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "case_version_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "runtime_session_id" UUID,
    "requested_by_user_id" UUID NOT NULL,
    "status" "TestRunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "TestRunTrigger" NOT NULL DEFAULT 'MANUAL',
    "idempotency_key" TEXT,
    "definition_snapshot" JSONB NOT NULL,
    "environment_snapshot" JSONB NOT NULL,
    "trace_schema_version" INTEGER NOT NULL DEFAULT 1,
    "error" JSONB,
    "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_run_trace_events" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "actor" "TestTraceActor" NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "TestTraceStatus" NOT NULL,
    "step_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "input_ref" TEXT,
    "output_ref" TEXT,
    "duration_ms" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_run_trace_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_run_artifacts" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "trace_event_id" UUID,
    "runtime_artifact_id" UUID,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "storage_key" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_run_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_run_human_checkpoints" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "trace_event_id" UUID,
    "step_id" TEXT NOT NULL,
    "status" "TestRunCheckpointStatus" NOT NULL DEFAULT 'PENDING',
    "prompt" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "response" JSONB,
    "expires_at" TIMESTAMPTZ,
    "resolved_by_user_id" UUID,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "test_run_human_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_projects_team_id_updated_at_idx" ON "test_projects"("team_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "test_projects_team_id_slug_key" ON "test_projects"("team_id", "slug");

-- CreateIndex
CREATE INDEX "test_environments_team_id_project_id_updated_at_idx" ON "test_environments"("team_id", "project_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "test_environments_project_id_slug_key" ON "test_environments"("project_id", "slug");

-- CreateIndex
CREATE INDEX "test_cases_team_id_project_id_updated_at_idx" ON "test_cases"("team_id", "project_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "test_cases_project_id_slug_key" ON "test_cases"("project_id", "slug");

-- CreateIndex
CREATE INDEX "test_case_versions_team_id_case_id_version_idx" ON "test_case_versions"("team_id", "case_id", "version" DESC);

-- CreateIndex
CREATE INDEX "test_case_versions_definition_sha256_idx" ON "test_case_versions"("definition_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "test_case_versions_case_id_version_key" ON "test_case_versions"("case_id", "version");

-- CreateIndex
CREATE INDEX "test_runs_team_id_project_id_status_created_at_idx" ON "test_runs"("team_id", "project_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "test_runs_team_id_case_id_created_at_idx" ON "test_runs"("team_id", "case_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "test_runs_runtime_session_id_idx" ON "test_runs"("runtime_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_runs_team_id_idempotency_key_key" ON "test_runs"("team_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "test_run_trace_events_team_id_run_id_sequence_idx" ON "test_run_trace_events"("team_id", "run_id", "sequence");

-- CreateIndex
CREATE INDEX "test_run_trace_events_run_id_step_id_idx" ON "test_run_trace_events"("run_id", "step_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_run_trace_events_run_id_sequence_key" ON "test_run_trace_events"("run_id", "sequence");

-- CreateIndex
CREATE INDEX "test_run_artifacts_team_id_run_id_created_at_idx" ON "test_run_artifacts"("team_id", "run_id", "created_at");

-- CreateIndex
CREATE INDEX "test_run_artifacts_trace_event_id_idx" ON "test_run_artifacts"("trace_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_run_artifacts_run_id_runtime_artifact_id_key" ON "test_run_artifacts"("run_id", "runtime_artifact_id");

-- CreateIndex
CREATE INDEX "test_run_human_checkpoints_team_id_run_id_status_idx" ON "test_run_human_checkpoints"("team_id", "run_id", "status");

-- CreateIndex
CREATE INDEX "test_run_human_checkpoints_status_expires_at_idx" ON "test_run_human_checkpoints"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "test_projects" ADD CONSTRAINT "test_projects_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_environments" ADD CONSTRAINT "test_environments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_environments" ADD CONSTRAINT "test_environments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "test_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "test_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_versions" ADD CONSTRAINT "test_case_versions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_versions" ADD CONSTRAINT "test_case_versions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "test_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_versions" ADD CONSTRAINT "test_case_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "test_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "test_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_case_version_id_fkey" FOREIGN KEY ("case_version_id") REFERENCES "test_case_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "test_environments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_runtime_session_id_fkey" FOREIGN KEY ("runtime_session_id") REFERENCES "browser_runtime_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_run_trace_events" ADD CONSTRAINT "test_run_trace_events_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_run_trace_events" ADD CONSTRAINT "test_run_trace_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_run_artifacts" ADD CONSTRAINT "test_run_artifacts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_run_artifacts" ADD CONSTRAINT "test_run_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_run_artifacts" ADD CONSTRAINT "test_run_artifacts_trace_event_id_fkey" FOREIGN KEY ("trace_event_id") REFERENCES "test_run_trace_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_run_artifacts" ADD CONSTRAINT "test_run_artifacts_runtime_artifact_id_fkey" FOREIGN KEY ("runtime_artifact_id") REFERENCES "browser_runtime_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_run_human_checkpoints" ADD CONSTRAINT "test_run_human_checkpoints_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_run_human_checkpoints" ADD CONSTRAINT "test_run_human_checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_run_human_checkpoints" ADD CONSTRAINT "test_run_human_checkpoints_trace_event_id_fkey" FOREIGN KEY ("trace_event_id") REFERENCES "test_run_trace_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_run_human_checkpoints" ADD CONSTRAINT "test_run_human_checkpoints_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
