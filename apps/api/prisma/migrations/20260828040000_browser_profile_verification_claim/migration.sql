ALTER TYPE "UserBrowserProfileStatus" ADD VALUE 'VERIFYING' AFTER 'PREPARING';

ALTER TABLE "user_browser_profiles"
ADD COLUMN "verification_rules_version" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "task_profile_bindings_requested_source_status_idx"
ON "task_profile_bindings"("requested_profile_id", "trigger_source", "status");
