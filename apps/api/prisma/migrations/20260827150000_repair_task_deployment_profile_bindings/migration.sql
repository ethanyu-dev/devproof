-- Repair installations where the browser-pool deployment migration was
-- recorded as applied without the per-deployment Profile binding relation.
-- This migration is intentionally idempotent so healthy installations can
-- deploy it without rebuilding or locking an already-populated table.
CREATE TABLE IF NOT EXISTS "task_deployment_profile_bindings" (
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

CREATE UNIQUE INDEX IF NOT EXISTS
  "task_deployment_profile_bindings_deployment_task_key"
  ON "task_deployment_profile_bindings"("deployment_id", "task_execution_id");
CREATE INDEX IF NOT EXISTS "task_deployment_profile_bindings_profile_task_idx"
  ON "task_deployment_profile_bindings"("profile_id", "task_execution_id");
CREATE INDEX IF NOT EXISTS "task_deployment_profile_bindings_team_task_idx"
  ON "task_deployment_profile_bindings"("team_id", "task_execution_id");

-- Recover bindings that were resolved before this repair was deployed.
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
INNER JOIN "task_executions" task
  ON task."id" = deployment."task_execution_id"
INNER JOIN "task_profile_bindings" binding
  ON binding."task_execution_id" = deployment."task_execution_id"
WHERE binding."status" = 'RESOLVED'
  AND binding."resolved_profile_id" IS NOT NULL
ON CONFLICT ("deployment_id", "task_execution_id") DO UPDATE
SET
  "team_id" = EXCLUDED."team_id",
  "profile_id" = EXCLUDED."profile_id",
  "updated_at" = CURRENT_TIMESTAMP;
