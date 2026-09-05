-- AlterTable
ALTER TABLE "browser_runtimes" ADD COLUMN     "connection_generation" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "connection_id" UUID,
ADD COLUMN     "daemon_instance_id" TEXT,
ADD COLUMN     "drain_generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "drain_state" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "host_instance_id" TEXT;

-- AlterTable
ALTER TABLE "browser_runtime_sessions" ADD COLUMN     "closure_evidence_id" UUID,
ADD COLUMN     "launch_connection_generation" BIGINT,
ADD COLUMN     "launch_host_instance_id" TEXT,
ADD COLUMN     "launch_identity" JSONB,
ADD COLUMN     "launch_identity_version" INTEGER;

-- AlterTable
ALTER TABLE "task_case_executions" ADD COLUMN     "dispatch_order" INTEGER;

-- AlterTable
ALTER TABLE "browser_executions" ADD COLUMN     "blocking_recovery_id" UUID;

-- AlterTable
ALTER TABLE "execution_resource_leases" ADD COLUMN     "guard_reason" TEXT,
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "recovery_id" UUID;

-- CreateTable
CREATE TABLE "runtime_session_recoveries" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "runtime_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "expected_session_fence" BIGINT NOT NULL,
    "expected_lease_digest" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source_run_id" UUID,
    "observed_protocol_major" INTEGER NOT NULL,
    "observed_protocol_minor" INTEGER NOT NULL,
    "closure_state" TEXT NOT NULL DEFAULT 'REQUESTED',
    "closure_evidence_id" UUID,
    "closure_verified_at" TIMESTAMPTZ,
    "write_outcome_state" TEXT NOT NULL DEFAULT 'UNASSESSED',
    "outcome_evidence_refs" JSONB NOT NULL DEFAULT '[]',
    "resolved_by" UUID,
    "resolution_note" TEXT,
    "resolution_outcome" TEXT,
    "resolution_key" TEXT,
    "resolution_digest" TEXT,
    "write_resolved_at" TIMESTAMPTZ,
    "scope_snapshot" JSONB NOT NULL DEFAULT '[]',
    "scope_provenance" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "alias_registry_version" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "last_error_code" TEXT,
    "last_error_at" TIMESTAMPTZ,
    "active_command_id" UUID,
    "claim_token" UUID,
    "claim_expires_at" TIMESTAMPTZ,
    "claim_version" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "resolved_at" TIMESTAMPTZ,
    "discovered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "runtime_session_recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_closure_evidence" (
    "id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "recovery_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "session_fence" BIGINT NOT NULL,
    "lease_digest" TEXT NOT NULL,
    "runtime_id" UUID NOT NULL,
    "connection_generation" BIGINT,
    "host_instance_id" TEXT,
    "daemon_instance_id" TEXT,
    "launch_identity_version" INTEGER,
    "method" TEXT NOT NULL,
    "capability_version" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "server_verified_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "audit_ref" TEXT,

    CONSTRAINT "session_closure_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_recovery_outbox" (
    "id" UUID NOT NULL,
    "recovery_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "claim_token" UUID,
    "claim_expires_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runtime_recovery_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_recovery_permits" (
    "runtime_id" UUID NOT NULL,
    "recovery_id" UUID NOT NULL,
    "active_command_id" UUID,
    "claim_token" UUID NOT NULL,
    "claim_expires_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "runtime_recovery_permits_pkey" PRIMARY KEY ("runtime_id")
);

-- CreateTable
CREATE TABLE "runtime_drain_attestations" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "runtime_id" UUID NOT NULL,
    "drain_generation" INTEGER NOT NULL,
    "connection_generation" BIGINT NOT NULL,
    "host_instance_id" TEXT,
    "frozen_sessions" JSONB NOT NULL,
    "snapshot_digest" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'FROZEN',
    "created_by" UUID NOT NULL,
    "attested_by" UUID,
    "idempotency_key" TEXT,
    "attestation_digest" TEXT,
    "evidence_refs" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "attested_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runtime_drain_attestations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "runtime_session_recoveries_closure_state_next_attempt_at_id_idx" ON "runtime_session_recoveries"("closure_state", "next_attempt_at", "id");

-- CreateIndex
CREATE INDEX "runtime_session_recoveries_runtime_id_closure_state_idx" ON "runtime_session_recoveries"("runtime_id", "closure_state");

-- CreateIndex
CREATE INDEX "runtime_session_recoveries_team_id_resolved_at_updated_at_i_idx" ON "runtime_session_recoveries"("team_id", "resolved_at", "updated_at", "id");

-- CreateIndex
CREATE INDEX "runtime_session_recoveries_claim_expires_at_idx" ON "runtime_session_recoveries"("claim_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_session_recoveries_session_id_expected_session_fenc_key" ON "runtime_session_recoveries"("session_id", "expected_session_fence");

-- CreateIndex
CREATE UNIQUE INDEX "session_closure_evidence_evidence_id_key" ON "session_closure_evidence"("evidence_id");

-- CreateIndex
CREATE INDEX "session_closure_evidence_request_id_idx" ON "session_closure_evidence"("request_id");

-- CreateIndex
CREATE INDEX "session_closure_evidence_recovery_id_server_verified_at_idx" ON "session_closure_evidence"("recovery_id", "server_verified_at");

-- CreateIndex
CREATE INDEX "runtime_recovery_outbox_delivered_at_created_at_idx" ON "runtime_recovery_outbox"("delivered_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_recovery_outbox_recovery_id_event_type_version_key" ON "runtime_recovery_outbox"("recovery_id", "event_type", "version");

-- CreateIndex
CREATE INDEX "runtime_drain_attestations_team_id_state_created_at_idx" ON "runtime_drain_attestations"("team_id", "state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_drain_attestations_runtime_id_drain_generation_key" ON "runtime_drain_attestations"("runtime_id", "drain_generation");

-- CreateIndex
CREATE INDEX "browser_executions_blocking_recovery_id_idx" ON "browser_executions"("blocking_recovery_id");

-- CreateIndex
CREATE INDEX "execution_resource_leases_recovery_id_idx" ON "execution_resource_leases"("recovery_id");

-- Only pending rows receive a generated-order snapshot; started executions retain history.
UPDATE task_case_executions AS execution
SET dispatch_order = test_case.position
FROM task_generated_test_cases AS test_case
WHERE execution.case_id = test_case.id
  AND execution.run_id IS NULL
  AND execution.dispatch_order IS NULL;
