-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('FEISHU');

-- CreateEnum
CREATE TYPE "RuntimeStatus" AS ENUM ('ONLINE', 'OFFLINE', 'REVOKED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "avatar_url" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "tenant_key" TEXT NOT NULL,
    "raw_profile" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "feishu_tenant_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_memberships" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_configs" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "base_url" TEXT NOT NULL DEFAULT '',
    "api_key_enc" TEXT NOT NULL,
    "api_key_hint" TEXT NOT NULL,
    "context_window" INTEGER NOT NULL,
    "supports_vision" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "model_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_server_configs" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "config_enc" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "mcp_server_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linear_connections" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "workspace_key" TEXT NOT NULL DEFAULT '',
    "mcp_url" TEXT NOT NULL,
    "api_key_enc" TEXT NOT NULL,
    "api_key_hint" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "linear_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_settings" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "default_model_config_id" UUID,
    "max_concurrency" INTEGER NOT NULL DEFAULT 4,
    "run_timeout_seconds" INTEGER NOT NULL DEFAULT 1800,
    "hitl_enabled" BOOLEAN NOT NULL DEFAULT true,
    "trace_retention_days" INTEGER NOT NULL DEFAULT 90,
    "browser_runtime_id" UUID,
    "browser_model_config_id" UUID,
    "browser_max_steps" INTEGER NOT NULL DEFAULT 50,
    "browser_timeout_seconds" INTEGER NOT NULL DEFAULT 900,
    "browser_profile_mode" TEXT NOT NULL DEFAULT 'PERSISTENT',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "runtime_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_runtimes" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "instance_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '',
    "device_info" TEXT NOT NULL DEFAULT '',
    "status" "RuntimeStatus" NOT NULL DEFAULT 'OFFLINE',
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "max_concurrency" INTEGER NOT NULL DEFAULT 1,
    "token_hash" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ,
    "connected_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "browser_runtimes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_runtime_pairing_tokens" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "browser_runtime_pairing_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_identities_tenant_key_idx" ON "auth_identities"("tenant_key");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_provider_user_id_key" ON "auth_identities"("provider", "provider_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "teams_slug_key" ON "teams"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "teams_feishu_tenant_key_key" ON "teams"("feishu_tenant_key");

-- CreateIndex
CREATE INDEX "team_memberships_user_id_idx" ON "team_memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_memberships_team_id_user_id_key" ON "team_memberships"("team_id", "user_id");

-- CreateIndex
CREATE INDEX "model_configs_team_id_updated_at_idx" ON "model_configs"("team_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "model_configs_team_id_display_name_key" ON "model_configs"("team_id", "display_name");

-- CreateIndex
CREATE INDEX "mcp_server_configs_team_id_updated_at_idx" ON "mcp_server_configs"("team_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_configs_team_id_name_key" ON "mcp_server_configs"("team_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "linear_connections_team_id_key" ON "linear_connections"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_settings_team_id_key" ON "runtime_settings"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "browser_runtimes_token_hash_key" ON "browser_runtimes"("token_hash");

-- CreateIndex
CREATE INDEX "browser_runtimes_team_id_updated_at_idx" ON "browser_runtimes"("team_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "browser_runtimes_status_last_seen_at_idx" ON "browser_runtimes"("status", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "browser_runtimes_team_id_instance_key_key" ON "browser_runtimes"("team_id", "instance_key");

-- CreateIndex
CREATE UNIQUE INDEX "browser_runtime_pairing_tokens_token_hash_key" ON "browser_runtime_pairing_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "browser_runtime_pairing_tokens_team_id_created_at_idx" ON "browser_runtime_pairing_tokens"("team_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "browser_runtime_pairing_tokens_expires_at_idx" ON "browser_runtime_pairing_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "audit_events_team_id_created_at_idx" ON "audit_events"("team_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_server_configs" ADD CONSTRAINT "mcp_server_configs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linear_connections" ADD CONSTRAINT "linear_connections_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_settings" ADD CONSTRAINT "runtime_settings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtimes" ADD CONSTRAINT "browser_runtimes_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtime_pairing_tokens" ADD CONSTRAINT "browser_runtime_pairing_tokens_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
