-- CreateTable
CREATE TABLE "task_model_call_usage" (
    "lease_key" TEXT,
    "id" TEXT NOT NULL,
    "team_id" UUID NOT NULL,
    "task_execution_id" UUID NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'EXECUTION',
    "stage" TEXT NOT NULL,
    "run_id" UUID,
    "attempt_number" INTEGER,
    "owner_id" TEXT NOT NULL,
    "segment_id" TEXT,
    "configuration_id" TEXT,
    "configuration_name" TEXT,
    "requested_model" TEXT NOT NULL,
    "response_model" TEXT,
    "response_id" TEXT,
    "started_at" TIMESTAMPTZ,
    "duration_ms" BIGINT,
    "outcome" TEXT NOT NULL DEFAULT 'RUNNING',
    "input_tokens" BIGINT,
    "output_tokens" BIGINT,
    "cache_read_tokens" BIGINT,
    "raw_usage" JSONB,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "normalization_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_model_call_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_execution_spans" (
    "id" TEXT NOT NULL,
    "team_id" UUID NOT NULL,
    "task_execution_id" UUID NOT NULL,
    "lane" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'EXECUTION',
    "started_at" TIMESTAMPTZ NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "estimated" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "task_execution_spans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_execution_metrics" (
    "history_backfilled" BOOLEAN NOT NULL DEFAULT false,
    "analysis_cursor" BIGINT NOT NULL DEFAULT 0,
    "run_cursor" BIGINT NOT NULL DEFAULT 0,
    "task_execution_id" UUID NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "projected_revision" BIGINT NOT NULL DEFAULT -1,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "computed_at" TIMESTAMPTZ,
    "dirty" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "task_execution_metrics_pkey" PRIMARY KEY ("task_execution_id")
);

-- CreateIndex
CREATE INDEX "task_model_call_usage_team_id_task_execution_id_scope_id_idx" ON "task_model_call_usage"("team_id", "task_execution_id", "scope", "id");

-- CreateIndex
CREATE INDEX "task_execution_spans_team_id_task_execution_id_started_at_i_idx" ON "task_execution_spans"("team_id", "task_execution_id", "started_at", "id");

-- CreateIndex
CREATE INDEX "task_execution_metrics_dirty_computed_at_idx" ON "task_execution_metrics"("dirty", "computed_at");

-- AddForeignKey
ALTER TABLE "task_model_call_usage" ADD CONSTRAINT "task_model_call_usage_task_execution_id_fkey" FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_execution_spans" ADD CONSTRAINT "task_execution_spans_task_execution_id_fkey" FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_execution_metrics" ADD CONSTRAINT "task_execution_metrics_task_execution_id_fkey" FOREIGN KEY ("task_execution_id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Capture state boundaries in the same transaction as the authoritative transition.
-- These triggers never modify execution state or make scheduling decisions.
CREATE FUNCTION task_metrics_state_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  team_id uuid;
  lane_id text;
  category text;
  reason text;
  stamp timestamptz := clock_timestamp();
  prefix text;
BEGIN
  IF TG_TABLE_NAME = 'task_executions' THEN
    task_id := NEW.id; team_id := NEW.team_id; lane_id := NEW.id::text;
    IF TG_OP = 'UPDATE' AND NEW.lifecycle = OLD.lifecycle AND NEW.current_stage = OLD.current_stage AND NEW.waiting_reason IS NOT DISTINCT FROM OLD.waiting_reason AND NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at THEN RETURN NEW; END IF;
    category := CASE NEW.lifecycle::text WHEN 'QUEUED' THEN 'QUEUE' WHEN 'WAITING_INPUT' THEN 'HUMAN' WHEN 'WAITING_HUMAN' THEN 'HUMAN' END;
    reason := COALESCE(NEW.waiting_reason, NEW.lifecycle::text);
  ELSIF TG_TABLE_NAME = 'execution_runs' THEN
    task_id := NEW.task_execution_id; team_id := NEW.team_id; lane_id := NEW.id::text;
    IF task_id IS NULL THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND NEW.lifecycle = OLD.lifecycle AND NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at THEN RETURN NEW; END IF;
    category := CASE NEW.lifecycle::text WHEN 'QUEUED' THEN 'QUEUE' WHEN 'PREPARING' THEN 'QUEUE' WHEN 'WAITING_HUMAN' THEN 'HUMAN' END;
    reason := NEW.lifecycle::text;
  ELSE
    task_id := NEW.task_execution_id;
    SELECT t.team_id INTO team_id FROM task_executions t WHERE t.id = task_id;
    lane_id := COALESCE(NEW.run_id::text, NEW.id::text);
    IF TG_OP = 'UPDATE' AND (NEW.scheduling->>'state') IS NOT DISTINCT FROM (OLD.scheduling->>'state') AND (NEW.scheduling->>'reason') IS NOT DISTINCT FROM (OLD.scheduling->>'reason') AND NEW.run_id IS NOT DISTINCT FROM OLD.run_id THEN RETURN NEW; END IF;
    reason := NEW.scheduling->>'reason';
    IF NEW.run_id IS NULL AND NEW.scheduling->>'state' IN ('WAITING','READY','ADMITTED','RECOVERING') THEN
      category := CASE reason WHEN 'CASE_DEPENDENCY' THEN 'DEPENDENCY' WHEN 'RETRY_BACKOFF' THEN 'BACKOFF' ELSE 'QUEUE' END;
    END IF;
  END IF;
  prefix := 'state:' || TG_TABLE_NAME || ':' || NEW.id::text || ':';
  UPDATE task_execution_spans SET finished_at = stamp WHERE task_execution_id = task_id AND id LIKE prefix || '%' AND finished_at IS NULL;
  IF category IS NOT NULL THEN
    INSERT INTO task_execution_spans (id, team_id, task_execution_id, lane, label, activity, scope, started_at, estimated)
    VALUES (prefix || stamp::text, team_id, task_id, lane_id, COALESCE(reason,category), category, 'EXECUTION', stamp, false);
  END IF;
  INSERT INTO task_execution_metrics (task_execution_id, revision) VALUES (task_id,1)
  ON CONFLICT (task_execution_id) DO UPDATE SET revision = task_execution_metrics.revision+1, dirty=true;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_metrics_task_state AFTER INSERT OR UPDATE ON task_executions FOR EACH ROW EXECUTE FUNCTION task_metrics_state_change();
CREATE TRIGGER task_metrics_run_state AFTER INSERT OR UPDATE ON execution_runs FOR EACH ROW EXECUTE FUNCTION task_metrics_state_change();
CREATE TRIGGER task_metrics_case_state AFTER INSERT OR UPDATE ON task_case_executions FOR EACH ROW EXECUTE FUNCTION task_metrics_state_change();
CREATE FUNCTION task_metrics_review_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO task_execution_metrics (task_execution_id, revision) VALUES (NEW.task_execution_id,1)
  ON CONFLICT (task_execution_id) DO UPDATE SET revision = task_execution_metrics.revision+1, dirty=true;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_metrics_review AFTER INSERT OR UPDATE ON task_acceptance_reviews FOR EACH ROW EXECUTE FUNCTION task_metrics_review_change();
CREATE TRIGGER task_metrics_stage AFTER INSERT OR UPDATE ON task_execution_stages FOR EACH ROW EXECUTE FUNCTION task_metrics_review_change();
