import { taskExecutionCreateInputSchema } from "@devproof/contracts";

export function refreshedTaskDeadline(inputSnapshot: unknown, resumedAt: Date) {
  const input = taskExecutionCreateInputSchema.parse(inputSnapshot);
  const deadlineSeconds =
    input.kind === "ISSUE_SPEC"
      ? input.deadlineSeconds
      : input.run.deadlineSeconds;
  return new Date(resumedAt.getTime() + deadlineSeconds * 1_000);
}
