ALTER TABLE "post_run_analysis_jobs"
  ADD COLUMN "input_manifest" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "analysis_findings"
  ADD COLUMN "attempt_number" INTEGER,
  ADD COLUMN "failure_class" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "run_id" UUID,
  ADD COLUMN "runtime_id" UUID;

ALTER TABLE "analysis_findings"
  ALTER COLUMN "failure_class" DROP DEFAULT,
  ALTER COLUMN "phase" DROP DEFAULT;

CREATE INDEX "analysis_findings_run_id_idx"
  ON "analysis_findings"("run_id");
CREATE INDEX "analysis_findings_runtime_id_idx"
  ON "analysis_findings"("runtime_id");
