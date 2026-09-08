#!/usr/bin/env node
// Requires psql and the same disposable database guard as concurrency tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const url = new URL(
  process.env.DEVPROOF_CONCURRENCY_TEST_DATABASE_URL ?? "http://invalid",
);
if (
  url.hostname !== "127.0.0.1" ||
  url.username !== "devproof_test" ||
  !/^\/devproof_concurrency_test_[a-f\d]{8}$/u.test(url.pathname)
) {
  throw new Error(
    "Use a disposable local concurrency-test database, never a production database.",
  );
}
const schema = `retirement_test_${randomBytes(8).toString("hex")}`;
const migrations = fileURLToPath(
  new URL("../prisma/migrations/", import.meta.url),
);
const retirement = "20260907193000_retire_post_run_analysis";
const sql = (name) =>
  readFileSync(`${migrations}/${name}/migration.sql`, "utf8");
function query(input, { allowFailure = false } = {}) {
  const result = spawnSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: url.username,
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: url.pathname.slice(1),
      PGOPTIONS: `-c search_path=${schema} -c timezone=UTC`,
    },
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(result.stderr);
  return result;
}
function equals(input, expected) {
  assert.equal(query(input).stdout.trim(), expected);
}
try {
  query(`CREATE SCHEMA "${schema}";`);
  for (const name of readdirSync(migrations)
    .filter((name) => /^\d/u.test(name) && name < retirement)
    .sort())
    query(sql(name));
  query(`
    INSERT INTO teams (id,slug,name,feishu_tenant_key,updated_at)
    VALUES ('00000000-0000-4000-8000-000000000001','retirement','Retirement','fixture',now());
    INSERT INTO users (id,name,updated_at)
    VALUES ('00000000-0000-4000-8000-000000000002','Fixture',now());
    INSERT INTO task_executions (id,team_id,kind,source_kind,idempotency_key,title,input_snapshot,trace_id,deadline_at,updated_at,post_run_analysis_generation)
    VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','ISSUE_SPEC','PLAYGROUND','fixture','Keep task','{}',repeat('a',32),now(),now(),7);
    INSERT INTO notification_outbox (id,team_id,task_execution_id,event_type,dedupe_key,payload,updated_at)
    VALUES (gen_random_uuid(),'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','TASK_COMPLETED','fixture','{"generation":7}',now());
    INSERT INTO agent_runtime_credentials (id,team_id,name,token_hash,token_hint,pool,updated_at)
    SELECT gen_random_uuid(),'00000000-0000-4000-8000-000000000001',pool,pool,'fixture',pool::"AgentRuntimePool",now()
    FROM unnest(ARRAY['SPEC_ANALYSIS','BROWSER_EXECUTION','POST_RUN_ANALYSIS']) pool;
    INSERT INTO agent_model_configurations (id,team_id,pool,base_url,api_key_encrypted,api_key_hint,model_id,display_name,position,configured_by_user_id,updated_at)
    SELECT gen_random_uuid(),'00000000-0000-4000-8000-000000000001',pool::"AgentRuntimePool",'https://example.invalid','fixture','fixture','fixture',pool,0,'00000000-0000-4000-8000-000000000002',now()
    FROM unnest(ARRAY['SPEC_ANALYSIS','BROWSER_EXECUTION','POST_RUN_ANALYSIS']) pool;
    INSERT INTO post_run_analysis_jobs (id,team_id,task_execution_id,analyzer_version,deadline_at,updated_at,status,lease_expires_at,input_storage_key,capture_storage_key,capture_evidence_storage_key,input_manifest)
    VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','fixture',now(),now(),'RUNNING',now()+interval '1 hour','analysis/input','analysis/shared','analysis/evidence','{"_structuredEvidenceStorageKey":"analysis/shared"}');
    INSERT INTO post_run_analysis_events (id,team_id,analysis_id,actor,kind)
    VALUES (gen_random_uuid(),'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','fixture','completed');
    INSERT INTO improvement_work_items (id,team_id,source_task_execution_id,analysis_id,dedupe_key,title,body,finding_count,updated_at)
    VALUES ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004',repeat('a',64),'Archived report','Fixture',1,now());
    INSERT INTO analysis_findings (id,team_id,analysis_id,work_item_id,fingerprint,category,severity,confidence,title,root_cause,impact,recommendation,component,phase,failure_class)
    VALUES (gen_random_uuid(),'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005',repeat('b',64),'fixture','LOW',0.9,'Fixture','Fixture','Fixture','Fixture','fixture','fixture','fixture');
    INSERT INTO object_storage_deletion_tasks (id,storage_key,attempts,lease_token,updated_at)
    VALUES (gen_random_uuid(),'analysis/shared',3,'00000000-0000-4000-8000-000000000006',now());
  `);
  const blocked = query(sql(retirement), { allowFailure: true });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /wait for its active leases/u);
  equals("SELECT count(*) FROM post_run_analysis_jobs", "1");
  equals(
    "SELECT count(*) FROM agent_runtime_credentials WHERE revoked_at IS NOT NULL",
    "0",
  );
  equals("SELECT count(*) FROM object_storage_deletion_tasks", "1");
  query(
    "UPDATE post_run_analysis_jobs SET lease_expires_at=now()-interval '1 second';",
  );
  query(sql(retirement));
  equals("SELECT execution_generation FROM task_executions", "7");
  equals("SELECT payload->>'generation' FROM notification_outbox", "7");
  equals("SELECT source_kind FROM task_executions", "PLAYGROUND");
  equals(
    "SELECT string_agg(pool::text,',' ORDER BY pool::text) FROM agent_model_configurations",
    "BROWSER_EXECUTION,SPEC_ANALYSIS",
  );
  equals(
    "SELECT string_agg(pool::text,',' ORDER BY pool::text) FROM agent_runtime_credentials WHERE revoked_at IS NULL",
    "BROWSER_EXECUTION,SPEC_ANALYSIS",
  );
  equals(
    "SELECT count(*) FROM agent_runtime_credentials WHERE pool='POST_RUN_ANALYSIS' AND revoked_at IS NOT NULL",
    "1",
  );
  equals(
    "SELECT string_agg(storage_key,',' ORDER BY storage_key) FROM object_storage_deletion_tasks",
    "analysis/evidence,analysis/input,analysis/shared",
  );
  equals(
    "SELECT attempts || ':' || lease_token FROM object_storage_deletion_tasks WHERE storage_key='analysis/shared'",
    "3:00000000-0000-4000-8000-000000000006",
  );
  equals(
    "SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('post_run_analysis_jobs','post_run_analysis_events','analysis_findings','improvement_work_items')",
    "0",
  );
  console.log(
    "Retirement migration passed: populated history, active-lease rollback, preserved task/notification generations, scoped credentials/models, deduplicated durable object cleanup.",
  );
} finally {
  query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
}
