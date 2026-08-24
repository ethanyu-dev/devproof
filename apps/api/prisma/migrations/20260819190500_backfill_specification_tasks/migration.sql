BEGIN;

-- Preserve the user-visible Specification aggregate before the generic Run
-- backfill wraps unrelated Runs. A migrated Task keeps the Specification UUID,
-- so historical /console/specifications/:id links can redirect losslessly.
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
  "input_snapshot",
  "environment_snapshot",
  "trace_id",
  "deadline_at",
  "projection_needed_at",
  "legacy_specification_id",
  "migration_source",
  "source_snapshot_complete",
  "queued_at",
  "started_at",
  "created_at",
  "updated_at"
)
SELECT
  specification."id",
  specification."team_id",
  'ISSUE_SPEC'::"TaskExecutionKind",
  'LINEAR_ISSUE',
  specification."issue_identifier",
  'legacy-spec:' || specification."id"::text,
  specification."issue_identifier" || ' · ' || specification."issue_title",
  CASE
    WHEN COALESCE(
      specification."target_url",
      linked_run."target_url"
    ) IS NULL THEN 'WAITING_INPUT'::"TaskExecutionLifecycle"
    ELSE 'RUNNING'::"TaskExecutionLifecycle"
  END,
  'SPEC_EXECUTION'::"TaskExecutionStageType",
  CASE
    WHEN COALESCE(
      specification."target_url",
      linked_run."target_url"
    ) IS NULL THEN 'DEPLOYMENT_TARGET_REQUIRED'
    ELSE NULL
  END,
  jsonb_strip_nulls(jsonb_build_object(
    'kind', 'ISSUE_SPEC',
    'idempotencyKey', 'legacy-spec:' || specification."id"::text,
    'issueRef', specification."issue_identifier",
    'targetUrl', COALESCE(specification."target_url", linked_run."target_url")
  )),
  jsonb_strip_nulls(jsonb_build_object(
    'targetUrl', COALESCE(specification."target_url", linked_run."target_url"),
    'targetSource', COALESCE(specification."target_source"::text, 'LEGACY'),
    'specificationSnapshotId', specification."id"
  )),
  md5(specification."id"::text),
  GREATEST(
    specification."updated_at" + INTERVAL '1 day',
    CURRENT_TIMESTAMP + INTERVAL '1 day'
  ),
  CURRENT_TIMESTAMP,
  specification."id",
  'TEST_SPECIFICATION_BACKFILL',
  TRUE,
  specification."created_at",
  specification."generated_at",
  specification."created_at",
  specification."updated_at"
FROM "test_specifications" AS specification
LEFT JOIN LATERAL (
  SELECT run."environment_snapshot" ->> 'targetUrl' AS "target_url"
  FROM "generated_test_cases" AS generated_case
  JOIN "execution_runs" AS run
    ON run."id" = generated_case."execution_run_id"
  WHERE generated_case."specification_id" = specification."id"
    AND run."environment_snapshot" ->> 'targetUrl' IS NOT NULL
  ORDER BY generated_case."generation_version" DESC, generated_case."position" ASC
  LIMIT 1
) AS linked_run ON TRUE
ON CONFLICT DO NOTHING;

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
  task."id",
  'SPEC_ANALYSIS'::"TaskExecutionStageType",
  'SUCCEEDED'::"TaskExecutionStageStatus",
  1,
  1,
  specification."generated_at",
  specification."generated_at",
  specification."created_at",
  specification."updated_at"
FROM "test_specifications" AS specification
JOIN "task_executions" AS task
  ON task."legacy_specification_id" = specification."id"
ON CONFLICT ("task_execution_id", "type") DO NOTHING;

