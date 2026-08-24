-- The previous schema allowed duplicate external run mappings. Preserve the
-- earliest Verification as the canonical mapping and detach later duplicates
-- before enforcing uniqueness; no Verification or evidence rows are deleted.
WITH "ranked_external_runs" AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "team_id", "agent_provider", "external_agent_run_id"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS "mapping_rank"
  FROM "verification_runs"
  WHERE "external_agent_run_id" IS NOT NULL
)
UPDATE "verification_runs" AS "run"
SET "external_agent_run_id" = NULL
FROM "ranked_external_runs" AS "ranked"
WHERE "run"."id" = "ranked"."id"
  AND "ranked"."mapping_rank" > 1;

CREATE UNIQUE INDEX "verification_runs_external_agent_run_key"
  ON "verification_runs"("team_id", "agent_provider", "external_agent_run_id");
