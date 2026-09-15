CREATE TABLE "task_acceptance_reviews" (
  "id" UUID NOT NULL, "task_execution_id" UUID NOT NULL, "revision" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED', "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_owner" TEXT, "lease_token" UUID, "lease_expires_at" TIMESTAMPTZ,
  "result" JSONB, "model" TEXT, "error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "task_acceptance_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_acceptance_reviews_task_execution_id_fkey" FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "task_acceptance_reviews_task_execution_id_revision_key" ON "task_acceptance_reviews"("task_execution_id", "revision");
CREATE INDEX "task_acceptance_reviews_status_created_at_idx" ON "task_acceptance_reviews"("status", "created_at");
