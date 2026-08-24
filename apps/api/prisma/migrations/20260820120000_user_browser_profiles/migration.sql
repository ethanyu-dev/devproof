BEGIN;

CREATE TYPE "BrowserRuntimeSessionPurpose" AS ENUM (
  'EXECUTION',
  'PROFILE_PREPARATION',
  'PROFILE_VERIFICATION',
  'PROFILE_PURGE'
);

CREATE TYPE "ExternalIdentityProvider" AS ENUM (
  'FEISHU_OPEN_ID',
  'FEISHU_UNION_ID',
  'FEISHU_USER_ID',
  'LINEAR'
);

CREATE TYPE "UserBrowserProfileStatus" AS ENUM (
  'UNINITIALIZED',
  'PREPARING',
  'READY',
  'REAUTH_REQUIRED',
  'MIGRATION_REQUIRED',
  'LOST',
  'DISABLED',
  'PURGING',
  'PURGED'
);

CREATE TYPE "BrowserProfileTriggerSource" AS ENUM (
  'CONSOLE',
  'FEISHU',
  'ISSUE_ASSIGNEE'
);

CREATE TYPE "TaskProfileStrategy" AS ENUM (
  'EPHEMERAL',
  'REQUESTER',
  'ISSUE_ASSIGNEE',
  'EXPLICIT_PROFILE'
);

CREATE TYPE "TaskProfileResolutionStatus" AS ENUM (
  'PENDING',
  'RESOLVED',
  'WAITING_INPUT',
  'REJECTED'
);

CREATE TYPE "ProfileUnavailablePolicy" AS ENUM (
  'WAIT_FOR_PROFILE',
  'FAIL',
  'USE_EPHEMERAL'
);

CREATE TYPE "BrowserProfileReservationStatus" AS ENUM (
  'QUEUED',
  'ACTIVE',
  'RELEASED',
  'CANCELLED',
  'EXPIRED'
);

CREATE TYPE "RequestActorKind" AS ENUM (
  'USER',
  'CREDENTIAL',
  'INTEGRATION_EVENT',
  'SYSTEM'
);

CREATE TYPE "IntegrationProvider" AS ENUM ('FEISHU', 'LINEAR');

CREATE TYPE "IntegrationEventStatus" AS ENUM (
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'IGNORED',
  'FAILED'
);

ALTER TYPE "TaskExecutionStageType" ADD VALUE 'PROFILE_RESOLUTION' AFTER 'SPEC_ANALYSIS';

ALTER TABLE "task_executions"
  ADD COLUMN "requested_by_user_id" UUID,
  ADD COLUMN "requested_by_kind" "RequestActorKind" NOT NULL DEFAULT 'CREDENTIAL';

ALTER TABLE "execution_runs"
  ADD COLUMN "browser_profile_id" UUID;

ALTER TABLE "browser_runtime_sessions"
  ADD COLUMN "user_browser_profile_id" UUID,
  ADD COLUMN "purpose" "BrowserRuntimeSessionPurpose" NOT NULL DEFAULT 'EXECUTION';

CREATE TABLE "user_external_identities" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "provider" "ExternalIdentityProvider" NOT NULL,
  "issuer_key" TEXT NOT NULL,
  "external_user_id" TEXT NOT NULL,
  "normalized_email" TEXT,
  "verified_at" TIMESTAMPTZ,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "user_external_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_browser_profiles" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "assigned_runtime_id" UUID,
  "runtime_profile_key" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "scope_key" TEXT NOT NULL,
  "environment_key" TEXT NOT NULL DEFAULT 'default',
  "auth_role" TEXT NOT NULL DEFAULT 'default',
  "allowed_hostname_patterns" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "UserBrowserProfileStatus" NOT NULL DEFAULT 'UNINITIALIZED',
  "verification_url" TEXT,
  "verification_rules" JSONB NOT NULL DEFAULT '{}',
  "last_prepared_at" TIMESTAMPTZ,
  "last_verified_at" TIMESTAMPTZ,
  "last_used_at" TIMESTAMPTZ,
  "inactivity_expires_at" TIMESTAMPTZ,
  "verification_error" JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "purged_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "user_browser_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_browser_profiles_runtime_key_safe"
    CHECK ("runtime_profile_key" ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*$'),
  CONSTRAINT "user_browser_profiles_version_positive" CHECK ("version" > 0),
  CONSTRAINT "user_browser_profiles_purged_state_consistent"
    CHECK (("status" = 'PURGED') = ("purged_at" IS NOT NULL))
);

