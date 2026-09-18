ALTER TYPE "TaskExecutionKind" ADD VALUE IF NOT EXISTS 'SPEC_TASK';
ALTER TABLE "task_executions" ADD COLUMN "creation_input_snapshot" JSONB;
ALTER TABLE "task_stage_attempts" ADD COLUMN "context_snapshot" JSONB NOT NULL DEFAULT '{}';
-- Recover the original request even if the task was subsequently supplemented.
UPDATE "task_executions" t SET "creation_input_snapshot" = COALESCE(
  (SELECT a.input_snapshot FROM task_stage_attempts a JOIN task_execution_stages s ON s.id = a.stage_id
   WHERE s.task_execution_id = t.id AND s.type = 'SPEC_ANALYSIS' ORDER BY a.number LIMIT 1),
  t.input_snapshot
);
