ALTER TABLE "post_run_analysis_jobs"
  ADD COLUMN "hard_deadline_at" TIMESTAMPTZ NOT NULL
    DEFAULT (CURRENT_TIMESTAMP + INTERVAL '2 hours'),
  ADD COLUMN "ready_at" TIMESTAMPTZ,
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ;

-- Existing runnable jobs used deadline_at as both their queue and execution
-- deadline. Give them a fresh hard window so deploying this migration does not
-- immediately terminalize work that was waiting behind another analysis.
UPDATE "post_run_analysis_jobs"
SET
  "hard_deadline_at" = CASE
    WHEN "status" IN ('PENDING_CAPTURE', 'CAPTURING', 'READY', 'RUNNING')
      THEN GREATEST(
        "deadline_at",
        CURRENT_TIMESTAMP + INTERVAL '2 hours'
      )
    ELSE "deadline_at"
  END,
  "ready_at" = CASE
    WHEN "status" IN ('READY', 'RUNNING') THEN "updated_at"
    ELSE NULL
  END,
  "next_attempt_at" = CASE
    WHEN "status" = 'READY' THEN CURRENT_TIMESTAMP
    ELSE NULL
  END;

CREATE INDEX "post_run_analysis_jobs_schedulable_idx"
  ON "post_run_analysis_jobs"(
    "team_id",
    "status",
    "next_attempt_at",
    "attempt_number"
  );

CREATE INDEX "post_run_analysis_jobs_attempt_deadline_idx"
  ON "post_run_analysis_jobs"("status", "deadline_at");

CREATE INDEX "post_run_analysis_jobs_hard_deadline_idx"
  ON "post_run_analysis_jobs"("status", "hard_deadline_at");
