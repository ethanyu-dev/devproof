ALTER TABLE "agent_runtime_tasks"
ADD COLUMN "last_meaningful_progress_key" TEXT,
ADD COLUMN "last_deadline_extension_progress_key" TEXT;
