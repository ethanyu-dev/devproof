BEGIN;

CREATE TYPE "RunLifecycle" AS ENUM ('QUEUED', 'PREPARING', 'RUNNING', 'WAITING_HUMAN', 'COMPLETED', 'CANCELLED', 'TIMED_OUT');
CREATE TYPE "ExecutionDisposition" AS ENUM ('EXECUTED', 'NOT_RUN', 'BLOCKED', 'AGENT_ERROR', 'PROVIDER_ERROR', 'BROWSER_UNAVAILABLE', 'RUNTIME_LOST');
CREATE TYPE "RunProductVerdict" AS ENUM ('PASSED', 'FAILED', 'INCONCLUSIVE');
CREATE TYPE "RunAttemptStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING_HUMAN', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');
CREATE TYPE "AgentRuntimeTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING_HUMAN', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');
CREATE TYPE "BrowserExecutionStatus" AS ENUM ('REQUESTED', 'WAITING_CAPACITY', 'ACTIVE', 'HUMAN_CONTROL', 'RELEASING', 'RELEASED', 'FAILED', 'LOST', 'TIMED_OUT');
CREATE TYPE "RunInterventionStatus" AS ENUM ('PENDING', 'RESOLVED', 'EXPIRED', 'CANCELLED');

ALTER TABLE "tool_credentials"
  DROP CONSTRAINT "tool_credentials_scopes_known",
  ADD CONSTRAINT "tool_credentials_scopes_known"
    CHECK (
      "scopes" <@ ARRAY[
        'verification:read',
        'verification:write',
        'verification:cancel',
        'profile:delete',
        'run:read',
        'run:write',
        'run:cancel',
        'runtime:lease'
      ]::TEXT[]
    );

CREATE TABLE "execution_runs" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "source_kind" TEXT NOT NULL DEFAULT 'API',
  "source_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "goal" TEXT NOT NULL,
  "lifecycle" "RunLifecycle" NOT NULL DEFAULT 'QUEUED',
  "execution_disposition" "ExecutionDisposition",
  "verdict" "RunProductVerdict",
  "criteria_snapshot" JSONB NOT NULL,
  "environment_snapshot" JSONB NOT NULL DEFAULT '{}',
  "execution_policy" JSONB NOT NULL DEFAULT '{}',
  "current_attempt_number" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "trace_id" VARCHAR(32) NOT NULL,
  "deadline_at" TIMESTAMPTZ NOT NULL,
  "cancel_requested_at" TIMESTAMPTZ,
  "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "execution_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "execution_runs_attempt_bounds" CHECK ("max_attempts" > 0 AND "current_attempt_number" >= 0 AND "current_attempt_number" <= "max_attempts"),
  CONSTRAINT "execution_runs_verdict_requires_execution" CHECK ("verdict" IS NULL OR "execution_disposition" = 'EXECUTED'),
  CONSTRAINT "execution_runs_nonterminal_has_no_verdict" CHECK ("lifecycle" IN ('COMPLETED', 'CANCELLED', 'TIMED_OUT') OR "verdict" IS NULL)
);

CREATE TABLE "run_attempts" (
  "id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "number" INTEGER NOT NULL,
  "status" "RunAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "input_snapshot" JSONB NOT NULL,
  "result" JSONB,
  "error" JSONB,
  "failure_class" TEXT,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "run_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_attempts_number_positive" CHECK ("number" > 0)
);

