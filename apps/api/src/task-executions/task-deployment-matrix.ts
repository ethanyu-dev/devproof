export function taskDeploymentMatrix(
  taskExecutionId: string,
  cases: readonly { id: string }[],
  deployments: readonly { id: string }[],
) {
  return cases.flatMap((testCase) =>
    deployments.map((deployment) => ({
      caseId: testCase.id,
      deploymentId: deployment.id,
      executionOrdinal: 1,
      taskExecutionId,
    })),
  );
}
