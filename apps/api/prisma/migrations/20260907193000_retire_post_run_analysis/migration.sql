-- Coordinated upgrade: stop old API/analysis workers and back up analysis rows
-- before applying this contraction. Historical migrations remain unchanged.
BEGIN;

LOCK TABLE "post_run_analysis_jobs" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "post_run_analysis_jobs"
    WHERE "status" = 'RUNNING' AND "lease_expires_at" > CURRENT_TIMESTAMP
  ) THEN
    RAISE EXCEPTION 'Stop the retired analysis Runtime and wait for its active leases to expire before migrating';
  END IF;
END $$;

-- Persist every dedicated object key before removing its last owning row.
-- ON CONFLICT preserves existing deletion leases and retry state.
INSERT INTO "object_storage_deletion_tasks"
  ("id", "storage_key", "updated_at")
SELECT gen_random_uuid(), keys."storage_key", CURRENT_TIMESTAMP
FROM (
  SELECT "input_storage_key" AS "storage_key" FROM "post_run_analysis_jobs"
  UNION
  SELECT "capture_storage_key" FROM "post_run_analysis_jobs"
  UNION
  SELECT "capture_evidence_storage_key" FROM "post_run_analysis_jobs"
  UNION
  SELECT "input_manifest" ->> '_structuredEvidenceStorageKey'
  FROM "post_run_analysis_jobs"
) keys
WHERE keys."storage_key" IS NOT NULL AND keys."storage_key" <> ''
ON CONFLICT ("storage_key") DO NOTHING;

UPDATE "agent_runtime_credentials"
SET "revoked_at" = COALESCE("revoked_at", CURRENT_TIMESTAMP),
    "updated_at" = CURRENT_TIMESTAMP
WHERE "pool" = 'POST_RUN_ANALYSIS';

DELETE FROM "agent_model_configurations" WHERE "pool" = 'POST_RUN_ANALYSIS';

DROP TABLE "analysis_findings";
DROP TABLE "improvement_work_items";
DROP TABLE "post_run_analysis_events";
DROP TABLE "post_run_analysis_jobs";
DROP TYPE "PostRunAnalysisStatus";
DROP TYPE "ImprovementWorkItemStatus";

-- This counter also fences completion notifications after an in-place rerun.
-- Rename it without resetting any values or changing existing outbox payloads.
ALTER TABLE "task_executions"
RENAME COLUMN "post_run_analysis_generation" TO "execution_generation";

-- AgentRuntimePool retains its retired label solely for revoked credential
-- history. Authentication, provisioning and public contracts reject it.
COMMIT;
