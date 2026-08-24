ALTER TYPE "AgentRuntimeProvider" ADD VALUE IF NOT EXISTS 'OPENAI';

ALTER TABLE "verification_runs"
  DROP CONSTRAINT IF EXISTS "verification_runs_agent_connector_id_fkey";

DROP INDEX IF EXISTS "verification_runs_agent_connector_id_created_at_idx";

ALTER TABLE "verification_runs"
  DROP COLUMN IF EXISTS "agent_connector_id";

DROP TABLE IF EXISTS "agent_connectors";
DROP TYPE IF EXISTS "AgentConnectorMode";
