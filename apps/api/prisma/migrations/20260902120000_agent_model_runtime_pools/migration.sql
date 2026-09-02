ALTER TABLE "agent_model_configurations"
ADD COLUMN "pool" "AgentRuntimePool" NOT NULL DEFAULT 'BROWSER_EXECUTION';

DROP INDEX "agent_model_configurations_team_id_display_name_key";
DROP INDEX "agent_model_configurations_team_id_position_idx";

INSERT INTO "agent_model_configurations" (
  "id",
  "team_id",
  "pool",
  "base_url",
  "api_key_encrypted",
  "api_key_hint",
  "model_id",
  "display_name",
  "position",
  "configured_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  "team_id",
  target_pool,
  "base_url",
  "api_key_encrypted",
  "api_key_hint",
  "model_id",
  "display_name",
  "position",
  "configured_by_user_id",
  "created_at",
  "updated_at"
FROM "agent_model_configurations"
CROSS JOIN (
  VALUES
    ('SPEC_ANALYSIS'::"AgentRuntimePool"),
    ('POST_RUN_ANALYSIS'::"AgentRuntimePool")
) AS target(target_pool);

ALTER TABLE "agent_model_configurations"
ALTER COLUMN "pool" DROP DEFAULT;

ALTER TABLE "agent_model_configurations"
ADD CONSTRAINT "agent_model_configurations_pool_check"
CHECK ("pool" <> 'MIXED'::"AgentRuntimePool");

CREATE UNIQUE INDEX "agent_model_configurations_team_id_pool_display_name_key"
ON "agent_model_configurations"("team_id", "pool", "display_name");

CREATE INDEX "agent_model_configurations_team_id_pool_position_idx"
ON "agent_model_configurations"("team_id", "pool", "position");
