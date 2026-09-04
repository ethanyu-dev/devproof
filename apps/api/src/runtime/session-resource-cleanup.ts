import type { Prisma } from "@prisma/client";
import { potentialWriteCommandWhere } from "./session-write-audit.js";

function hasConfirmedBrowserOutcome(task: {
  completionId: string | null;
  status: string;
  result: unknown;
}) {
  // completionId also acknowledges WAITING_HUMAN. Only a final verification
  // outcome certifies the business result; cancellation/expiry preserve that
  // intermediate completion and must not accidentally treat it as success.
  return (
    Boolean(task.completionId) &&
    task.status === "SUCCEEDED" &&
    typeof task.result === "object" &&
    task.result !== null &&
    "kind" in task.result &&
    task.result.kind === "VERIFICATION_COMPLETED"
  );
}

/** A timeout is evidence of uncertainty, not evidence of browser termination. */
export async function quarantineSession(
  tx: Prisma.TransactionClient,
  sessionId: string,
  code: string,
) {
  const result = await tx.browserRuntimeSession.updateMany({
    where: {
      id: sessionId,
      closureVerifiedAt: null,
      status: { not: "CLOSED" },
    },
    data: {
      status: "LOST",
      executionPermitExpiresAt: new Date(),
      humanControllerUserId: null,
      humanControlExpiresAt: null,
      lastError: {
        code,
        message:
          "Browser closure is not yet verified; execution resources remain reserved.",
      },
    },
  });
  if (result.count === 1) {
    await tx.browserRuntimeSession.updateMany({
      where: { id: sessionId, quarantinedAt: null, closureVerifiedAt: null },
      data: { quarantinedAt: new Date() },
    });
    // Physical expiry/failed closure cannot establish the outcome of an in-flight write.
    await tx.executionResourceLease.updateMany({
      where: { sessionId, mode: "WRITE" },
      data: { quarantined: true },
    });
  }
  return result;
}

/** Call inside the transaction which verifies closure of the matching epoch. */
export async function releaseVerifiedSessionResources(
  tx: Prisma.TransactionClient,
  sessionId: string,
) {
  const session = await tx.browserRuntimeSession.findUnique({
    where: { id: sessionId },
    select: {
      closureVerifiedAt: true,
      status: true,
      ownerTaskId: true,
      quarantinedAt: true,
      purpose: true,
      protocolMinor: true,
      browserExecutions: { select: { id: true }, take: 1 },
    },
  });
  if (!session || (!session.closureVerifiedAt && session.status !== "CLOSED"))
    return false;
  await tx.browserRuntimeSlot.deleteMany({ where: { sessionId } });
  await tx.browserRuntimeProfileLease.deleteMany({ where: { sessionId } });
  const owner = session.ownerTaskId
    ? await tx.agentRuntimeTask.findUnique({
        include: { run: true },
        where: { id: session.ownerTaskId },
      })
    : null;
  const awaitingWriteOutcome =
    owner &&
    !hasConfirmedBrowserOutcome(owner) &&
    owner.recoveryStatus !== "RESOLVED" &&
    (owner.run.concurrencyPolicy as { accessMode?: string } | null)
      ?.accessMode !== "READ_ONLY";
  let verifiedEmptyExecution = false;
  if (
    session.purpose === "EXECUTION" &&
    (!session.ownerTaskId || awaitingWriteOutcome)
  ) {
    const potentialWrites = await tx.browserRuntimeCommand.count({
      where: { sessionId, ...potentialWriteCommandWhere },
    });
    verifiedEmptyExecution =
      session.protocolMinor >= 13 &&
      session.browserExecutions.length > 0 &&
      potentialWrites === 0;
    if (!session.ownerTaskId && !verifiedEmptyExecution) {
      // A manual execution has no Agent outcome to certify its possible writes.
      await tx.executionResourceLease.updateMany({
        where: { sessionId, mode: "WRITE" },
        data: { quarantined: true },
      });
    }
  }
  if (
    awaitingWriteOutcome &&
    !verifiedEmptyExecution &&
    ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(owner.status) &&
    !["PENDING", "CLOSING", "RETRY_SCHEDULED"].includes(
      owner.recoveryStatus ?? "",
    )
  ) {
    const changed = await tx.agentRuntimeTask.updateMany({
      where: {
        id: session.ownerTaskId!,
        status: owner.status,
        recoveryStatus: owner.recoveryStatus,
      },
      data: {
        recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
        recoveryNextAttemptAt: null,
      },
    });
    // Reconciliation changes the owner first. A delayed close must lose this
    // CAS instead of recreating data quarantine after an operator resolved it.
    if (changed.count === 1)
      await tx.executionResourceLease.updateMany({
        where: { sessionId, mode: "WRITE" },
        data: { quarantined: true },
      });
  }
  if (verifiedEmptyExecution)
    await tx.executionResourceLease.deleteMany({ where: { sessionId } });
  else if (!awaitingWriteOutcome)
    await tx.executionResourceLease.deleteMany({
      where: { sessionId, quarantined: false },
    });
  const unresolvedWrites = await tx.executionResourceLease.count({
    where: { sessionId, quarantined: true },
  });
  await tx.browserRuntimeSession.updateMany({
    where: { id: sessionId },
    data: {
      identityPermit: null,
      closureVerifiedAt: session.closureVerifiedAt ?? new Date(),
      quarantinedAt:
        unresolvedWrites > 0 ? (session.quarantinedAt ?? new Date()) : null,
    },
  });
  return true;
}

/** A successful outcome can release a verified-closed session's deferred data lock. */
export async function releaseCompletedSessionData(
  tx: Prisma.TransactionClient,
  taskId: string,
) {
  const task = await tx.agentRuntimeTask.findUnique({
    select: {
      completionId: true,
      recoveryStatus: true,
      result: true,
      status: true,
    },
    where: { id: taskId },
  });
  if (
    !task ||
    !hasConfirmedBrowserOutcome(task) ||
    task.recoveryStatus === "WRITE_OUTCOME_UNKNOWN"
  )
    return;
  const sessions = await tx.browserRuntimeSession.findMany({
    select: { id: true },
    where: { ownerTaskId: taskId, closureVerifiedAt: { not: null } },
  });
  if (sessions.length)
    await tx.executionResourceLease.deleteMany({
      where: {
        sessionId: { in: sessions.map((session) => session.id) },
        quarantined: false,
      },
    });
}