CREATE TABLE "browser_profile_grants" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "profile_id" UUID NOT NULL,
  "trigger_source" "BrowserProfileTriggerSource" NOT NULL,
  "hostname_pattern" TEXT NOT NULL,
  "consented_by_user_id" UUID NOT NULL,
  "consented_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "browser_profile_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_profile_bindings" (
  "id" UUID NOT NULL,
  "task_execution_id" UUID NOT NULL,
  "strategy" "TaskProfileStrategy" NOT NULL,
  "status" "TaskProfileResolutionStatus" NOT NULL DEFAULT 'PENDING',
  "unavailable_policy" "ProfileUnavailablePolicy" NOT NULL DEFAULT 'WAIT_FOR_PROFILE',
  "requested_profile_id" UUID,
  "resolved_profile_id" UUID,
  "profile_owner_user_id" UUID,
  "scope_key" TEXT,
  "trigger_source" "BrowserProfileTriggerSource",
  "external_identity_snapshot" JSONB NOT NULL DEFAULT '{}',
  "failure_code" TEXT,
  "failure_message" TEXT,
  "resolved_at" TIMESTAMPTZ,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "task_profile_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_profile_bindings_version_positive" CHECK ("version" > 0),
  CONSTRAINT "task_profile_bindings_resolution_consistent"
    CHECK (
      ("status" = 'RESOLVED' AND "resolved_at" IS NOT NULL AND (
        "resolved_profile_id" IS NOT NULL OR "strategy" = 'EPHEMERAL'
      ))
      OR "status" <> 'RESOLVED'
    )
);

