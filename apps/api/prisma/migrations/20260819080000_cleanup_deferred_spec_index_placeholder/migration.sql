-- Remove only the placeholder created by 20260819070000. On an existing
-- database the real Specification table was already present, so this is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_devproof_migration_placeholders"
    WHERE "name" = 'generated_test_cases'
  ) THEN
    DROP TABLE "generated_test_cases";
    DELETE FROM "_devproof_migration_placeholders"
    WHERE "name" = 'generated_test_cases';
  END IF;
END;
$$;

DROP TABLE IF EXISTS "_devproof_migration_placeholders";
