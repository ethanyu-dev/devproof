ALTER TABLE "post_run_analysis_jobs"
ADD COLUMN "analysis_checkpoint" JSONB NOT NULL DEFAULT '{}'::jsonb;