CREATE TABLE "browser_profile_reservations" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "profile_id" UUID NOT NULL,
  "task_execution_id" UUID NOT NULL,
  "status" "BrowserProfileReservationStatus" NOT NULL DEFAULT 'QUEUED',
  "lease_owner" TEXT,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ,
  "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activated_at" TIMESTAMPTZ,
  "released_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "browser_profile_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "browser_profile_reservations_lease_complete"
    CHECK (
      ("lease_owner" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
      OR ("lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    )
);

CREATE TABLE "browser_profile_usages" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "profile_id" UUID NOT NULL,
  "task_execution_id" UUID,
  "execution_run_id" UUID,
  "requester_user_id" UUID,
  "trigger_source" "BrowserProfileTriggerSource" NOT NULL,
  "hostname" TEXT NOT NULL,
  "outcome" TEXT,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "browser_profile_usages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inbound_integration_events" (
  "id" UUID NOT NULL,
  "team_id" UUID,
  "task_execution_id" UUID,
  "provider" "IntegrationProvider" NOT NULL,
  "issuer_key" TEXT NOT NULL,
  "external_event_id" TEXT NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "status" "IntegrationEventStatus" NOT NULL DEFAULT 'RECEIVED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ,
  "error" JSONB,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "inbound_integration_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inbound_integration_events_payload_hash_sha256"
    CHECK ("payload_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "inbound_integration_events_attempts_nonnegative"
    CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "user_external_identities_provider_issuer_external_key"
  ON "user_external_identities"("provider", "issuer_key", "external_user_id");
CREATE INDEX "user_external_identities_team_user_provider_idx"
  ON "user_external_identities"("team_id", "user_id", "provider");
CREATE INDEX "user_external_identities_team_email_idx"
  ON "user_external_identities"("team_id", "normalized_email");

CREATE UNIQUE INDEX "user_browser_profiles_team_owner_scope_key"
  ON "user_browser_profiles"("team_id", "owner_user_id", "scope_key");
CREATE UNIQUE INDEX "user_browser_profiles_team_runtime_key_key"
  ON "user_browser_profiles"("team_id", "runtime_profile_key");
CREATE INDEX "user_browser_profiles_team_status_last_used_idx"
  ON "user_browser_profiles"("team_id", "status", "last_used_at");
CREATE INDEX "user_browser_profiles_runtime_status_idx"
  ON "user_browser_profiles"("assigned_runtime_id", "status");
CREATE INDEX "user_browser_profiles_inactivity_status_idx"
  ON "user_browser_profiles"("inactivity_expires_at", "status");

CREATE UNIQUE INDEX "browser_profile_grants_profile_source_hostname_key"
  ON "browser_profile_grants"("profile_id", "trigger_source", "hostname_pattern");
CREATE INDEX "browser_profile_grants_team_source_revoked_idx"
  ON "browser_profile_grants"("team_id", "trigger_source", "revoked_at");

CREATE UNIQUE INDEX "task_profile_bindings_task_execution_id_key"
  ON "task_profile_bindings"("task_execution_id");
CREATE INDEX "task_profile_bindings_status_updated_idx"
  ON "task_profile_bindings"("status", "updated_at");
CREATE INDEX "task_profile_bindings_profile_status_idx"
  ON "task_profile_bindings"("resolved_profile_id", "status");

CREATE UNIQUE INDEX "browser_profile_reservations_profile_task_key"
  ON "browser_profile_reservations"("profile_id", "task_execution_id");
CREATE UNIQUE INDEX "browser_profile_reservations_one_active_profile"
  ON "browser_profile_reservations"("profile_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "browser_profile_reservations_profile_status_queue_idx"
  ON "browser_profile_reservations"("profile_id", "status", "queued_at");
CREATE INDEX "browser_profile_reservations_status_lease_idx"
  ON "browser_profile_reservations"("status", "lease_expires_at");

CREATE INDEX "browser_profile_usages_profile_started_idx"
  ON "browser_profile_usages"("profile_id", "started_at" DESC);
CREATE INDEX "browser_profile_usages_task_idx"
  ON "browser_profile_usages"("task_execution_id");
CREATE INDEX "browser_profile_usages_run_idx"
  ON "browser_profile_usages"("execution_run_id");

CREATE UNIQUE INDEX "inbound_integration_events_provider_issuer_event_key"
  ON "inbound_integration_events"("provider", "issuer_key", "external_event_id");
CREATE INDEX "inbound_integration_events_status_retry_idx"
  ON "inbound_integration_events"("status", "next_attempt_at", "received_at");
CREATE INDEX "inbound_integration_events_team_provider_received_idx"
  ON "inbound_integration_events"("team_id", "provider", "received_at" DESC);

CREATE INDEX "task_executions_requested_by_created_idx"
  ON "task_executions"("requested_by_user_id", "created_at" DESC);
CREATE INDEX "execution_runs_browser_profile_lifecycle_idx"
  ON "execution_runs"("browser_profile_id", "lifecycle");
CREATE INDEX "browser_runtime_sessions_user_profile_status_idx"
  ON "browser_runtime_sessions"("user_browser_profile_id", "status");

ALTER TABLE "user_external_identities"
  ADD CONSTRAINT "user_external_identities_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "user_external_identities_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_browser_profiles"
  ADD CONSTRAINT "user_browser_profiles_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "user_browser_profiles_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "user_browser_profiles_assigned_runtime_id_fkey"
  FOREIGN KEY ("assigned_runtime_id") REFERENCES "browser_runtimes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "browser_profile_grants"
  ADD CONSTRAINT "browser_profile_grants_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_profile_grants_profile_id_fkey"
  FOREIGN KEY ("profile_id") REFERENCES "user_browser_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_profile_grants_consented_by_user_id_fkey"
  FOREIGN KEY ("consented_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_profile_bindings"
  ADD CONSTRAINT "task_profile_bindings_task_execution_id_fkey"
  FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_profile_bindings_requested_profile_id_fkey"
  FOREIGN KEY ("requested_profile_id") REFERENCES "user_browser_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "task_profile_bindings_resolved_profile_id_fkey"
  FOREIGN KEY ("resolved_profile_id") REFERENCES "user_browser_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "task_profile_bindings_profile_owner_user_id_fkey"
  FOREIGN KEY ("profile_owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "browser_profile_reservations"
  ADD CONSTRAINT "browser_profile_reservations_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_profile_reservations_profile_id_fkey"
  FOREIGN KEY ("profile_id") REFERENCES "user_browser_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_profile_reservations_task_execution_id_fkey"
  FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "browser_profile_usages"
  ADD CONSTRAINT "browser_profile_usages_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_profile_usages_profile_id_fkey"
  FOREIGN KEY ("profile_id") REFERENCES "user_browser_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_profile_usages_task_execution_id_fkey"
  FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_profile_usages_execution_run_id_fkey"
  FOREIGN KEY ("execution_run_id") REFERENCES "execution_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_profile_usages_requester_user_id_fkey"
  FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inbound_integration_events"
  ADD CONSTRAINT "inbound_integration_events_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "inbound_integration_events_task_execution_id_fkey"
  FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "task_executions"
  ADD CONSTRAINT "task_executions_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "execution_runs"
  ADD CONSTRAINT "execution_runs_browser_profile_id_fkey"
  FOREIGN KEY ("browser_profile_id") REFERENCES "user_browser_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "browser_runtime_sessions"
  ADD CONSTRAINT "browser_runtime_sessions_user_browser_profile_id_fkey"
  FOREIGN KEY ("user_browser_profile_id") REFERENCES "user_browser_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
