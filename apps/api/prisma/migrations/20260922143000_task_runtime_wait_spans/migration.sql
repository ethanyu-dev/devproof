-- Run and case spans name the browser runtime. Task spans stay null so a
-- pre-claim queue is not frozen as analysis. In-run lease recovery and data
-- locks insert a queue span; older rows are left unknown inside the run union.
CREATE OR REPLACE FUNCTION task_metrics_state_change() RETURNS trigger LANGUAGE plpgsql AS $$
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
    -- A finished recovery is TERMINAL + LEASE_RECOVERY. Close the open span
    -- and do not start another, or time after the run stays queued.
    ELSIF NEW.run_id IS NOT NULL
      AND NEW.scheduling->>'state' IS DISTINCT FROM 'TERMINAL'
      AND (
        NEW.scheduling->>'state' = 'RECOVERING'
        OR reason IN ('LEASE_RECOVERY', 'DATA_LOCK')
      ) THEN
      category := 'QUEUE';
    END IF;
  END IF;
  prefix := 'state:' || TG_TABLE_NAME || ':' || NEW.id::text || ':';
  UPDATE task_execution_spans SET finished_at = stamp WHERE task_execution_id = task_id AND id LIKE prefix || '%' AND finished_at IS NULL;
  IF category IS NOT NULL THEN
    INSERT INTO task_execution_spans (id, team_id, task_execution_id, lane, label, activity, scope, started_at, estimated, runtime)
    VALUES (
      prefix || stamp::text,
      team_id,
      task_id,
      lane_id,
      COALESCE(reason, category),
      category,
      'EXECUTION',
      stamp,
      false,
      CASE WHEN TG_TABLE_NAME = 'task_executions' THEN NULL ELSE 'BROWSER' END
    );
  END IF;
  INSERT INTO task_execution_metrics (task_execution_id, revision) VALUES (task_id, 1)
  ON CONFLICT (task_execution_id) DO UPDATE SET revision = task_execution_metrics.revision + 1, dirty = true;
  RETURN NEW;
END;
$$;