CREATE TABLE "agent_runtime_tasks" (
  "id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "capability" TEXT NOT NULL,
  "provider" "AgentRuntimeProvider" NOT NULL DEFAULT 'CODEX',
  "status" "AgentRuntimeTaskStatus" NOT NULL DEFAULT 'PENDING',
  "snapshot" JSONB NOT NULL,
  "result" JSONB,
  "error" JSONB,
  "lease_owner" TEXT,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ,
  "fencing_token" BIGINT NOT NULL DEFAULT 0,
  "last_heartbeat_at" TIMESTAMPTZ,
  "completion_id" UUID,
  "cancel_requested_at" TIMESTAMPTZ,
  "deadline_at" TIMESTAMPTZ NOT NULL,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "agent_runtime_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_runtime_tasks_lease_complete" CHECK (("lease_owner" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
);

CREATE TABLE "run_events" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "attempt_id" UUID,
  "task_id" UUID,
  "sequence" BIGSERIAL NOT NULL,
  "actor" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "run_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "run_criterion_results" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "criterion_id" TEXT NOT NULL,
  "status" "RunProductVerdict" NOT NULL,
  "summary" TEXT NOT NULL,
  "evidence_refs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "run_criterion_results_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "run_evidences" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "runtime_artifact_id" UUID,
  "external_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "run_evidences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "human_interventions" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "status" "RunInterventionStatus" NOT NULL DEFAULT 'PENDING',
  "prompt" TEXT NOT NULL,
  "context" JSONB NOT NULL DEFAULT '{}',
  "response" JSONB,
  "expires_at" TIMESTAMPTZ,
  "resolved_by" TEXT,
  "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "human_interventions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "browser_executions" (
  "id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "runtime_session_id" UUID,
  "status" "BrowserExecutionStatus" NOT NULL DEFAULT 'REQUESTED',
  "input" JSONB NOT NULL DEFAULT '{}',
  "output" JSONB,
  "error" JSONB,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "browser_executions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "execution_runs_team_id_idempotency_key_key" ON "execution_runs"("team_id", "idempotency_key");
CREATE INDEX "execution_runs_team_id_lifecycle_created_at_idx" ON "execution_runs"("team_id", "lifecycle", "created_at" DESC);
CREATE INDEX "execution_runs_source_kind_source_id_idx" ON "execution_runs"("source_kind", "source_id");
CREATE INDEX "execution_runs_lifecycle_deadline_at_idx" ON "execution_runs"("lifecycle", "deadline_at");
CREATE UNIQUE INDEX "run_attempts_run_id_number_key" ON "run_attempts"("run_id", "number");
CREATE INDEX "run_attempts_status_created_at_idx" ON "run_attempts"("status", "created_at");
CREATE UNIQUE INDEX "agent_runtime_tasks_attempt_id_key" ON "agent_runtime_tasks"("attempt_id");
CREATE UNIQUE INDEX "agent_runtime_tasks_completion_id_key" ON "agent_runtime_tasks"("completion_id");
CREATE INDEX "agent_runtime_tasks_status_lease_expires_at_created_at_idx" ON "agent_runtime_tasks"("status", "lease_expires_at", "created_at");
CREATE INDEX "agent_runtime_tasks_run_id_status_idx" ON "agent_runtime_tasks"("run_id", "status");
CREATE UNIQUE INDEX "run_events_run_id_sequence_key" ON "run_events"("run_id", "sequence");
CREATE INDEX "run_events_team_id_run_id_sequence_idx" ON "run_events"("team_id", "run_id", "sequence");
CREATE INDEX "run_events_task_id_occurred_at_idx" ON "run_events"("task_id", "occurred_at");
CREATE UNIQUE INDEX "run_criterion_results_attempt_id_criterion_id_key" ON "run_criterion_results"("attempt_id", "criterion_id");
CREATE INDEX "run_criterion_results_team_id_run_id_idx" ON "run_criterion_results"("team_id", "run_id");
CREATE UNIQUE INDEX "run_evidences_attempt_id_external_id_key" ON "run_evidences"("attempt_id", "external_id");
CREATE INDEX "run_evidences_team_id_run_id_created_at_idx" ON "run_evidences"("team_id", "run_id", "created_at");
CREATE INDEX "run_evidences_runtime_artifact_id_idx" ON "run_evidences"("runtime_artifact_id");
CREATE INDEX "human_interventions_team_id_run_id_status_idx" ON "human_interventions"("team_id", "run_id", "status");
CREATE INDEX "human_interventions_status_expires_at_idx" ON "human_interventions"("status", "expires_at");
CREATE UNIQUE INDEX "browser_executions_attempt_id_key" ON "browser_executions"("attempt_id");
CREATE INDEX "browser_executions_run_id_status_idx" ON "browser_executions"("run_id", "status");
CREATE INDEX "browser_executions_runtime_session_id_idx" ON "browser_executions"("runtime_session_id");

ALTER TABLE "execution_runs" ADD CONSTRAINT "execution_runs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_attempts" ADD CONSTRAINT "run_attempts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "execution_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_runtime_tasks" ADD CONSTRAINT "agent_runtime_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "execution_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_runtime_tasks" ADD CONSTRAINT "agent_runtime_tasks_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "run_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "execution_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "run_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_runtime_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "run_criterion_results" ADD CONSTRAINT "run_criterion_results_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_criterion_results" ADD CONSTRAINT "run_criterion_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "execution_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_criterion_results" ADD CONSTRAINT "run_criterion_results_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "run_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_evidences" ADD CONSTRAINT "run_evidences_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_evidences" ADD CONSTRAINT "run_evidences_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "execution_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_evidences" ADD CONSTRAINT "run_evidences_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "run_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_evidences" ADD CONSTRAINT "run_evidences_runtime_artifact_id_fkey" FOREIGN KEY ("runtime_artifact_id") REFERENCES "browser_runtime_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "human_interventions" ADD CONSTRAINT "human_interventions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "human_interventions" ADD CONSTRAINT "human_interventions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "execution_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "human_interventions" ADD CONSTRAINT "human_interventions_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "run_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "human_interventions" ADD CONSTRAINT "human_interventions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_runtime_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_executions" ADD CONSTRAINT "browser_executions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "execution_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_executions" ADD CONSTRAINT "browser_executions_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "run_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_executions" ADD CONSTRAINT "browser_executions_runtime_session_id_fkey" FOREIGN KEY ("runtime_session_id") REFERENCES "browser_runtime_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
