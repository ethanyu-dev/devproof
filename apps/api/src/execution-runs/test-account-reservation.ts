import { ConflictException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { readExecutionState } from "@devproof/agent-runtime-protocol";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { businessEnvironmentKey } from "../verification/execution-concurrency.js";
import { hasVerifiedObservationOnlyHistory } from "../runtime/session-write-audit.js";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const normalized = (v: string) => v.trim().toLowerCase();
function environmentKey(value: unknown) {
  const v = object(value);
  const url = v.targetUrl ?? v.baseUrl;
  return businessEnvironmentKey(typeof url === "string" ? url : undefined);
}

/** Empty journals are not proof of no writes: inspect durable browser history. */
export async function canReleaseTestAccount(
  tx: Prisma.TransactionClient,
  run: { id: string; lifecycle: string; executionPolicy: unknown },
) {
  if (!["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(run.lifecycle))
    return false;
  const state = readExecutionState(object(run.executionPolicy));
  if (
    state.pendingRecords.length ||
    state.records.some((r) => r.cleanup?.status !== "COMPLETED")
  )
    return false;
  const executions = await tx.browserExecution.findMany({
    where: { runId: run.id },
    include: { runtimeSession: true },
  });
  // A missing historical session is ambiguous (the FK can be cleared on deletion).
  if (
    executions.some(
      (e) =>
        !e.runtimeSession?.closureVerifiedAt ||
        !e.runtimeSession.closureEvidenceId,
    )
  )
    return false;
  if (state.records.length) return true;
  if (!executions.length) return state.writes.length === 0;
  for (const { runtimeSession: session } of executions) {
    if (!session) return false;
    if (await hasVerifiedObservationOnlyHistory(tx, session)) continue;
    // An explicit NO_WRITE reconciliation is valid; permission to retry is not.
    const resolution = await tx.runtimeSessionRecovery.findFirst({
      where: {
        sessionId: session.id,
        expectedSessionFence: session.fencingToken,
        closureState: "VERIFIED",
        closureEvidenceId: session.closureEvidenceId,
        closureVerifiedAt: { not: null },
        writeOutcomeState: "RESOLVED",
        resolutionOutcome: "NO_WRITE",
        writeResolvedAt: { not: null },
      },
      select: { id: true },
    });
    if (!resolution) return false;
  }
  return true;
}

/** Static Spec accounts and human replies use the same durable run-policy claim.
 * Finished runs retain their claim until every tracked write has been reconciled.
 * Aliases learned from business responses are checked under the same team lock.
 */
export async function claimTestAccount(
  tx: Prisma.TransactionClient,
  input: {
    teamId: string;
    runId: string;
    environment: unknown;
    account: string;
    aliases?: string[];
  },
) {
  await acquireAdvisoryTransactionLock(tx, `test-account:${input.teamId}`);
  const runs = await tx.executionRun.findMany({
    where: { teamId: input.teamId, id: { not: input.runId } },
    select: {
      id: true,
      lifecycle: true,
      environmentSnapshot: true,
      executionPolicy: true,
    },
  });
  const requested = new Set(
    [input.account, ...(input.aliases ?? [])].map(normalized),
  );
  const target = environmentKey(input.environment);
  for (const run of runs) {
    const environment = environmentKey(run.environmentSnapshot);
    if (target !== "*" && environment !== "*" && target !== environment)
      continue;
    const state = readExecutionState(object(run.executionPolicy));
    const claim = object(object(run.executionPolicy).testAccountClaim);
    const allocated = [
      claim.account,
      ...(Array.isArray(claim.aliases) ? claim.aliases : []),
      state.account,
      ...state.accountAliases,
      ...state.records
        .filter((r) => r.cleanup?.status !== "COMPLETED")
        .flatMap((r) => [r.account, ...r.accountAliases]),
    ].filter((v): v is string => typeof v === "string");
    if (!allocated.some((v) => requested.has(normalized(v)))) continue;
    if (await canReleaseTestAccount(tx, run)) continue;
    throw new ConflictException(
      "TEST_ACCOUNT_CONFLICT: 该账号或其手机号/UUID 别名已被同环境其他用例占用，尚未完成清理，请提供独立测试账号。",
    );
  }
  const run = await tx.executionRun.findUniqueOrThrow({
    where: { id: input.runId },
    select: { executionPolicy: true },
  });
  await tx.executionRun.update({
    where: { id: input.runId },
    data: {
      executionPolicy: {
        ...object(run.executionPolicy),
        testAccountClaim: {
          account: input.account,
          aliases: input.aliases ?? [],
        },
      } as Prisma.InputJsonValue,
    },
  });
}
