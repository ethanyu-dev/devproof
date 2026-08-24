-- DropForeignKey
ALTER TABLE "test_case_versions" DROP CONSTRAINT "test_case_versions_case_team_fkey";

-- DropForeignKey
ALTER TABLE "test_cases" DROP CONSTRAINT "test_cases_project_team_fkey";

-- DropForeignKey
ALTER TABLE "test_environments" DROP CONSTRAINT "test_environments_project_team_fkey";

-- DropForeignKey
ALTER TABLE "test_run_artifacts" DROP CONSTRAINT "test_run_artifacts_run_team_fkey";

-- DropForeignKey
ALTER TABLE "test_run_artifacts" DROP CONSTRAINT "test_run_artifacts_trace_event_team_fkey";

-- DropForeignKey
ALTER TABLE "test_run_human_checkpoints" DROP CONSTRAINT "test_run_human_checkpoints_run_team_fkey";

-- DropForeignKey
ALTER TABLE "test_run_human_checkpoints" DROP CONSTRAINT "test_run_human_checkpoints_trace_event_team_fkey";

-- DropForeignKey
ALTER TABLE "test_run_trace_events" DROP CONSTRAINT "test_run_trace_events_run_team_fkey";

-- DropForeignKey
ALTER TABLE "test_runs" DROP CONSTRAINT "test_runs_case_team_fkey";

-- DropForeignKey
ALTER TABLE "test_runs" DROP CONSTRAINT "test_runs_case_version_team_fkey";

-- DropForeignKey
ALTER TABLE "test_runs" DROP CONSTRAINT "test_runs_environment_team_fkey";

-- DropForeignKey
ALTER TABLE "test_runs" DROP CONSTRAINT "test_runs_project_team_fkey";

-- DropForeignKey
ALTER TABLE "test_runs" DROP CONSTRAINT "test_runs_runtime_session_team_fkey";

-- DropIndex
DROP INDEX "browser_runtime_sessions_id_team_id_key";

-- DropIndex
DROP INDEX "test_case_versions_id_team_id_key";

-- DropIndex
DROP INDEX "test_cases_id_team_id_key";

-- DropIndex
DROP INDEX "test_environments_id_team_id_key";

-- DropIndex
DROP INDEX "test_projects_id_team_id_key";

-- DropIndex
DROP INDEX "test_run_trace_events_id_team_id_key";

-- DropIndex
DROP INDEX "test_runs_id_team_id_key";

-- AlterTable
ALTER TABLE "object_storage_deletion_tasks" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "verification_assertions" ALTER COLUMN "id" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "generated_test_cases_specification_id_generation_version_positi" RENAME TO "generated_test_cases_specification_id_generation_version_po_key";

-- RenameIndex
ALTER INDEX "generated_test_cases_team_id_specification_id_generation_versio" RENAME TO "generated_test_cases_team_id_specification_id_generation_ve_idx";

-- RenameIndex
ALTER INDEX "object_storage_deletion_tasks_next_attempt_at_lease_expires_at_" RENAME TO "object_storage_deletion_tasks_next_attempt_at_lease_expires_idx";
