-- CreateEnum
CREATE TYPE "RuntimeSessionStatus" AS ENUM ('OPENING', 'ACTIVE', 'HUMAN_CONTROL', 'CLOSING', 'CLOSED', 'FAILED', 'LOST');

-- CreateEnum
CREATE TYPE "RuntimeCommandStatus" AS ENUM ('PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "RuntimeCommandSource" AS ENUM ('SYSTEM', 'CONSOLE', 'HUMAN');

-- CreateEnum
CREATE TYPE "BrowserProfileMode" AS ENUM ('PERSISTENT', 'EPHEMERAL');

-- CreateEnum
CREATE TYPE "RuntimeArtifactKind" AS ENUM ('SCREENSHOT', 'DOM', 'CONSOLE', 'NETWORK');

-- AlterTable
ALTER TABLE "browser_runtimes" ADD COLUMN     "gateway_instance_id" TEXT,
ADD COLUMN     "protocol_major" INTEGER,
ADD COLUMN     "protocol_minor" INTEGER;

-- CreateTable
CREATE TABLE "browser_runtime_sessions" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "runtime_id" UUID NOT NULL,
    "status" "RuntimeSessionStatus" NOT NULL DEFAULT 'OPENING',
    "profile_mode" "BrowserProfileMode" NOT NULL,
    "profile_key" TEXT NOT NULL,
    "slot_number" INTEGER NOT NULL,
    "lease_token" UUID NOT NULL,
    "fencing_token" BIGINT NOT NULL,
    "lease_expires_at" TIMESTAMPTZ NOT NULL,
    "protocol_major" INTEGER NOT NULL,
    "protocol_minor" INTEGER NOT NULL,
    "human_controller_user_id" UUID,
    "human_control_expires_at" TIMESTAMPTZ,
    "last_error" JSONB,
    "opened_at" TIMESTAMPTZ,
    "closed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "browser_runtime_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_runtime_slots" (
    "id" UUID NOT NULL,
    "runtime_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "slot_number" INTEGER NOT NULL,
    "lease_token" UUID NOT NULL,
    "fencing_token" BIGINT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "browser_runtime_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_runtime_fence_counters" (
    "runtime_id" UUID NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "browser_runtime_fence_counters_pkey" PRIMARY KEY ("runtime_id")
);

-- CreateTable
CREATE TABLE "browser_runtime_commands" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "command_type" TEXT NOT NULL,
    "source" "RuntimeCommandSource" NOT NULL DEFAULT 'CONSOLE',
    "status" "RuntimeCommandStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" JSONB,
    "lease_token" UUID NOT NULL,
    "fencing_token" BIGINT NOT NULL,
    "deadline_at" TIMESTAMPTZ NOT NULL,
    "dispatched_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "browser_runtime_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_runtime_artifacts" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "command_id" UUID,
    "kind" "RuntimeArtifactKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "browser_runtime_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_runtime_events" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "lease_token" UUID NOT NULL,
    "fencing_token" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "browser_runtime_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "browser_runtime_sessions_team_id_created_at_idx" ON "browser_runtime_sessions"("team_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "browser_runtime_sessions_runtime_id_status_idx" ON "browser_runtime_sessions"("runtime_id", "status");

-- CreateIndex
CREATE INDEX "browser_runtime_sessions_lease_expires_at_idx" ON "browser_runtime_sessions"("lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "browser_runtime_slots_session_id_key" ON "browser_runtime_slots"("session_id");

-- CreateIndex
CREATE INDEX "browser_runtime_slots_expires_at_idx" ON "browser_runtime_slots"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "browser_runtime_slots_runtime_id_slot_number_key" ON "browser_runtime_slots"("runtime_id", "slot_number");

-- CreateIndex
CREATE INDEX "browser_runtime_commands_session_id_created_at_idx" ON "browser_runtime_commands"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "browser_runtime_commands_status_deadline_at_idx" ON "browser_runtime_commands"("status", "deadline_at");

-- CreateIndex
CREATE UNIQUE INDEX "browser_runtime_artifacts_storage_key_key" ON "browser_runtime_artifacts"("storage_key");

-- CreateIndex
CREATE INDEX "browser_runtime_artifacts_session_id_created_at_idx" ON "browser_runtime_artifacts"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "browser_runtime_artifacts_command_id_idx" ON "browser_runtime_artifacts"("command_id");

-- CreateIndex
CREATE INDEX "browser_runtime_events_session_id_occurred_at_idx" ON "browser_runtime_events"("session_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "browser_runtime_sessions" ADD CONSTRAINT "browser_runtime_sessions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtime_sessions" ADD CONSTRAINT "browser_runtime_sessions_runtime_id_fkey" FOREIGN KEY ("runtime_id") REFERENCES "browser_runtimes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtime_sessions" ADD CONSTRAINT "browser_runtime_sessions_human_controller_user_id_fkey" FOREIGN KEY ("human_controller_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtime_slots" ADD CONSTRAINT "browser_runtime_slots_runtime_id_fkey" FOREIGN KEY ("runtime_id") REFERENCES "browser_runtimes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtime_slots" ADD CONSTRAINT "browser_runtime_slots_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "browser_runtime_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtime_fence_counters" ADD CONSTRAINT "browser_runtime_fence_counters_runtime_id_fkey" FOREIGN KEY ("runtime_id") REFERENCES "browser_runtimes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtime_commands" ADD CONSTRAINT "browser_runtime_commands_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "browser_runtime_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtime_artifacts" ADD CONSTRAINT "browser_runtime_artifacts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "browser_runtime_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtime_artifacts" ADD CONSTRAINT "browser_runtime_artifacts_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "browser_runtime_commands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtime_events" ADD CONSTRAINT "browser_runtime_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "browser_runtime_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
