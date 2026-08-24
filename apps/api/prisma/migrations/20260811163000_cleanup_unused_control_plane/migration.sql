ALTER TABLE "runtime_settings"
  DROP COLUMN "default_model_config_id",
  DROP COLUMN "max_concurrency",
  DROP COLUMN "run_timeout_seconds",
  DROP COLUMN "trace_retention_days",
  DROP COLUMN "browser_model_config_id",
  DROP COLUMN "browser_max_steps",
  DROP COLUMN "browser_timeout_seconds";

DROP TABLE "linear_connections";
DROP TABLE "mcp_server_configs";
DROP TABLE "model_configs";
