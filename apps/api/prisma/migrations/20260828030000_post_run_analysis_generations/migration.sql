ALTER TABLE "task_executions"
  ADD COLUMN "post_run_analysis_generation" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "post_run_analysis_jobs"
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "capture_storage_key" TEXT,
  ADD COLUMN "capture_evidence_storage_key" TEXT;

DROP INDEX "post_run_analysis_jobs_task_execution_id_analyzer_version_key";

CREATE UNIQUE INDEX "post_run_analysis_jobs_task_analyzer_generation_key"
  ON "post_run_analysis_jobs"("task_execution_id", "analyzer_version", "generation");
