import { ConflictException } from "@nestjs/common";

export function initializeExecutionBudget(input: {
  now: Date;
  seconds: number;
  extensionSeconds: number;
  parentDeadlineAt: Date | null;
}) {
  const cap = input.parentDeadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const deadlineAt = new Date(
    Math.min(cap, input.now.getTime() + input.seconds * 1_000),
  );
  const hardDeadlineAt = new Date(
    Math.min(cap, deadlineAt.getTime() + input.extensionSeconds * 1_000),
  );
  if (deadlineAt <= input.now)
    throw new ConflictException("The parent task deadline has elapsed.");
  return { deadlineAt, hardDeadlineAt };
}
