CREATE TABLE "github_access_configurations" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "configured_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "github_access_configurations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_runtime_configurations" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "models" TEXT[] NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "agent_runtime_configurations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "github_access_configurations_team_id_key"
ON "github_access_configurations"("team_id");

CREATE UNIQUE INDEX "agent_runtime_configurations_credential_id_key"
ON "agent_runtime_configurations"("credential_id");

CREATE INDEX "agent_runtime_configurations_team_id_updated_at_idx"
ON "agent_runtime_configurations"("team_id", "updated_at" DESC);

ALTER TABLE "github_access_configurations"
ADD CONSTRAINT "github_access_configurations_team_id_fkey"
FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_access_configurations"
ADD CONSTRAINT "github_access_configurations_configured_by_user_id_fkey"
FOREIGN KEY ("configured_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agent_runtime_configurations"
ADD CONSTRAINT "agent_runtime_configurations_team_id_fkey"
FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_runtime_configurations"
ADD CONSTRAINT "agent_runtime_configurations_credential_id_fkey"
FOREIGN KEY ("credential_id") REFERENCES "tool_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
