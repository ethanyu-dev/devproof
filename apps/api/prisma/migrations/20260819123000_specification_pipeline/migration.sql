CREATE TYPE "SpecificationTargetSource" AS ENUM ('GITHUB', 'MANUAL');

CREATE TABLE "test_specifications" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "issue_id" TEXT NOT NULL,
  "issue_identifier" TEXT NOT NULL,
  "issue_title" TEXT NOT NULL,
  "issue_url" TEXT NOT NULL,
  "issue_state" TEXT NOT NULL DEFAULT '',
  "current_version" INTEGER NOT NULL DEFAULT 1,
  "source_hash" CHAR(64) NOT NULL,
  "context" JSONB NOT NULL,
  "summary" TEXT NOT NULL,
  "primary_pull_request_url" TEXT,
  "target_url" TEXT,
  "target_source" "SpecificationTargetSource",
  "target_provided_by" TEXT,
  "target_provided_at" TIMESTAMPTZ,
  "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "test_specifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "test_specifications_current_version_positive"
    CHECK ("current_version" > 0),
  CONSTRAINT "test_specifications_source_hash_sha256"
    CHECK ("source_hash" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "generated_test_cases" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "specification_id" UUID NOT NULL,
  "generation_version" INTEGER NOT NULL,
  "position" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "definition" JSONB NOT NULL,
  "execution_run_id" UUID,
  "execution_attempts" INTEGER NOT NULL DEFAULT 0,
  "execution_last_error" JSONB,
  "execution_requested_at" TIMESTAMPTZ,
  "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generated_test_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "generated_test_cases_generation_version_positive"
    CHECK ("generation_version" > 0),
  CONSTRAINT "generated_test_cases_execution_attempts_nonnegative"
    CHECK ("execution_attempts" >= 0),
  CONSTRAINT "generated_test_cases_position_nonnegative"
    CHECK ("position" >= 0)
);

CREATE UNIQUE INDEX "test_specifications_team_id_issue_id_key"
  ON "test_specifications"("team_id", "issue_id");
CREATE INDEX "test_specifications_team_id_updated_at_idx"
  ON "test_specifications"("team_id", "updated_at" DESC);
CREATE INDEX "test_specifications_team_id_issue_identifier_idx"
  ON "test_specifications"("team_id", "issue_identifier");

CREATE UNIQUE INDEX "generated_test_cases_execution_run_id_key"
  ON "generated_test_cases"("execution_run_id");
CREATE UNIQUE INDEX "generated_test_cases_specification_id_generation_version_position_key"
  ON "generated_test_cases"("specification_id", "generation_version", "position");
CREATE INDEX "generated_test_cases_team_id_specification_id_generation_version_idx"
  ON "generated_test_cases"("team_id", "specification_id", "generation_version");
CREATE INDEX "generated_test_cases_execution_requested_at_idx"
  ON "generated_test_cases"("execution_requested_at");

ALTER TABLE "test_specifications"
  ADD CONSTRAINT "test_specifications_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generated_test_cases"
  ADD CONSTRAINT "generated_test_cases_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generated_test_cases"
  ADD CONSTRAINT "generated_test_cases_specification_id_fkey"
  FOREIGN KEY ("specification_id") REFERENCES "test_specifications"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generated_test_cases"
  ADD CONSTRAINT "generated_test_cases_execution_run_id_fkey"
  FOREIGN KEY ("execution_run_id") REFERENCES "execution_runs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "protect_generated_test_case_definition"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."team_id" IS DISTINCT FROM OLD."team_id"
     OR NEW."specification_id" IS DISTINCT FROM OLD."specification_id"
     OR NEW."generation_version" IS DISTINCT FROM OLD."generation_version"
     OR NEW."position" IS DISTINCT FROM OLD."position"
     OR NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."definition" IS DISTINCT FROM OLD."definition"
     OR NEW."generated_at" IS DISTINCT FROM OLD."generated_at" THEN
    RAISE EXCEPTION 'generated test case definitions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "generated_test_case_definition_immutable"
BEFORE UPDATE ON "generated_test_cases"
FOR EACH ROW EXECUTE FUNCTION "protect_generated_test_case_definition"();
