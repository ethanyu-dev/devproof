-- Runtime bindings carry the same tenant as the Test Run they execute.
CREATE UNIQUE INDEX "browser_runtime_sessions_id_team_id_key"
  ON "browser_runtime_sessions"("id", "team_id");

ALTER TABLE "test_runs"
  ADD CONSTRAINT "test_runs_runtime_session_team_fkey"
  FOREIGN KEY ("runtime_session_id", "team_id")
  REFERENCES "browser_runtime_sessions"("id", "team_id")
  ON DELETE SET NULL ("runtime_session_id") ON UPDATE CASCADE;

-- Enforce semantic lineage that cannot be expressed by independent foreign keys.
CREATE FUNCTION "validate_test_run_lineage"()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "test_cases"
    WHERE "id" = NEW."case_id"
      AND "project_id" = NEW."project_id"
      AND "team_id" = NEW."team_id"
  ) THEN
    RAISE EXCEPTION 'test run case does not belong to its project'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "test_case_versions"
    WHERE "id" = NEW."case_version_id"
      AND "case_id" = NEW."case_id"
      AND "team_id" = NEW."team_id"
  ) THEN
    RAISE EXCEPTION 'test run version does not belong to its case'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "test_environments"
    WHERE "id" = NEW."environment_id"
      AND "project_id" = NEW."project_id"
      AND "team_id" = NEW."team_id"
  ) THEN
    RAISE EXCEPTION 'test run environment does not belong to its project'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "test_runs_validate_lineage"
BEFORE INSERT ON "test_runs"
FOR EACH ROW EXECUTE FUNCTION "validate_test_run_lineage"();

-- Artifact links may only point to Runtime artifacts from the same Team and,
-- after a Run is bound, from the exact Runtime Session used by that Run.
CREATE FUNCTION "validate_test_run_runtime_artifact"()
RETURNS trigger AS $$
BEGIN
  IF NEW."runtime_artifact_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "browser_runtime_artifacts" AS artifact
    JOIN "browser_runtime_sessions" AS session
      ON session."id" = artifact."session_id"
    JOIN "test_runs" AS run
      ON run."id" = NEW."run_id" AND run."team_id" = NEW."team_id"
    WHERE artifact."id" = NEW."runtime_artifact_id"
      AND session."team_id" = NEW."team_id"
      AND (
        run."runtime_session_id" IS NULL
        OR run."runtime_session_id" = artifact."session_id"
      )
  ) THEN
    RAISE EXCEPTION 'runtime artifact does not belong to the run tenant or session'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "test_run_artifacts_validate_runtime_source"
BEFORE INSERT OR UPDATE OF "runtime_artifact_id", "run_id", "team_id"
ON "test_run_artifacts"
FOR EACH ROW EXECUTE FUNCTION "validate_test_run_runtime_artifact"();

-- JSON shapes are deliberately constrained so raw SQL writers cannot bypass
-- the v1 contracts and leave unreadable evidence in the store.
ALTER TABLE "test_environments"
  ADD CONSTRAINT "test_environments_variables_object"
    CHECK (jsonb_typeof("variables") = 'object'),
  ADD CONSTRAINT "test_environments_secret_keys_array"
    CHECK (jsonb_typeof("secret_keys") = 'array');

ALTER TABLE "test_case_versions"
  ADD CONSTRAINT "test_case_versions_definition_v1"
    CHECK (
      jsonb_typeof("definition") = 'object'
      AND "definition" @> '{"schemaVersion": 1}'::jsonb
    );

ALTER TABLE "test_runs"
  ADD CONSTRAINT "test_runs_definition_snapshot_v1"
    CHECK (
      jsonb_typeof("definition_snapshot") = 'object'
      AND "definition_snapshot" @> '{"schemaVersion": 1}'::jsonb
    ),
  ADD CONSTRAINT "test_runs_environment_snapshot_object"
    CHECK (jsonb_typeof("environment_snapshot") = 'object');

ALTER TABLE "test_run_trace_events"
  ADD CONSTRAINT "test_run_trace_events_payload_object"
    CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "test_run_artifacts"
  ADD CONSTRAINT "test_run_artifacts_metadata_object"
    CHECK (jsonb_typeof("metadata") = 'object');

ALTER TABLE "test_run_human_checkpoints"
  ADD CONSTRAINT "test_run_human_checkpoints_context_object"
    CHECK (jsonb_typeof("context") = 'object'),
  ADD CONSTRAINT "test_run_human_checkpoints_response_object"
    CHECK ("response" IS NULL OR jsonb_typeof("response") = 'object'),
  ADD CONSTRAINT "test_run_human_checkpoints_resolution_complete"
    CHECK (
      "status" <> 'RESOLVED'
      OR (
        "response" IS NOT NULL
        AND "resolved_by_user_id" IS NOT NULL
        AND "resolved_at" IS NOT NULL
      )
    );
