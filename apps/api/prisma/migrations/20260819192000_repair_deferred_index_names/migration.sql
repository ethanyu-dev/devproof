-- A historical Prisma migration can run before the Specification tables exist
-- on a fresh database. Complete the deferred renames after those tables have
-- been created while remaining safe for databases where they already ran.
DO $$
BEGIN
  IF to_regclass('generated_test_cases_specification_id_generation_version_positi') IS NOT NULL
     AND to_regclass('generated_test_cases_specification_id_generation_version_po_key') IS NULL THEN
    ALTER INDEX "generated_test_cases_specification_id_generation_version_positi"
      RENAME TO "generated_test_cases_specification_id_generation_version_po_key";
  END IF;

  IF to_regclass('generated_test_cases_team_id_specification_id_generation_versio') IS NOT NULL
     AND to_regclass('generated_test_cases_team_id_specification_id_generation_ve_idx') IS NULL THEN
    ALTER INDEX "generated_test_cases_team_id_specification_id_generation_versio"
      RENAME TO "generated_test_cases_team_id_specification_id_generation_ve_idx";
  END IF;
END;
$$;
