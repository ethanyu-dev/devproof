DROP INDEX IF EXISTS "verification_runs_status_next_attempt_at_worker_lease_expir_idx";

ALTER TABLE "verification_runs"
  DROP COLUMN IF EXISTS "attempt",
  DROP COLUMN IF EXISTS "next_attempt_at";

ALTER TABLE "verification_runs"
  RENAME COLUMN "worker_id" TO "execution_claim_owner";

ALTER TABLE "verification_runs"
  RENAME COLUMN "worker_lease_token" TO "execution_claim_token";

ALTER TABLE "verification_runs"
  RENAME COLUMN "worker_lease_expires_at" TO "execution_claim_expires_at";

CREATE INDEX "verification_runs_status_execution_claim_expires_at_idx"
  ON "verification_runs"("status", "execution_claim_expires_at");
