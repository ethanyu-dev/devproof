ALTER TABLE "execution_runs"
  ADD COLUMN "initial_deadline_at" TIMESTAMPTZ,
  ADD COLUMN "hard_deadline_at" TIMESTAMPTZ,
  ADD COLUMN "deadline_extension_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deadline_extended_ms" INTEGER NOT NULL DEFAULT 0;

UPDATE "execution_runs"
SET
  "initial_deadline_at" = "deadline_at",
  "hard_deadline_at" = "deadline_at";

ALTER TABLE "execution_runs"
  ALTER COLUMN "initial_deadline_at" SET NOT NULL,
  ALTER COLUMN "hard_deadline_at" SET NOT NULL;

ALTER TABLE "agent_runtime_tasks"
  ADD COLUMN "active_operation" TEXT,
  ADD COLUMN "active_operation_key" TEXT,
  ADD COLUMN "active_operation_started_at" TIMESTAMPTZ,
  ADD COLUMN "last_progress_at" TIMESTAMPTZ,
  ADD COLUMN "last_model_completed_at" TIMESTAMPTZ,
  ADD COLUMN "last_model_latency_ms" INTEGER,
  ADD COLUMN "model_latency_ewma_ms" INTEGER,
  ADD COLUMN "model_latency_max_ms" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_model_operation_key" TEXT,
  ADD COLUMN "last_deadline_extension_operation_key" TEXT;

ALTER TABLE "human_interventions"
  ADD COLUMN "paused_execution_remaining_ms" INTEGER;
