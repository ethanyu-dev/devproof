CREATE TABLE "run_observation_bindings" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "criterion_id" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "contract_digest" TEXT NOT NULL,
  "observation_id" UUID NOT NULL,
  "source_command_id" UUID NOT NULL,
  "snapshot_artifact_id" UUID NOT NULL,
  "binding_digest" TEXT NOT NULL,
  "facts" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "run_observation_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_observation_bindings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "run_observation_bindings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "execution_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "run_observation_bindings_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "run_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "run_observation_bindings_attempt_target_contract_observation_key" ON "run_observation_bindings"("attempt_id", "target_id", "contract_digest", "observation_id");
CREATE INDEX "run_observation_bindings_run_attempt_criterion_target_idx" ON "run_observation_bindings"("run_id", "attempt_id", "criterion_id", "target_id");
