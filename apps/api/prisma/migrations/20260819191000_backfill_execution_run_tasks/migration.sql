BEGIN;

-- Preserve every pre-task Run in the new user-visible task list. These wrappers
-- deliberately remain LEGACY_RUN records: their original input did not contain
-- a task-scoped Spec snapshot and must never be reinterpreted as one.
INSERT INTO "task_executions" (
  "id",
  "team_id",
  "kind",
  "source_kind",
  "source_ref",
  "idempotency_key",
  "title",
  "lifecycle",
  "current_stage",
  "waiting_reason",
  "execution_disposition",
  "verdict",
  "input_snapshot",
  "environment_snapshot",
  "trace_id",
  "deadline_at",
  "cancel_requested_at",
  "projected_at",
  "migration_source",
  "source_snapshot_complete",
  "queued_at",
  "started_at",
  "finished_at",
  "created_at",
  "updated_at"
)
SELECT
  run."id",
  run."team_id",
  'LEGACY_RUN'::"TaskExecutionKind",
  run."source_kind",
  run."source_id",
  'legacy-run:' || run."id"::text,
  LEFT(run."goal", 500),
  CASE run."lifecycle"::text
    WHEN 'QUEUED' THEN 'QUEUED'::"TaskExecutionLifecycle"
    WHEN 'WAITING_HUMAN' THEN 'WAITING_HUMAN'::"TaskExecutionLifecycle"
    WHEN 'COMPLETED' THEN 'COMPLETED'::"TaskExecutionLifecycle"
    WHEN 'CANCELLED' THEN 'CANCELLED'::"TaskExecutionLifecycle"
    WHEN 'TIMED_OUT' THEN 'TIMED_OUT'::"TaskExecutionLifecycle"
    ELSE 'RUNNING'::"TaskExecutionLifecycle"
  END,
  'SPEC_EXECUTION'::"TaskExecutionStageType",
  NULL,
  run."execution_disposition",
  run."verdict",
  jsonb_build_object(
    'kind', 'LEGACY_RUN',
    'runId', run."id",
    'sourceKind', run."source_kind",
    'sourceId', run."source_id"
  ),
  run."environment_snapshot",
  run."trace_id",
  run."deadline_at",
  run."cancel_requested_at",
  run."updated_at",
  'EXECUTION_RUN_BACKFILL',
  FALSE,
  run."queued_at",
  run."started_at",
  run."finished_at",
  run."created_at",
  run."updated_at"
FROM "execution_runs" AS run
WHERE run."task_execution_id" IS NULL
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "task_execution_stages" (
  "id",
  "task_execution_id",
  "type",
  "status",
  "current_attempt_number",
  "max_attempts",
  "started_at",
  "finished_at",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  run."id",
  'SPEC_ANALYSIS'::"TaskExecutionStageType",
  'SKIPPED'::"TaskExecutionStageStatus",
  0,
  1,
  run."created_at",
  run."created_at",
  run."created_at",
  run."created_at"
FROM "execution_runs" AS run
JOIN "task_executions" AS task ON task."id" = run."id"
WHERE run."task_execution_id" IS NULL
  AND task."migration_source" = 'EXECUTION_RUN_BACKFILL'
ON CONFLICT ("task_execution_id", "type") DO NOTHING;

INSERT INTO "task_execution_stages" (
  "id",
  "task_execution_id",
  "type",
  "status",
  "current_attempt_number",
  "max_attempts",
  "last_error",
  "started_at",
  "finished_at",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  run."id",
  'SPEC_EXECUTION'::"TaskExecutionStageType",
  CASE
    WHEN run."lifecycle"::text IN ('COMPLETED', 'CANCELLED', 'TIMED_OUT')
      AND run."execution_disposition" = 'EXECUTED'
      THEN 'SUCCEEDED'::"TaskExecutionStageStatus"
    WHEN run."lifecycle"::text IN ('COMPLETED', 'CANCELLED', 'TIMED_OUT')
      THEN 'FAILED'::"TaskExecutionStageStatus"
    ELSE 'RUNNING'::"TaskExecutionStageStatus"
  END,
  run."current_attempt_number",
  run."max_attempts",
  NULL,
  run."started_at",
  run."finished_at",
  run."created_at",
  run."updated_at"
FROM "execution_runs" AS run
JOIN "task_executions" AS task ON task."id" = run."id"
WHERE run."task_execution_id" IS NULL
  AND task."migration_source" = 'EXECUTION_RUN_BACKFILL'
ON CONFLICT ("task_execution_id", "type") DO NOTHING;

INSERT INTO "task_execution_events" (
  "id",
  "team_id",
  "task_execution_id",
  "actor",
  "kind",
  "payload",
  "occurred_at",
  "created_at"
)
SELECT
  gen_random_uuid(),
  run."team_id",
  run."id",
  'MIGRATION',
  'task.migrated',
  jsonb_build_object('runId', run."id", 'source', 'EXECUTION_RUN_BACKFILL'),
  run."created_at",
  run."created_at"
FROM "execution_runs" AS run
JOIN "task_executions" AS task ON task."id" = run."id"
WHERE run."task_execution_id" IS NULL
  AND task."migration_source" = 'EXECUTION_RUN_BACKFILL';

UPDATE "execution_runs" AS run
SET "task_execution_id" = run."id"
FROM "task_executions" AS task
WHERE run."task_execution_id" IS NULL
  AND task."id" = run."id"
  AND task."migration_source" = 'EXECUTION_RUN_BACKFILL';

COMMIT;
