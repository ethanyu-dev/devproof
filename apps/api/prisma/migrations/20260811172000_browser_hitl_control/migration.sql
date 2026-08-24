CREATE TABLE "browser_human_control_leases" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "checkpoint_id" UUID NOT NULL,
  "controller_user_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "browser_human_control_leases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "browser_human_control_leases_session_id_key"
  ON "browser_human_control_leases"("session_id");
CREATE UNIQUE INDEX "browser_human_control_leases_checkpoint_id_key"
  ON "browser_human_control_leases"("checkpoint_id");
CREATE INDEX "browser_human_control_leases_team_id_expires_at_idx"
  ON "browser_human_control_leases"("team_id", "expires_at");
CREATE INDEX "browser_human_control_leases_controller_user_id_expires_at_idx"
  ON "browser_human_control_leases"("controller_user_id", "expires_at");

ALTER TABLE "browser_human_control_leases"
  ADD CONSTRAINT "browser_human_control_leases_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_human_control_leases"
  ADD CONSTRAINT "browser_human_control_leases_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "browser_runtime_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_human_control_leases"
  ADD CONSTRAINT "browser_human_control_leases_checkpoint_id_fkey"
  FOREIGN KEY ("checkpoint_id") REFERENCES "verification_checkpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_human_control_leases"
  ADD CONSTRAINT "browser_human_control_leases_controller_user_id_fkey"
  FOREIGN KEY ("controller_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
