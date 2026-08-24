CREATE TYPE "VerificationAssertionStatus" AS ENUM ('PASSED', 'FAILED', 'INCONCLUSIVE');

CREATE TABLE "verification_assertions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "criterion_id" TEXT NOT NULL,
  "status" "VerificationAssertionStatus" NOT NULL,
  "summary" TEXT NOT NULL,
  "evidence_refs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "verification_assertions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "verification_assertions_run_id_criterion_id_key"
  ON "verification_assertions"("run_id", "criterion_id");
CREATE INDEX "verification_assertions_team_id_run_id_idx"
  ON "verification_assertions"("team_id", "run_id");

ALTER TABLE "verification_assertions"
  ADD CONSTRAINT "verification_assertions_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verification_assertions"
  ADD CONSTRAINT "verification_assertions_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "verification_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
