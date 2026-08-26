CREATE TYPE "AgentRuntimePool" AS ENUM (
  'SPEC_ANALYSIS',
  'BROWSER_EXECUTION',
  'MIXED'
);

ALTER TYPE "BrowserExecutionStatus" ADD VALUE 'ALLOCATING' BEFORE 'ACTIVE';

ALTER TABLE "agent_runtime_credentials"
  ADD COLUMN "pool" "AgentRuntimePool" NOT NULL DEFAULT 'MIXED';

-- A combined credential would defeat process and failure-domain isolation.
-- Operators must provision the two explicit pool credentials after this release.
UPDATE "agent_runtime_credentials"
SET "revoked_at" = CURRENT_TIMESTAMP
WHERE "pool" = 'MIXED' AND "revoked_at" IS NULL;

ALTER TABLE "agent_runtime_credentials"
  ALTER COLUMN "pool" DROP DEFAULT;

CREATE TABLE "task_deployments" (
  "id" UUID NOT NULL,
  "task_execution_id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "target_url" TEXT NOT NULL,
  "environment_snapshot" JSONB NOT NULL DEFAULT '{}',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "task_deployments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_deployments_task_execution_id_fkey"
    FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "task_deployments_task_execution_id_key_key"
  ON "task_deployments"("task_execution_id", "key");
CREATE UNIQUE INDEX "task_deployments_id_task_execution_id_key"
  ON "task_deployments"("id", "task_execution_id");
CREATE INDEX "task_deployments_task_execution_id_enabled_created_at_idx"
  ON "task_deployments"("task_execution_id", "enabled", "created_at");

CREATE TABLE "task_deployment_profile_bindings" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "task_execution_id" UUID NOT NULL,
  "deployment_id" UUID NOT NULL,
  "profile_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "task_deployment_profile_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_deployment_profile_bindings_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_deployment_profile_bindings_task_execution_id_fkey"
    FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_deployment_profile_bindings_deployment_fkey"
    FOREIGN KEY ("deployment_id", "task_execution_id")
    REFERENCES "task_deployments"("id", "task_execution_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_deployment_profile_bindings_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "user_browser_profiles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "task_deployment_profile_bindings_deployment_task_key"
  ON "task_deployment_profile_bindings"("deployment_id", "task_execution_id");
CREATE INDEX "task_deployment_profile_bindings_profile_task_idx"
  ON "task_deployment_profile_bindings"("profile_id", "task_execution_id");
CREATE INDEX "task_deployment_profile_bindings_team_task_idx"
  ON "task_deployment_profile_bindings"("team_id", "task_execution_id");

INSERT INTO "task_deployments" (
  "id",
  "task_execution_id",
  "key",
  "name",
  "target_url",
  "environment_snapshot",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  task."id",
  'default',
  'Default',
  COALESCE(task."environment_snapshot"->>'targetUrl', 'http://unconfigured.invalid'),
  task."environment_snapshot",
  CURRENT_TIMESTAMP
FROM "task_executions" task
WHERE EXISTS (
  SELECT 1
  FROM "task_case_executions" execution
  WHERE execution."task_execution_id" = task."id"
);

INSERT INTO "task_deployment_profile_bindings" (
  "id",
  "team_id",
  "task_execution_id",
  "deployment_id",
  "profile_id",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  task."team_id",
  deployment."task_execution_id",
  deployment."id",
  binding."resolved_profile_id",
  CURRENT_TIMESTAMP
FROM "task_deployments" deployment
INNER JOIN "task_executions" task ON task."id" = deployment."task_execution_id"
INNER JOIN "task_profile_bindings" binding
  ON binding."task_execution_id" = deployment."task_execution_id"
WHERE binding."status" = 'RESOLVED'
  AND binding."resolved_profile_id" IS NOT NULL;

ALTER TABLE "task_case_executions"
  ADD COLUMN "deployment_id" UUID;

UPDATE "task_case_executions" execution
SET "deployment_id" = deployment."id"
FROM "task_deployments" deployment
WHERE deployment."task_execution_id" = execution."task_execution_id"
  AND deployment."key" = 'default';

ALTER TABLE "task_case_executions"
  ALTER COLUMN "deployment_id" SET NOT NULL;

DROP INDEX "task_case_executions_task_case_ordinal_key";
DROP INDEX "task_case_executions_case_ordinal_idx";

CREATE UNIQUE INDEX "task_case_executions_task_case_deployment_ordinal_key"
  ON "task_case_executions"(
    "task_execution_id",
    "case_id",
    "deployment_id",
    "execution_ordinal"
  );
CREATE INDEX "task_case_executions_case_deployment_ordinal_idx"
  ON "task_case_executions"("case_id", "deployment_id", "execution_ordinal");

ALTER TABLE "task_case_executions"
  ADD CONSTRAINT "task_case_executions_deployment_id_fkey"
  FOREIGN KEY ("deployment_id", "task_execution_id")
  REFERENCES "task_deployments"("id", "task_execution_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "browser_executions"
  ADD COLUMN "routing_key" TEXT NOT NULL DEFAULT 'pool',
  ADD COLUMN "routing_rule_id" UUID,
  ADD COLUMN "target_runtime_id" UUID,
  ADD COLUMN "admission_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "waiting_since" TIMESTAMPTZ,
  ADD COLUMN "next_admission_at" TIMESTAMPTZ;

-- Runs queued before this release created BrowserExecution only after an Agent
-- claimed the task. Backfill their admission record so the new admission-first
-- claim predicate does not strand in-flight work during a rolling deployment.
INSERT INTO "browser_executions" (
  "run_id",
  "attempt_id",
  "status",
  "input"
)
SELECT
  task."run_id",
  task."attempt_id",
  'REQUESTED',
  jsonb_strip_nulls(
    jsonb_build_object(
      'availabilityPolicy',
      COALESCE(
        run."execution_policy" #>> '{browser,availabilityPolicy}',
        'WAIT'
      ),
      'profile',
      COALESCE(
        run."execution_policy" #> '{browser,profile}',
        '{"mode":"EPHEMERAL"}'::jsonb
      ),
      'requiredCapabilities',
      COALESCE(
        run."execution_policy" #> '{browser,requiredCapabilities}',
        '["browser"]'::jsonb
      ),
      'targetUrl',
      run."environment_snapshot" ->> 'targetUrl'
    )
  )
FROM "agent_runtime_tasks" task
INNER JOIN "execution_runs" run ON run."id" = task."run_id"
INNER JOIN "run_attempts" attempt ON attempt."id" = task."attempt_id"
LEFT JOIN "browser_executions" browser
  ON browser."attempt_id" = task."attempt_id"
WHERE (
    (task."status" = 'PENDING' AND attempt."status" = 'PENDING')
    OR (
      task."status" = 'RUNNING'
      AND attempt."status" = 'RUNNING'
      AND task."lease_expires_at" < CURRENT_TIMESTAMP
    )
  )
  AND run."lifecycle" IN ('QUEUED', 'PREPARING', 'RUNNING')
  AND browser."id" IS NULL;

CREATE INDEX "browser_executions_status_next_admission_created_at_idx"
  ON "browser_executions"("status", "next_admission_at", "created_at");
CREATE INDEX "browser_executions_target_runtime_id_status_idx"
  ON "browser_executions"("target_runtime_id", "status");
