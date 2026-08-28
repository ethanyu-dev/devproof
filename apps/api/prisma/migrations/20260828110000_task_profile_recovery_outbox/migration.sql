CREATE TYPE "TaskProfileRecoveryStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED'
);

CREATE TABLE "task_profile_recovery_events" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "profile_id" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "resumed_at" TIMESTAMPTZ NOT NULL,
  "status" "TaskProfileRecoveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cursor_task_id" UUID,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ,
  "last_error" TEXT,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "task_profile_recovery_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_profile_recovery_events_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_profile_recovery_events_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "user_browser_profiles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "task_profile_recovery_events_status_retry_idx"
  ON "task_profile_recovery_events"(
    "status",
    "next_attempt_at",
    "lease_expires_at"
  );
CREATE INDEX "task_profile_recovery_events_profile_created_idx"
  ON "task_profile_recovery_events"("profile_id", "created_at");
