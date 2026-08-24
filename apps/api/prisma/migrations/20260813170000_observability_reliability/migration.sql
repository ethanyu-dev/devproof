BEGIN;

CREATE OR REPLACE FUNCTION "protect_verification_event_append_only"()
RETURNS trigger AS $$
BEGIN
  IF current_setting('devproof.retention_purge', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'verification events are append-only';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

SELECT set_config('devproof.retention_purge', 'on', true);

UPDATE "verification_events" AS event
SET "trace_id" = run."trace_id"
FROM "verification_runs" AS run
WHERE event."run_id" = run."id"
  AND event."trace_id" IS NULL;

SELECT set_config('devproof.retention_purge', 'off', true);

ALTER TABLE "verification_events"
  ALTER COLUMN "trace_id" SET NOT NULL;

UPDATE "test_run_artifacts" AS test_artifact
SET "storage_key" = runtime_artifact."storage_key"
FROM "browser_runtime_artifacts" AS runtime_artifact
WHERE test_artifact."runtime_artifact_id" = runtime_artifact."id"
  AND test_artifact."storage_key" IS NULL;

CREATE TABLE "object_storage_deletion_tasks" (
  "id" UUID NOT NULL,
  "storage_key" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "object_storage_deletion_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "object_storage_deletion_tasks_storage_key_key"
  ON "object_storage_deletion_tasks"("storage_key");
CREATE INDEX "object_storage_deletion_tasks_next_attempt_at_lease_expires_at_idx"
  ON "object_storage_deletion_tasks"("next_attempt_at", "lease_expires_at");

COMMIT;
