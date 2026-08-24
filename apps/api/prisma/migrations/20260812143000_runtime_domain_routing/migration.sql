CREATE TYPE "RuntimeRoutingFallbackPolicy" AS ENUM ('WAIT', 'DEFAULT', 'FAIL_FAST');

CREATE TABLE "runtime_routing_rules" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "hostname_pattern" TEXT NOT NULL,
    "runtime_id" UUID NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "fallback_policy" "RuntimeRoutingFallbackPolicy" NOT NULL DEFAULT 'WAIT',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "runtime_routing_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "runtime_routing_rules_team_id_hostname_pattern_key"
    ON "runtime_routing_rules"("team_id", "hostname_pattern");

CREATE INDEX "runtime_routing_rules_team_id_enabled_priority_idx"
    ON "runtime_routing_rules"("team_id", "enabled", "priority" DESC);

CREATE INDEX "runtime_routing_rules_runtime_id_idx"
    ON "runtime_routing_rules"("runtime_id");

ALTER TABLE "runtime_routing_rules"
    ADD CONSTRAINT "runtime_routing_rules_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "runtime_routing_rules"
    ADD CONSTRAINT "runtime_routing_rules_runtime_id_fkey"
    FOREIGN KEY ("runtime_id") REFERENCES "browser_runtimes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
