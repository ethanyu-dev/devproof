-- AlterTable
ALTER TABLE "browser_runtime_sessions" ADD COLUMN     "auth_snapshot_generation" INTEGER,
ADD COLUMN     "closure_verified_at" TIMESTAMPTZ,
ADD COLUMN     "control_generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "execution_permit_expires_at" TIMESTAMPTZ,
ADD COLUMN     "identity_permit" INTEGER,
ADD COLUMN     "owner_fencing_token" BIGINT,
ADD COLUMN     "owner_task_id" UUID,
ADD COLUMN     "quarantined_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "browser_runtime_commands" ADD COLUMN     "owner_fencing_token" BIGINT,
ADD COLUMN     "owner_permit_expires_at" TIMESTAMPTZ,
ADD COLUMN     "owner_task_id" UUID;

-- AlterTable
ALTER TABLE "execution_runs" ADD COLUMN     "concurrency_policy" JSONB,
ADD COLUMN     "execution_budget_seconds" INTEGER,
ADD COLUMN     "execution_budget_started_at" TIMESTAMPTZ,
ADD COLUMN     "execution_max_extension_seconds" INTEGER,
ADD COLUMN     "infrastructure_recovery_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "queue_deadline_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "task_case_executions" ADD COLUMN     "execution_policy" JSONB,
ADD COLUMN     "scheduling" JSONB;

-- AlterTable
ALTER TABLE "user_browser_profiles" ADD COLUMN     "auth_snapshot_created_at" TIMESTAMPTZ,
ADD COLUMN     "auth_snapshot_generation" INTEGER,
ADD COLUMN     "execution_concurrency" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "execution_mode" TEXT NOT NULL DEFAULT 'SERIAL_PERSISTENT';

-- AlterTable
ALTER TABLE "agent_runtime_tasks" ADD COLUMN     "lease_lost_at" TIMESTAMPTZ,
ADD COLUMN     "recovery_next_attempt_at" TIMESTAMPTZ,
ADD COLUMN     "recovery_status" TEXT;

-- AlterTable
ALTER TABLE "browser_executions" ADD COLUMN     "allocation_token" UUID,
ADD COLUMN     "startup_recovery_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "execution_resource_leases" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "root_key" TEXT NOT NULL,
    "resource_key" TEXT NOT NULL DEFAULT '',
    "mode" TEXT NOT NULL,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_resource_leases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "execution_resource_leases_root_key_created_at_idx" ON "execution_resource_leases"("root_key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "execution_resource_leases_session_id_resource_key_key" ON "execution_resource_leases"("session_id", "resource_key");

-- CreateIndex
CREATE UNIQUE INDEX "browser_runtime_sessions_user_browser_profile_id_identity_p_key" ON "browser_runtime_sessions"("user_browser_profile_id", "identity_permit");

-- AddForeignKey
ALTER TABLE "execution_resource_leases" ADD CONSTRAINT "execution_resource_leases_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "browser_runtime_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Invalid modes/limits must never create an unbounded identity pool.
ALTER TABLE "user_browser_profiles" ADD CONSTRAINT "profile_execution_mode_valid" CHECK ("execution_mode" IN ('SERIAL_PERSISTENT', 'ISOLATED_AUTH')), ADD CONSTRAINT "profile_execution_concurrency_valid" CHECK ("execution_concurrency" BETWEEN 1 AND 64);
ALTER TABLE "execution_resource_leases" ADD CONSTRAINT "execution_resource_mode_valid" CHECK ("mode" IN ('READ', 'WRITE'));

-- Recovery and closure reconciliation run continuously against retained history.
CREATE INDEX "agent_runtime_task_recovery_due_idx" ON "agent_runtime_tasks"("recovery_status", "recovery_next_attempt_at");
CREATE INDEX "browser_runtime_session_owner_closure_idx" ON "browser_runtime_sessions"("owner_task_id", "closure_verified_at");
