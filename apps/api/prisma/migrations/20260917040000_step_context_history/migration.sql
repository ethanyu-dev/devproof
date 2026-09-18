-- CreateTable
CREATE TABLE "run_step_contexts" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "segment_id" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "request_gzip" BYTEA NOT NULL,
    "request_sha256" TEXT NOT NULL,
    "request_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "run_step_contexts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "run_step_contexts_team_id_run_id_attempt_id_sequence_idx" ON "run_step_contexts"("team_id", "run_id", "attempt_id", "sequence");

ALTER TABLE "run_step_contexts" ADD CONSTRAINT "run_step_contexts_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "run_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
