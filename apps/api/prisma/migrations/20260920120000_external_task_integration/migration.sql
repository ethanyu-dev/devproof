-- AlterTable
ALTER TABLE "task_executions" ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "external_source" TEXT;

-- CreateTable
CREATE TABLE "tool_profile_grants" (
    "credential_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_profile_grants_pkey" PRIMARY KEY ("credential_id","profile_id")
);

-- CreateTable
CREATE TABLE "task_webhooks" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secret_envelope" TEXT NOT NULL,
    "events" TEXT[],
    "disabled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_webhook_deliveries" (
    "id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "delivered_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_webhooks_task_id_credential_id_url_key" ON "task_webhooks"("task_id", "credential_id", "url");

-- CreateIndex
CREATE INDEX "task_webhook_deliveries_status_next_attempt_at_idx" ON "task_webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "task_webhook_deliveries_webhook_id_event_id_key" ON "task_webhook_deliveries"("webhook_id", "event_id");

-- CreateIndex
CREATE INDEX "task_executions_team_id_external_source_external_id_idx" ON "task_executions"("team_id", "external_source", "external_id");

-- AddForeignKey
ALTER TABLE "tool_profile_grants" ADD CONSTRAINT "tool_profile_grants_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "tool_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_profile_grants" ADD CONSTRAINT "tool_profile_grants_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "user_browser_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_webhooks" ADD CONSTRAINT "task_webhooks_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_webhooks" ADD CONSTRAINT "task_webhooks_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "tool_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_webhook_deliveries" ADD CONSTRAINT "task_webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "task_webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_webhook_deliveries" ADD CONSTRAINT "task_webhook_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "task_execution_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
