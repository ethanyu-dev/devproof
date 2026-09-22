import type { Prisma } from "@prisma/client";

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

export interface DiffDispatchCase {
  id: string;
  definitionHash: string;
}

export interface DiffDispatchCandidate {
  id: string;
  caseId: string;
  deploymentId: string;
  definitionHash: string;
  /** Terminal run of the previous round; absent when the Case did not run. */
  run: {
    lifecycle: string;
    executionDisposition: string | null;
    writeOutcomeUnknown: boolean;
  } | null;
}

/**
 * DIFF re-analysis planning: changed/new Cases dispatch normally; unchanged
 * Cases whose previous execution finished cleanly are carried over instead of
 * running the browser again. Matches Cases across snapshots by definitionHash.
 */
export function planDiffDispatch(
  taskExecutionId: string,
  cases: readonly DiffDispatchCase[],
  deployments: readonly { id: string }[],
  candidates: readonly DiffDispatchCandidate[],
): {
  rows: Array<Prisma.TaskCaseExecutionCreateManyInput>;
  carriedCount: number;
  dispatchedCount: number;
} {
  const used = new Set<string>();
  const rows: Array<Prisma.TaskCaseExecutionCreateManyInput> = [];
  let carriedCount = 0;
  for (const testCase of cases) {
    for (const deployment of deployments) {
      const candidate = candidates.find(
        (item) =>
          item.deploymentId === deployment.id &&
          item.definitionHash === testCase.definitionHash &&
          !used.has(item.id),
      );
      const carry =
        candidate?.run &&
        candidate.run.lifecycle === "COMPLETED" &&
        candidate.run.executionDisposition === "EXECUTED" &&
        !candidate.run.writeOutcomeUnknown;
      if (carry && candidate) {
        used.add(candidate.id);
        carriedCount += 1;
        rows.push({
          caseId: testCase.id,
          deploymentId: deployment.id,
          executionOrdinal: 1,
          dispatchStatus: "CARRIED_OVER",
          carriedFromExecutionId: candidate.id,
          taskExecutionId,
        });
      } else {
        rows.push({
          caseId: testCase.id,
          deploymentId: deployment.id,
          executionOrdinal: 1,
          taskExecutionId,
        });
      }
    }
  }
  return { rows, carriedCount, dispatchedCount: rows.length - carriedCount };
}
