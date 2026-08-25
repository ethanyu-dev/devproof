CREATE TABLE "task_analysis_sources" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "task_execution_id" UUID NOT NULL,
    "stage_attempt_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "revision" TEXT,
    "locator" JSONB NOT NULL DEFAULT '{}',
    "content" JSONB NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_analysis_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_analysis_sources_external_id_key"
    ON "task_analysis_sources"("external_id");
CREATE INDEX "task_analysis_sources_task_execution_id_stage_attempt_id_created_at_idx"
    ON "task_analysis_sources"("task_execution_id", "stage_attempt_id", "created_at");
CREATE INDEX "task_analysis_sources_stage_attempt_id_kind_idx"
    ON "task_analysis_sources"("stage_attempt_id", "kind");

ALTER TABLE "task_analysis_sources"
    ADD CONSTRAINT "task_analysis_sources_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_analysis_sources"
    ADD CONSTRAINT "task_analysis_sources_task_execution_id_fkey"
    FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_analysis_sources"
    ADD CONSTRAINT "task_analysis_sources_stage_attempt_id_fkey"
    FOREIGN KEY ("stage_attempt_id") REFERENCES "task_stage_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