INSERT INTO "task_execution_stages" (
  "id",
  "task_execution_id",
  "type",
  "status",
  "current_attempt_number",
  "max_attempts",
  "waiting_reason",
  "started_at",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  task."id",
  'SPEC_EXECUTION'::"TaskExecutionStageType",
  CASE
    WHEN task."lifecycle" = 'WAITING_INPUT'
      THEN 'WAITING_INPUT'::"TaskExecutionStageStatus"
    ELSE 'RUNNING'::"TaskExecutionStageStatus"
  END,
  1,
  3,
  task."waiting_reason",
  CASE WHEN task."lifecycle" = 'WAITING_INPUT' THEN NULL ELSE specification."generated_at" END,
  specification."created_at",
  specification."updated_at"
FROM "test_specifications" AS specification
JOIN "task_executions" AS task
  ON task."legacy_specification_id" = specification."id"
ON CONFLICT ("task_execution_id", "type") DO NOTHING;

INSERT INTO "task_stage_attempts" (
  "id",
  "stage_id",
  "number",
  "status",
  "input_snapshot",
  "result",
  "started_at",
  "finished_at",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  stage."id",
  1,
  'SUCCEEDED'::"TaskStageAttemptStatus",
  task."input_snapshot",
  jsonb_build_object(
    'migrated', TRUE,
    'snapshotId', specification."id",
    'caseCount', (
      SELECT count(*)
      FROM "generated_test_cases" AS generated_case
      WHERE generated_case."specification_id" = specification."id"
        AND generated_case."generation_version" = specification."current_version"
    )
  ),
  specification."generated_at",
  specification."generated_at",
  specification."created_at",
  specification."updated_at"
FROM "test_specifications" AS specification
JOIN "task_executions" AS task
  ON task."legacy_specification_id" = specification."id"
JOIN "task_execution_stages" AS stage
  ON stage."task_execution_id" = task."id"
  AND stage."type" = 'SPEC_ANALYSIS'
ON CONFLICT ("stage_id", "number") DO NOTHING;

INSERT INTO "task_specification_snapshots" (
  "id",
  "task_execution_id",
  "stage_attempt_id",
  "source_hash",
  "generator_kind",
  "generator_version",
  "context",
  "completeness",
  "diagnostics",
  "summary",
  "primary_pull_request_url",
  "generated_at",
  "created_at"
)
SELECT
  specification."id",
  task."id",
  attempt."id",
  specification."source_hash",
  'LEGACY_SPECIFICATION',
  'legacy-spec-v' || specification."current_version"::text,
  specification."context",
  CASE
    WHEN specification."context" #>> '{resolution,completeness}' = 'COMPLETE'
      THEN 'COMPLETE'
    ELSE 'PARTIAL'
  END,
  COALESCE(specification."context" #> '{resolution,diagnostics}', '[]'::jsonb),
  specification."summary",
  specification."primary_pull_request_url",
  specification."generated_at",
  specification."created_at"
FROM "test_specifications" AS specification
JOIN "task_executions" AS task
  ON task."legacy_specification_id" = specification."id"
JOIN "task_execution_stages" AS stage
  ON stage."task_execution_id" = task."id"
  AND stage."type" = 'SPEC_ANALYSIS'
JOIN "task_stage_attempts" AS attempt
  ON attempt."stage_id" = stage."id"
  AND attempt."number" = 1
ON CONFLICT DO NOTHING;

INSERT INTO "task_generated_test_cases" (
  "id",
  "snapshot_id",
  "position",
  "name",
  "definition",
  "definition_hash",
  "generated_at",
  "created_at"
)
SELECT
  generated_case."id",
  specification."id",
  generated_case."position",
  generated_case."name",
  generated_case."definition",
  repeat(md5(generated_case."definition"::text), 2),
  generated_case."generated_at",
  generated_case."created_at"
FROM "generated_test_cases" AS generated_case
JOIN "test_specifications" AS specification
  ON specification."id" = generated_case."specification_id"
  AND specification."current_version" = generated_case."generation_version"
JOIN "task_executions" AS task
  ON task."legacy_specification_id" = specification."id"
ON CONFLICT ("snapshot_id", "position") DO NOTHING;

INSERT INTO "task_case_executions" (
  "id",
  "task_execution_id",
  "case_id",
  "execution_ordinal",
  "run_id",
  "dispatch_status",
  "dispatch_attempts",
  "dispatch_last_error",
  "dispatch_requested_at",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  task."id",
  generated_case."id",
  1,
  generated_case."execution_run_id",
  CASE
    WHEN generated_case."execution_run_id" IS NOT NULL
      THEN 'LINKED'::"TaskCaseDispatchStatus"
    WHEN generated_case."execution_attempts" >= 3
      THEN 'FAILED'::"TaskCaseDispatchStatus"
    ELSE 'PENDING'::"TaskCaseDispatchStatus"
  END,
  generated_case."execution_attempts",
  generated_case."execution_last_error",
  generated_case."execution_requested_at",
  generated_case."created_at",
  GREATEST(generated_case."created_at", COALESCE(generated_case."execution_requested_at", generated_case."created_at"))
FROM "generated_test_cases" AS generated_case
JOIN "test_specifications" AS specification
  ON specification."id" = generated_case."specification_id"
  AND specification."current_version" = generated_case."generation_version"
JOIN "task_executions" AS task
  ON task."legacy_specification_id" = specification."id"
ON CONFLICT ("task_execution_id", "case_id", "execution_ordinal") DO NOTHING;

UPDATE "execution_runs" AS run
SET "task_execution_id" = specification."id"
FROM "generated_test_cases" AS generated_case
JOIN "test_specifications" AS specification
  ON specification."id" = generated_case."specification_id"
JOIN "task_executions" AS task
  ON task."legacy_specification_id" = specification."id"
WHERE run."id" = generated_case."execution_run_id"
  AND run."task_execution_id" IS NULL;

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
  task."team_id",
  task."id",
  'MIGRATION',
  'task.specification_migrated',
  jsonb_build_object(
    'specificationId', specification."id",
    'generationVersion', specification."current_version",
    'source', 'TEST_SPECIFICATION_BACKFILL'
  ),
  specification."created_at",
  specification."created_at"
FROM "test_specifications" AS specification
JOIN "task_executions" AS task
  ON task."legacy_specification_id" = specification."id";

COMMIT;
