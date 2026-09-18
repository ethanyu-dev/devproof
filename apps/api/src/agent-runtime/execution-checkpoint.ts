import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  executionStateSchema,
  runtimeEvidenceCatalogSchema,
  missingRequiredEvidenceKinds,
  browserExecutionCriterion,
  savedCriterionObservationSchema,
  testAccountBindingsSchema,
  runtimeCriterionResultSchema,
  runtimeEvidenceRefSchema,
  runtimeTaskSnapshotSchema,
} from "@devproof/agent-runtime-protocol";
import { z } from "zod";
const progressSchema = z.object({
  bindingIds: z.array(z.string().uuid()).max(2000).optional(),
  comparisonReviewIds: z.array(z.string().uuid()).max(100).optional(),
  observations: z.array(savedCriterionObservationSchema).max(200).optional(),
  criteria: z.array(runtimeCriterionResultSchema).max(100),
  evidence: z.array(runtimeEvidenceRefSchema).max(2000),
  evidenceCatalog: runtimeEvidenceCatalogSchema.optional(),
});
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export async function saveExecutionCheckpoint(
  tx: Prisma.TransactionClient,
  task: { id: string; runId: string; snapshot: unknown },
  payload: Record<string, unknown>,
) {
  const parsedState = executionStateSchema.safeParse(payload.executionState);
  const parsedProgress = progressSchema
    .optional()
    .safeParse(payload.verificationCheckpoint);
  if (!parsedState.success || !parsedProgress.success) {
    throw new BadRequestException({
      code: "INVALID_EXECUTION_CHECKPOINT",
      message: "执行进度格式不合法，请修正字段后重新保存。",
      issues: [
        ...(!parsedState.success
          ? parsedState.error.issues.map((issue) => ({
              path: ["executionState", ...issue.path].join("."),
              code: issue.code,
            }))
          : []),
        ...(!parsedProgress.success
          ? parsedProgress.error.issues.map((issue) => ({
              path: ["verificationCheckpoint", ...issue.path].join("."),
              code: issue.code,
            }))
          : []),
      ],
    });
  }
  const state = parsedState.data;
  const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
  const progress = parsedProgress.data;
  if (
    progress?.evidenceCatalog &&
    (progress.evidenceCatalog.runId !== task.runId ||
      progress.evidenceCatalog.attemptId !== snapshot.attemptId)
  )
    throw new BadRequestException(
      "Evidence catalog must belong to this attempt.",
    );
  const stateRefs = [
    ...state.records.flatMap((r) => r.evidenceRefs),
    ...state.pendingRecords.flatMap((r) => r.evidenceRefs),
    ...state.writes.flatMap((w) => w.evidenceRefs),
    ...state.readReceipts.flatMap((r) => r.evidenceRefs),
    ...state.cleanupConfirmations.flatMap((c) => c.evidenceRefs),
    ...(state.cleanupReview?.evidenceRefs ?? []),
  ];
  if (progress || stateRefs.length) {
    const refs = [
      ...stateRefs,
      ...(progress?.evidence.map((e) => e.externalId) ?? []),
      ...(progress?.observations?.flatMap((o) => o.evidenceRefs) ?? []),
      ...(progress?.criteria.flatMap((c) => c.evidenceRefs) ?? []),
    ];
    const stored = await tx.runEvidence.findMany({
      where: {
        runId: task.runId,
        attemptId: snapshot.attemptId,
        externalId: { in: refs },
      },
      select: { externalId: true, kind: true },
    });
    const known = new Map(stored.map((e) => [e.externalId, e.kind]));
    if (
      stateRefs.some((id) => !known.has(id)) ||
      progress?.observations?.some(
        (o) =>
          !snapshot.criteria.some(
            (c) =>
              c.id === o.criterionId &&
              c.observationTargets?.some((t) => t.label === o.target),
          ) || o.evidenceRefs.some((ref) => !known.has(ref)),
      ) ||
      progress?.evidence.some((e) => known.get(e.externalId) !== e.kind) ||
      progress?.criteria.some(
        (c) =>
          !snapshot.criteria.some((s) => s.id === c.criterionId) ||
          c.evidenceRefs.some((id) => !known.has(id)),
      )
    )
      throw new BadRequestException(
        "Checkpoint must reference this execution's saved evidence and criteria.",
      );
  }
  if (progress?.criteria.length) {
    const stored = await tx.runEvidence.findMany({
      where: { attemptId: snapshot.attemptId, runId: task.runId },
    });
    for (const result of progress.criteria) {
      const criterion = snapshot.criteria.find(
        (c) => c.id === result.criterionId,
      )!;
      if (
        result.status === "PASSED" &&
        missingRequiredEvidenceKinds(
          browserExecutionCriterion(criterion),
          result.evidenceRefs,
          stored.map((e) =>
            runtimeEvidenceRefSchema.parse({
              ...e,
              metadata: object(e.metadata),
            }),
          ),
        ).length
      )
        throw new BadRequestException(
          `Criterion ${result.criterionId} is missing required evidence.`,
        );
    }
    await persistCriterionResults(tx, snapshot, progress.criteria);
  }
  const assigned = testAccountBindingsSchema.parse(
    snapshot.executionPolicy.testAccounts ?? [],
  );
  if (
    assigned.length !== (state.accounts ?? []).length ||
    (state.accounts ?? []).some(
      (binding) =>
        !assigned.some(
          (expected) =>
            expected.slotId === binding.slotId &&
            expected.account === binding.account &&
            expected.usage === binding.usage,
        ),
    )
  )
    throw new BadRequestException("执行进度不能分配或更换测试账号。");
  const checkpoint = {
    executionState: state,
    ...(progress
      ? {
          verificationCheckpoint: {
            ...progress,
            attemptId: snapshot.attemptId,
            ...(state.account ? { account: state.account } : {}),
          },
        }
      : {}),
  };
  const run = await tx.executionRun.findUniqueOrThrow({
    where: { id: task.runId },
    select: { executionPolicy: true },
  });
  await tx.executionRun.update({
    where: { id: task.runId },
    data: {
      executionPolicy: {
        ...object(run.executionPolicy),
        ...checkpoint,
      } as Prisma.InputJsonValue,
    },
  });
  await tx.agentRuntimeTask.update({
    where: { id: task.id },
    data: {
      snapshot: {
        ...snapshot,
        executionPolicy: { ...snapshot.executionPolicy, ...checkpoint },
      } as Prisma.InputJsonValue,
    },
  });
  // Clear the retired conflict flag for older Runtime clients as well.
  return { accountConflict: null };
}

/** Checkpoint and finish use the same key. Event payloads retain prior revisions. */
export async function persistCriterionResults(
  tx: Prisma.TransactionClient,
  snapshot: ReturnType<typeof runtimeTaskSnapshotSchema.parse>,
  criteria: Array<ReturnType<typeof runtimeCriterionResultSchema.parse>>,
) {
  for (const criterion of criteria) {
    const data = {
      teamId: snapshot.teamId,
      runId: snapshot.runId,
      attemptId: snapshot.attemptId,
      criterionId: criterion.criterionId,
      status: criterion.status,
      summary: criterion.summary,
      evidenceRefs: criterion.evidenceRefs,
    };
    await tx.runCriterionResult.upsert({
      where: {
        attemptId_criterionId: {
          attemptId: snapshot.attemptId,
          criterionId: criterion.criterionId,
        },
      },
      create: data,
      update: {
        status: data.status,
        summary: data.summary,
        evidenceRefs: data.evidenceRefs,
      },
    });
  }
}
