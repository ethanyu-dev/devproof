ALTER TABLE "runtime_drain_attestations"
  ADD COLUMN "resume_generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "resume_connection_generation" BIGINT,
  ADD COLUMN "resumed_at" TIMESTAMPTZ;

ALTER TABLE "browser_runtime_pairing_tokens"
  ADD COLUMN "resume_drain_id" UUID,
  ADD COLUMN "resume_generation" INTEGER,
  ADD COLUMN "resume_requested_by" UUID,
  ADD CONSTRAINT "browser_runtime_pairing_tokens_resume_scope_check" CHECK (
    (resume_drain_id IS NULL AND resume_generation IS NULL AND resume_requested_by IS NULL)
    OR (resume_drain_id IS NOT NULL AND resume_generation IS NOT NULL AND resume_generation > 0 AND resume_requested_by IS NOT NULL)
  );

CREATE INDEX "runtime_pairing_resume_scope_idx"
  ON "browser_runtime_pairing_tokens" ("resume_drain_id", "resume_generation");
