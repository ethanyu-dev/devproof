import type { TaskCase, TaskCaseExecution } from "./task-types";

export function caseDescription(definition: TaskCase["definition"]) {
  const criteria = definition.criteria
    ?.map((criterion) => criterion.description.trim())
    .filter(Boolean);
  const expected = definition.expected
    ?.map((item) => item.trim())
    .filter(Boolean);
  const descriptions = criteria?.length
    ? criteria
    : expected?.length
      ? expected
      : definition.steps.map((step) => step.action.trim()).filter(Boolean);
  return descriptions.join("；") || "暂无用例描述。";
}

export function latestTaskCaseExecutions(
  executions: readonly TaskCaseExecution[],
) {
  const latest = new Map<string, TaskCaseExecution>();
  for (const execution of executions) {
    const previous = latest.get(execution.deployment.id);
    if (!previous || execution.executionOrdinal > previous.executionOrdinal) {
      latest.set(execution.deployment.id, execution);
    }
  }
  return [...latest.values()];
}
