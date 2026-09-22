-- AlterEnum
ALTER TYPE "TaskCaseDispatchStatus" ADD VALUE 'CARRIED_OVER';

-- AlterTable
ALTER TABLE "task_case_executions" ADD COLUMN     "carried_from_execution_id" UUID;

-- AddForeignKey
ALTER TABLE "task_case_executions" ADD CONSTRAINT "task_case_executions_carried_from_execution_id_fkey" FOREIGN KEY ("carried_from_execution_id") REFERENCES "task_case_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
