-- Replace a retired provider-specific name with the generic extension point.
-- Historical migration files remain unchanged so existing Prisma checksums stay valid.

BEGIN;

ALTER TABLE "verification_runs"
  DISABLE TRIGGER "verification_runs_protect_request";

UPDATE "verification_runs"
SET "request_snapshot" = jsonb_set(
  "request_snapshot",
  '{agentRuntime,provider}',
  '"CUSTOM"'::jsonb,
  false
)
WHERE "request_snapshot" #>> '{agentRuntime,provider}' = 'LOOPX';

-- request_sha256 intentionally remains the identity of the original caller
-- payload. Current idempotency checks normalize stored snapshots before their
-- fallback comparison.

ALTER TABLE "verification_runs"
  ENABLE TRIGGER "verification_runs_protect_request";

UPDATE "agent_runtime_tasks"
SET "snapshot" = jsonb_set(
  "snapshot",
  '{model,provider}',
  '"CUSTOM"'::jsonb,
  false
)
WHERE "snapshot" #>> '{model,provider}' = 'LOOPX';

ALTER TYPE "AgentRuntimeProvider" RENAME VALUE 'LOOPX' TO 'CUSTOM';

COMMIT;
