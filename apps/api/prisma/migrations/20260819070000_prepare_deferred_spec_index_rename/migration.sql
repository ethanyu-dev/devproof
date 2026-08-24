-- The historical 20260819071948 migration renames indexes that, on a clean
-- database, are otherwise created by a later migration. Preserve the published
-- migration checksum by supplying a short-lived placeholder only when the real
-- Specification table does not exist yet.
CREATE TABLE IF NOT EXISTS "_devproof_migration_placeholders" (
  "name" TEXT NOT NULL PRIMARY KEY
);

DO $$
BEGIN
  IF to_regclass('generated_test_cases') IS NULL THEN
    CREATE TABLE "generated_test_cases" (
      "specification_id" UUID NOT NULL,
      "generation_version" INTEGER NOT NULL,
      "position" INTEGER NOT NULL,
      "team_id" UUID NOT NULL
    );

    CREATE UNIQUE INDEX "generated_test_cases_specification_id_generation_version_positi"
      ON "generated_test_cases"("specification_id", "generation_version", "position");
    CREATE INDEX "generated_test_cases_team_id_specification_id_generation_versio"
      ON "generated_test_cases"("team_id", "specification_id", "generation_version");

    INSERT INTO "_devproof_migration_placeholders" ("name")
    VALUES ('generated_test_cases');
  END IF;
END;
$$;
