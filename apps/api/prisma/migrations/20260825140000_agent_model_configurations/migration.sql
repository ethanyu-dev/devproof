CREATE TABLE "agent_model_configurations" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key_encrypted" TEXT NOT NULL,
    "api_key_hint" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "configured_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_model_configurations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_model_configurations_team_id_display_name_key"
ON "agent_model_configurations"("team_id", "display_name");

CREATE INDEX "agent_model_configurations_team_id_position_idx"
ON "agent_model_configurations"("team_id", "position");

ALTER TABLE "agent_model_configurations"
ADD CONSTRAINT "agent_model_configurations_team_id_fkey"
FOREIGN KEY ("team_id") REFERENCES "teams"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_model_configurations"
ADD CONSTRAINT "agent_model_configurations_configured_by_user_id_fkey"
FOREIGN KEY ("configured_by_user_id") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
