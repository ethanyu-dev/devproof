BEGIN;

-- Profile usages remain useful as historical facts after the login state is
-- deleted, so keep the usage row and clear only its Profile reference.
ALTER TABLE "browser_profile_usages"
  DROP CONSTRAINT "browser_profile_usages_profile_id_fkey",
  ALTER COLUMN "profile_id" DROP NOT NULL;

ALTER TABLE "browser_profile_usages"
  ADD CONSTRAINT "browser_profile_usages_profile_id_fkey"
  FOREIGN KEY ("profile_id") REFERENCES "user_browser_profiles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Remove existing tombstones and repair tasks that still point at one before
-- the obsolete enum values are removed.
CREATE TEMP TABLE "_deleted_profile_tasks" ON COMMIT DROP AS
SELECT DISTINCT binding."task_execution_id"
FROM "task_profile_bindings" AS binding
JOIN "user_browser_profiles" AS profile
  ON profile."id" = binding."resolved_profile_id"
WHERE profile."status" = 'PURGED'
  AND binding."status" = 'RESOLVED';

UPDATE "task_profile_bindings" AS binding
SET
  "failure_code" = 'PROFILE_DELETED',
  "failure_message" = 'The selected browser profile was deleted.',
  "resolved_at" = NULL,
  "resolved_profile_id" = NULL,
  "status" = 'WAITING_INPUT',
  "version" = binding."version" + 1,
  "updated_at" = CURRENT_TIMESTAMP
WHERE binding."task_execution_id" IN (
  SELECT "task_execution_id" FROM "_deleted_profile_tasks"
);

UPDATE "task_executions" AS task
SET
  "current_stage" = 'PROFILE_RESOLUTION',
  "lifecycle" = 'WAITING_INPUT',
  "projection_needed_at" = NULL,
  "waiting_reason" = 'PROFILE_DELETED',
  "updated_at" = CURRENT_TIMESTAMP
WHERE task."id" IN (SELECT "task_execution_id" FROM "_deleted_profile_tasks")
  AND task."lifecycle" IN ('QUEUED', 'RUNNING', 'WAITING_INPUT');

UPDATE "task_execution_stages" AS stage
SET
  "finished_at" = NULL,
  "status" = 'WAITING_INPUT',
  "waiting_reason" = 'PROFILE_DELETED',
  "updated_at" = CURRENT_TIMESTAMP
WHERE stage."task_execution_id" IN (
  SELECT "task_execution_id" FROM "_deleted_profile_tasks"
)
  AND stage."type" = 'PROFILE_RESOLUTION';

DELETE FROM "user_browser_profiles"
WHERE "status" = 'PURGED';

-- A pre-upgrade deletion that has not reached the Runtime yet must retain its
-- opaque key so the lifecycle worker can finish the physical cleanup.
UPDATE "user_browser_profiles"
SET
  "status" = 'DISABLED',
  "inactivity_expires_at" = CURRENT_TIMESTAMP,
  "verification_error" = jsonb_build_object(
    'code', 'PROFILE_MIGRATED_DELETE_RETRY',
    'message', 'Retrying a Profile deletion started before the upgrade.'
  ),
  "version" = "version" + 1,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "status" = 'PURGING';

ALTER TABLE "user_browser_profiles"
  DROP CONSTRAINT "user_browser_profiles_purged_state_consistent";

ALTER TYPE "UserBrowserProfileStatus" RENAME TO "UserBrowserProfileStatus_old";
CREATE TYPE "UserBrowserProfileStatus" AS ENUM (
  'UNINITIALIZED',
  'PREPARING',
  'READY',
  'REAUTH_REQUIRED',
  'MIGRATION_REQUIRED',
  'LOST',
  'DISABLED'
);

ALTER TABLE "user_browser_profiles"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "UserBrowserProfileStatus"
    USING ("status"::text::"UserBrowserProfileStatus"),
  ALTER COLUMN "status" SET DEFAULT 'UNINITIALIZED';

DROP TYPE "UserBrowserProfileStatus_old";

ALTER TABLE "user_browser_profiles"
  DROP COLUMN "allowed_hostname_patterns",
  DROP COLUMN "purged_at";

COMMIT;
