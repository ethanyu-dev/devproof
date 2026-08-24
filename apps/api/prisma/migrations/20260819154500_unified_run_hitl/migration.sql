BEGIN;

ALTER TABLE "human_interventions"
  ADD COLUMN "response_schema" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "browser_human_control_leases"
  ALTER COLUMN "checkpoint_id" DROP NOT NULL,
  ADD COLUMN "intervention_id" UUID;

CREATE UNIQUE INDEX "browser_human_control_leases_intervention_id_key"
  ON "browser_human_control_leases"("intervention_id");

ALTER TABLE "browser_human_control_leases"
  ADD CONSTRAINT "browser_human_control_leases_intervention_id_fkey"
  FOREIGN KEY ("intervention_id") REFERENCES "human_interventions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_human_control_leases_target_check"
  CHECK (
    (("checkpoint_id" IS NOT NULL)::INT + ("intervention_id" IS NOT NULL)::INT) = 1
  );

ALTER TABLE "notification_outbox"
  ALTER COLUMN "run_id" DROP NOT NULL,
  ADD COLUMN "execution_run_id" UUID,
  ADD COLUMN "intervention_id" UUID;

CREATE INDEX "notification_outbox_execution_run_id_created_at_idx"
  ON "notification_outbox"("execution_run_id", "created_at" DESC);
CREATE INDEX "notification_outbox_intervention_id_idx"
  ON "notification_outbox"("intervention_id");

ALTER TABLE "notification_outbox"
  ADD CONSTRAINT "notification_outbox_execution_run_id_fkey"
  FOREIGN KEY ("execution_run_id") REFERENCES "execution_runs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "notification_outbox_intervention_id_fkey"
  FOREIGN KEY ("intervention_id") REFERENCES "human_interventions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "notification_outbox_run_target_check"
  CHECK (
    (("run_id" IS NOT NULL)::INT + ("execution_run_id" IS NOT NULL)::INT) = 1
  ),
  ADD CONSTRAINT "notification_outbox_hitl_target_check"
  CHECK (
    (("checkpoint_id" IS NOT NULL)::INT + ("intervention_id" IS NOT NULL)::INT) <= 1
  );

COMMIT;
