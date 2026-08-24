-- Keep tenant ownership consistent across the complete test-data lineage.
CREATE UNIQUE INDEX "test_projects_id_team_id_key"
  ON "test_projects"("id", "team_id");
CREATE UNIQUE INDEX "test_environments_id_team_id_key"
  ON "test_environments"("id", "team_id");
CREATE UNIQUE INDEX "test_cases_id_team_id_key"
  ON "test_cases"("id", "team_id");
CREATE UNIQUE INDEX "test_case_versions_id_team_id_key"
  ON "test_case_versions"("id", "team_id");
CREATE UNIQUE INDEX "test_runs_id_team_id_key"
  ON "test_runs"("id", "team_id");
CREATE UNIQUE INDEX "test_run_trace_events_id_team_id_key"
  ON "test_run_trace_events"("id", "team_id");

ALTER TABLE "test_environments"
  ADD CONSTRAINT "test_environments_project_team_fkey"
  FOREIGN KEY ("project_id", "team_id")
  REFERENCES "test_projects"("id", "team_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "test_cases"
  ADD CONSTRAINT "test_cases_project_team_fkey"
  FOREIGN KEY ("project_id", "team_id")
  REFERENCES "test_projects"("id", "team_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "test_case_versions"
  ADD CONSTRAINT "test_case_versions_case_team_fkey"
  FOREIGN KEY ("case_id", "team_id")
  REFERENCES "test_cases"("id", "team_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "test_runs"
  ADD CONSTRAINT "test_runs_project_team_fkey"
  FOREIGN KEY ("project_id", "team_id")
  REFERENCES "test_projects"("id", "team_id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "test_runs_case_team_fkey"
  FOREIGN KEY ("case_id", "team_id")
  REFERENCES "test_cases"("id", "team_id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "test_runs_case_version_team_fkey"
  FOREIGN KEY ("case_version_id", "team_id")
  REFERENCES "test_case_versions"("id", "team_id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "test_runs_environment_team_fkey"
  FOREIGN KEY ("environment_id", "team_id")
  REFERENCES "test_environments"("id", "team_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "test_run_trace_events"
  ADD CONSTRAINT "test_run_trace_events_run_team_fkey"
  FOREIGN KEY ("run_id", "team_id")
  REFERENCES "test_runs"("id", "team_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "test_run_artifacts"
  ADD CONSTRAINT "test_run_artifacts_run_team_fkey"
  FOREIGN KEY ("run_id", "team_id")
  REFERENCES "test_runs"("id", "team_id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "test_run_artifacts_trace_event_team_fkey"
  FOREIGN KEY ("trace_event_id", "team_id")
  REFERENCES "test_run_trace_events"("id", "team_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "test_run_human_checkpoints"
  ADD CONSTRAINT "test_run_human_checkpoints_run_team_fkey"
  FOREIGN KEY ("run_id", "team_id")
  REFERENCES "test_runs"("id", "team_id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "test_run_human_checkpoints_trace_event_team_fkey"
  FOREIGN KEY ("trace_event_id", "team_id")
  REFERENCES "test_run_trace_events"("id", "team_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "test_cases"
  ADD CONSTRAINT "test_cases_latest_version_nonnegative"
  CHECK ("latest_version_number" >= 0);
ALTER TABLE "test_case_versions"
  ADD CONSTRAINT "test_case_versions_version_positive"
  CHECK ("version" > 0);
ALTER TABLE "test_runs"
  ADD CONSTRAINT "test_runs_trace_schema_version_positive"
  CHECK ("trace_schema_version" > 0);
ALTER TABLE "test_run_trace_events"
  ADD CONSTRAINT "test_run_trace_events_duration_nonnegative"
  CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0);
ALTER TABLE "test_run_artifacts"
  ADD CONSTRAINT "test_run_artifacts_has_storage_source"
  CHECK ("runtime_artifact_id" IS NOT NULL OR "storage_key" IS NOT NULL);

-- A published case version is a content-addressed record and must never change.
CREATE FUNCTION "reject_test_case_version_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'test case versions are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "test_case_versions_immutable"
BEFORE UPDATE OR DELETE ON "test_case_versions"
FOR EACH ROW EXECUTE FUNCTION "reject_test_case_version_mutation"();

-- Run lineage and snapshots are immutable while lifecycle fields remain writable.
CREATE FUNCTION "protect_test_run_lineage"()
RETURNS trigger AS $$
BEGIN
  IF OLD."team_id" IS DISTINCT FROM NEW."team_id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."case_id" IS DISTINCT FROM NEW."case_id"
    OR OLD."case_version_id" IS DISTINCT FROM NEW."case_version_id"
    OR OLD."environment_id" IS DISTINCT FROM NEW."environment_id"
    OR OLD."requested_by_user_id" IS DISTINCT FROM NEW."requested_by_user_id"
    OR OLD."trigger" IS DISTINCT FROM NEW."trigger"
    OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
    OR OLD."definition_snapshot" IS DISTINCT FROM NEW."definition_snapshot"
    OR OLD."environment_snapshot" IS DISTINCT FROM NEW."environment_snapshot"
    OR OLD."trace_schema_version" IS DISTINCT FROM NEW."trace_schema_version"
  THEN
    RAISE EXCEPTION 'test run lineage and snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "test_runs_protect_lineage"
BEFORE UPDATE ON "test_runs"
FOR EACH ROW EXECUTE FUNCTION "protect_test_run_lineage"();

-- Trace events form the append-only evidence stream used by replay and analysis.
CREATE FUNCTION "reject_test_trace_event_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'test run trace events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "test_run_trace_events_append_only"
BEFORE UPDATE OR DELETE ON "test_run_trace_events"
FOR EACH ROW EXECUTE FUNCTION "reject_test_trace_event_mutation"();
