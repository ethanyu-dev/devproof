import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  BrowserRuntimeSession,
  RuntimeSessionRecovery,
} from "@prisma/client";
import {
  businessEnvironmentKey,
  executionTarget,
} from "../verification/execution-concurrency.js";
import { sessionExecutionPermit } from "./session-permit.js";
import {
  RESOLVED_WRITE_STATES,
  TERMINAL_AGENT_STATES,
  TERMINAL_RUN_STATES,
} from "./session-closure.types.js";

export const leaseDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const recoveryJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value));
export const writeSettled = (state: string) =>
  (RESOLVED_WRITE_STATES as readonly string[]).includes(state);
export const terminalRun = (state: string) =>
  (TERMINAL_RUN_STATES as readonly string[]).includes(state);
export const terminalAgent = (state: string) =>
  (TERMINAL_AGENT_STATES as readonly string[]).includes(state);

export async function lockRuntimeAndSession(
  tx: Prisma.TransactionClient,
  runtimeId: string,
  sessionId: string,
) {
  await tx.$queryRaw`SELECT id FROM browser_runtimes WHERE id = ${runtimeId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM browser_runtime_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
}

/** A new waiter is not permission to terminate a legitimate lease holder. */
export async function isHealthySession(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
  now: Date,
) {
  if (
    session.closureVerifiedAt ||
    session.quarantinedAt ||
    session.closedAt ||
    session.leaseExpiresAt <= now ||
    !["OPENING", "ACTIVE", "HUMAN_CONTROL"].includes(session.status)
  )
    return false;
  if (!(await sessionExecutionPermit(tx, session, now))) return false;
  if (session.ownerTaskId) {
    const owner = await tx.agentRuntimeTask.findUnique({
      where: { id: session.ownerTaskId },
      include: { run: true },
    });
    if (
      !owner ||
      terminalAgent(owner.status) ||
      terminalRun(owner.run.lifecycle)
    )
      return false;
  }
  const executions = await tx.browserExecution.findMany({
    where: { runtimeSessionId: session.id },
    include: { run: true },
    take: 1,
  });
  return !executions.some((execution) => terminalRun(execution.run.lifecycle));
}

export async function inferRecoveryScope(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
) {
  const bound = await tx.browserExecution.findFirst({
    where: { runtimeSessionId: session.id },
    include: { run: true },
    orderBy: { createdAt: "asc" },
  });
  const legacy = bound
    ? null
    : await tx.verificationRun.findFirst({
        where: { runtimeSessionId: session.id },
        orderBy: { createdAt: "asc" },
      });
  const request = legacy?.requestSnapshot as { execution?: unknown } | null;
  const target = bound
    ? executionTarget(bound.input, bound.run.environmentSnapshot)
    : executionTarget(request?.execution);
  return {
    rootKey: businessEnvironmentKey(target),
    resourceKey: "",
    mode: "WRITE" as const,
    provenance: target ? "EXECUTION_SNAPSHOT" : "UNKNOWN",
    sourceRunId: bound?.runId ?? null,
  };
}

/** Called only under the shared resource lock. No lease/command absence proves no writes. */
export async function materializeRecoveryGuards(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
  recovery: RuntimeSessionRecovery,
) {
  if (writeSettled(recovery.writeOutcomeState)) return;
  const leases = await tx.executionResourceLease.findMany({
    where: { sessionId: session.id },
  });
  if (!leases.length && session.purpose === "EXECUTION") {
    const scope = await inferRecoveryScope(tx, session);
    await tx.executionResourceLease.create({
      data: {
        sessionId: session.id,
        rootKey: scope.rootKey,
        resourceKey: "",
        mode: "WRITE",
        quarantined: true,
        recoveryId: recovery.id,
        origin: "LEGACY_RECOVERY",
        guardReason: recovery.reason,
      },
    });
  }
  // Adopt pre-migration NORMAL quarantine too; resolution must release these exact leases.
  await tx.executionResourceLease.updateMany({
    where: { sessionId: session.id },
    data: { recoveryId: recovery.id },
  });
  await tx.executionResourceLease.updateMany({
    where: { sessionId: session.id, mode: "WRITE" },
    data: { quarantined: true },
  });
}

export async function initialWriteState(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
) {
  if (session.purpose !== "EXECUTION") return "NOT_APPLICABLE";
  if (session.ownerTaskId) {
    const owner = await tx.agentRuntimeTask.findUnique({
      where: { id: session.ownerTaskId },
    });
    const matchingOwner =
      owner &&
      session.ownerFencingToken !== null &&
      owner.fencingToken === session.ownerFencingToken;
    if (matchingOwner && owner.recoveryStatus === "RESOLVED") return "RESOLVED";
    const result = owner?.result as { kind?: string } | null;
    if (
      matchingOwner &&
      owner.status === "SUCCEEDED" &&
      owner.recoveryStatus !== "WRITE_OUTCOME_UNKNOWN" &&
      owner.completionId &&
      result?.kind === "VERIFICATION_COMPLETED"
    )
      return "CONFIRMED";
  }
  const leases = await tx.executionResourceLease.findMany({
    where: { sessionId: session.id },
  });
  if (leases.length && leases.every((lease) => lease.mode === "READ"))
    return "NOT_APPLICABLE";
  return "UNKNOWN";
}

/** A final result certifies only the exact Agent epoch that owned this browser. */
export async function refreshRecoveryWriteOutcome(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
  recovery: RuntimeSessionRecovery,
) {
  if (
    writeSettled(recovery.writeOutcomeState) ||
    !session.ownerTaskId ||
    session.ownerFencingToken === null
  )
    return recovery;
  const owner = await tx.agentRuntimeTask.findUnique({
    where: { id: session.ownerTaskId },
  });
  const outcome = owner?.result as { kind?: string } | null;
  if (
    !owner ||
    owner.fencingToken !== session.ownerFencingToken ||
    owner.status !== "SUCCEEDED" ||
    !owner.completionId ||
    owner.recoveryStatus === "WRITE_OUTCOME_UNKNOWN" ||
    outcome?.kind !== "VERIFICATION_COMPLETED"
  )
    return recovery;
  const changed = await tx.runtimeSessionRecovery.updateMany({
    where: {
      id: recovery.id,
      version: recovery.version,
      writeOutcomeState: { in: ["UNKNOWN", "UNASSESSED"] },
    },
    data: {
      writeOutcomeState: "CONFIRMED",
      version: { increment: 1 },
      resolvedAt:
        recovery.closureState === "VERIFIED" &&
        recovery.closureEvidenceId &&
        recovery.closureVerifiedAt
          ? new Date()
          : null,
    },
  });
  const current = await tx.runtimeSessionRecovery.findUniqueOrThrow({
    where: { id: recovery.id },
  });
  if (changed.count === 1) await emitRecoveryChanged(tx, current);
  return current;
}

export async function ensureRecovery(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
  reason: string,
  options: { sourceRunId?: string; observed?: boolean } = {},
) {
  const where = {
    sessionId_expectedSessionFence: {
      sessionId: session.id,
      expectedSessionFence: session.fencingToken,
    },
  };
  let existing = await tx.runtimeSessionRecovery.findUnique({ where });
  if (existing) {
    if (existing.expectedLeaseDigest !== leaseDigest(session.leaseToken))
      throw new Error("Session epoch changed without a new fence.");
    existing = await refreshRecoveryWriteOutcome(tx, session, existing);
    if (!options.observed)
      await materializeRecoveryGuards(tx, session, existing);
    if (
      (existing.closureState === "OBSERVED" && !options.observed) ||
      (existing.closureState === "VERIFIED" && !existing.closureEvidenceId)
    ) {
      const promoted = await tx.runtimeSessionRecovery.update({
        where: { id: existing.id },
        data: {
          closureState: "REQUESTED",
          closureVerifiedAt: null,
          reason,
          nextAttemptAt: new Date(),
          version: { increment: 1 },
        },
      });
      await emitRecoveryChanged(tx, promoted);
      return promoted;
    }
    return existing;
  }
  const scope = await inferRecoveryScope(tx, session);
  const writeOutcomeState = await initialWriteState(tx, session);
  const recovery = await tx.runtimeSessionRecovery.create({
    data: {
      teamId: session.teamId,
      runtimeId: session.runtimeId,
      sessionId: session.id,
      expectedSessionFence: session.fencingToken,
      expectedLeaseDigest: leaseDigest(session.leaseToken),
      reason,
      sourceRunId: options.sourceRunId ?? scope.sourceRunId,
      observedProtocolMajor: session.protocolMajor,
      observedProtocolMinor: session.protocolMinor,
      closureState:
        session.closureVerifiedAt && session.closureEvidenceId
          ? "VERIFIED"
          : options.observed
            ? "OBSERVED"
            : "REQUESTED",
      closureVerifiedAt: session.closureEvidenceId
        ? session.closureVerifiedAt
        : null,
      closureEvidenceId: session.closureEvidenceId,
      writeOutcomeState,
      scopeSnapshot: recoveryJson([
        { rootKey: scope.rootKey, resourceKey: "", mode: "WRITE" },
      ]),
      scopeProvenance: scope.provenance,
      aliasRegistryVersion: leaseDigest(
        process.env.BROWSER_EXECUTION_ENVIRONMENTS_JSON ?? "[]",
      ),
      nextAttemptAt:
        (session.closureVerifiedAt && session.closureEvidenceId) ||
        options.observed
          ? null
          : new Date(),
      resolvedAt:
        session.closureVerifiedAt &&
        session.closureEvidenceId &&
        writeSettled(writeOutcomeState)
          ? new Date()
          : null,
    },
  });
  if (!options.observed) await materializeRecoveryGuards(tx, session, recovery);
  await emitRecoveryChanged(tx, recovery);
  return recovery;
}

export async function emitRecoveryChanged(
  tx: Prisma.TransactionClient,
  recovery: RuntimeSessionRecovery,
) {
  await tx.runtimeRecoveryOutbox.upsert({
    where: {
      recoveryId_eventType_version: {
        recoveryId: recovery.id,
        eventType: "RECOVERY_CHANGED",
        version: recovery.version,
      },
    },
    create: {
      recoveryId: recovery.id,
      eventType: "RECOVERY_CHANGED",
      version: recovery.version,
      payload: { sessionId: recovery.sessionId },
    },
    update: {},
  });
}

/** All public DTOs intentionally omit lease digests, worker claims, and raw command payloads. */
export function recoveryDto(row: RuntimeSessionRecovery) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    runtimeId: row.runtimeId,
    sourceRunId: row.sourceRunId,
    reason: row.reason,
    closureState: row.closureState,
    writeOutcomeState: row.writeOutcomeState,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    version: row.version,
    scopeSnapshot: row.scopeSnapshot,
    scopeProvenance: row.scopeProvenance,
    closureVerifiedAt: row.closureVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}
