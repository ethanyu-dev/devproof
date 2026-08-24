ALTER TYPE "VerificationRunStatus" ADD VALUE IF NOT EXISTS 'WAITING_EXECUTION' AFTER 'QUEUED';

ALTER TABLE "verification_runs"
  ADD COLUMN "execution_wait_started_at" TIMESTAMPTZ,
  ADD COLUMN "execution_acquire_deadline_at" TIMESTAMPTZ;

CREATE INDEX "verification_runs_status_execution_acquire_deadline_at_idx"
  ON "verification_runs"("status", "execution_acquire_deadline_at");

CREATE OR REPLACE FUNCTION "enforce_verification_run_lifecycle"()
RETURNS trigger AS $$
DECLARE
  allowed BOOLEAN := false;
BEGIN
  IF OLD."status" = NEW."status" THEN
    IF OLD."status" IN ('PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED', 'TIMED_OUT')
      AND (
        OLD."result" IS DISTINCT FROM NEW."result"
        OR OLD."error" IS DISTINCT FROM NEW."error"
        OR OLD."finished_at" IS DISTINCT FROM NEW."finished_at"
        OR OLD."cancelled_at" IS DISTINCT FROM NEW."cancelled_at"
      )
    THEN
      RAISE EXCEPTION 'terminal verification outcome is immutable';
    END IF;
    RETURN NEW;
  END IF;
  allowed := CASE OLD."status"
    WHEN 'QUEUED' THEN NEW."status" IN ('WAITING_EXECUTION', 'RUNNING', 'FAILED', 'INCONCLUSIVE', 'CANCELLED', 'TIMED_OUT')
    WHEN 'WAITING_EXECUTION' THEN NEW."status" IN ('QUEUED', 'RUNNING', 'FAILED', 'INCONCLUSIVE', 'CANCELLED', 'TIMED_OUT')
    WHEN 'RUNNING' THEN NEW."status" IN ('QUEUED', 'WAITING_EXECUTION', 'WAITING_HUMAN', 'PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED', 'TIMED_OUT')
    WHEN 'WAITING_HUMAN' THEN NEW."status" IN ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED', 'TIMED_OUT')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid verification lifecycle transition: % -> %', OLD."status", NEW."status";
  END IF;
  IF NEW."status" IN ('PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED', 'TIMED_OUT') AND NEW."finished_at" IS NULL THEN
    RAISE EXCEPTION 'terminal verification state requires finished_at';
  END IF;
  IF NEW."status" IN ('PASSED', 'FAILED', 'INCONCLUSIVE') AND NEW."result" IS NULL THEN
    RAISE EXCEPTION 'verification verdict state requires result';
  END IF;
  IF NEW."status" IN ('PASSED', 'FAILED', 'INCONCLUSIVE')
    AND NEW."result"->>'verdict' IS DISTINCT FROM NEW."status"::TEXT
  THEN
    RAISE EXCEPTION 'verification result verdict must match lifecycle status';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
