-- AlterTable
ALTER TABLE "task_execution_spans" ADD COLUMN "runtime" TEXT;

-- AlterTable
ALTER TABLE "task_stage_attempts" ADD COLUMN "executor" TEXT;
