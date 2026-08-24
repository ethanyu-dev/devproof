BEGIN;

ALTER TABLE "task_executions"
  ADD COLUMN "notification_context" JSONB NOT NULL DEFAULT '{}';

-- Preserve the original Feishu conversation for tasks created before this
-- column existed so waiting-input notifications can reply to the same group.
UPDATE "task_executions" AS "task"
SET "notification_context" = jsonb_build_object(
  'feishu',
  jsonb_build_object(
    'replyToMessageId',
    "event"."metadata" #>> '{message,messageId}'
  )
)
FROM "inbound_integration_events" AS "event"
WHERE "event"."task_execution_id" = "task"."id"
  AND "event"."provider" = 'FEISHU'
  AND COALESCE("event"."metadata" #>> '{message,messageId}', '') <> '';

-- Older console reruns were created as anonymous credential requests. Recover
-- both their user identity and their Feishu reply target from the source task.
UPDATE "task_executions" AS "rerun"
SET
  "requested_by_kind" = CASE
    WHEN "source"."requested_by_user_id" IS NOT NULL THEN 'USER'::"RequestActorKind"
    ELSE "rerun"."requested_by_kind"
  END,
  "requested_by_user_id" = COALESCE(
    "rerun"."requested_by_user_id",
    "source"."requested_by_user_id"
  ),
  "notification_context" = CASE
    WHEN "rerun"."notification_context" = '{}'::JSONB
      THEN "source"."notification_context"
    ELSE "rerun"."notification_context"
  END
FROM "task_execution_events" AS "link"
JOIN "task_executions" AS "source"
  ON "source"."id"::TEXT = "link"."payload" ->> 'sourceTaskId'
WHERE "link"."task_execution_id" = "rerun"."id"
  AND "link"."kind" = 'task.rerun.linked';

ALTER TABLE "notification_outbox"
  ADD COLUMN "task_execution_id" UUID;

DROP INDEX IF EXISTS "notification_outbox_task_execution_created_idx";
CREATE INDEX "notification_outbox_task_execution_created_idx"
  ON "notification_outbox"("task_execution_id", "created_at" DESC);

ALTER TABLE "notification_outbox"
  DROP CONSTRAINT "notification_outbox_run_target_check",
  ADD CONSTRAINT "notification_outbox_task_execution_id_fkey"
  FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "notification_outbox_run_target_check"
  CHECK (
    (
      ("run_id" IS NOT NULL)::INT
      + ("execution_run_id" IS NOT NULL)::INT
      + ("task_execution_id" IS NOT NULL)::INT
    ) = 1
  );

COMMIT;
