import { claimTestAccount } from "../execution-runs/test-account-reservation.js";
import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  executionStateSchema,
  runtimeCriterionResultSchema,
  runtimeEvidenceRefSchema,
  runtimeTaskSnapshotSchema,
} from "@devproof/agent-runtime-protocol";
import { z } from "zod";
const progressSchema = z.object({
  criteria: z.array(runtimeCriterionResultSchema).max(100),
  evidence: z.array(runtimeEvidenceRefSchema).max(2000),
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
  const state = executionStateSchema.parse(payload.executionState);
  const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
  const progress =
    payload.verificationCheckpoint === undefined
      ? undefined
      : progressSchema.parse(payload.verificationCheckpoint);
  const stateRefs = [
    ...state.records.flatMap((r) => r.evidenceRefs),
    ...state.pendingRecords.flatMap((r) => r.evidenceRefs),
    ...state.writes.flatMap((w) => w.evidenceRefs),
  ];
  if (progress || stateRefs.length) {
    const refs = [
      ...stateRefs,
      ...(progress?.evidence.map((e) => e.externalId) ?? []),
    ];
    const stored = await tx.runEvidence.findMany({
      where: { runId: task.runId, externalId: { in: refs } },
      select: { externalId: true, kind: true },
    });
    const known = new Map(stored.map((e) => [e.externalId, e.kind]));
    if (
      stateRefs.some((id) => !known.has(id)) ||
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
  const owner = await tx.executionRun.findUniqueOrThrow({
    where: { id: task.runId },
    select: { teamId: true, environmentSnapshot: true },
  });
  if (state.account && state.accountAliases.length) {
    try {
      await claimTestAccount(tx, {
        teamId: owner.teamId,
        runId: task.runId,
        environment: owner.environmentSnapshot,
        account: state.account,
        aliases: state.accountAliases,
      });
      delete state.accountConflict;
    } catch (error) {
      if (!String(error).includes("TEST_ACCOUNT_CONFLICT")) throw error;
      state.accountConflict =
        "测试账号的手机号或 UUID 与其他用例占用的账号一致；停止写入并请求独立账号。";
    }
  }
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
  return { accountConflict: state.accountConflict ?? null };
}
