BEGIN;

ALTER TABLE "runtime_settings"
  DROP COLUMN "browser_runtime_id",
  DROP COLUMN "browser_profile_mode";

UPDATE "verification_runs"
SET "request_snapshot" = jsonb_set(
  "request_snapshot" #- '{execution,runnerId}',
  '{execution,requiredCapabilities}',
  CASE
    WHEN jsonb_typeof("request_snapshot" #> '{execution,requiredCapabilities}') = 'array'
      THEN CASE
        WHEN jsonb_array_length("request_snapshot" #> '{execution,requiredCapabilities}') > 0
          THEN "request_snapshot" #> '{execution,requiredCapabilities}'
        ELSE '["browser"]'::jsonb
      END
    ELSE '["browser"]'::jsonb
  END,
  true
)
WHERE "request_snapshot" #> '{execution,runnerId}' IS NOT NULL;

ALTER TABLE "runtime_routing_rules"
  ALTER COLUMN "fallback_policy" DROP DEFAULT;

UPDATE "runtime_routing_rules"
SET "fallback_policy" = 'WAIT'
WHERE "fallback_policy" = 'DEFAULT';

ALTER TYPE "RuntimeRoutingFallbackPolicy"
  RENAME TO "RuntimeRoutingFallbackPolicy_old";

CREATE TYPE "RuntimeRoutingFallbackPolicy" AS ENUM ('WAIT', 'FAIL_FAST');

ALTER TABLE "runtime_routing_rules"
  ALTER COLUMN "fallback_policy" TYPE "RuntimeRoutingFallbackPolicy"
  USING ("fallback_policy"::text::"RuntimeRoutingFallbackPolicy"),
  ALTER COLUMN "fallback_policy" SET DEFAULT 'WAIT';

DROP TYPE "RuntimeRoutingFallbackPolicy_old";

COMMIT;
