import type { BrowserRuntimeSession, Prisma } from "@prisma/client";
import {
  leaseDigest,
  writeSettled,
  refreshRecoveryWriteOutcome,
} from "./session-recovery.state.js";

export function hasConfirmedBrowserOutcome(task: {
  completionId: string | null;
  status: string;
  result: unknown;
}) {
  return Boolean(
    task.completionId &&
    task.status === "SUCCEEDED" &&
    task.result &&
    typeof task.result === "object" &&
    "kind" in task.result &&
    task.result.kind === "VERIFICATION_COMPLETED",
  );
}

/** Expiration cannot establish termination. Closed epochs are an absorbing state. */
export async function quarantineSession(
  tx: Prisma.TransactionClient,
  sessionId: string,
  code: string,
) {
  const changed = await tx.browserRuntimeSession.updateMany({
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
          "Browser closure is not verified; execution resources remain reserved.",
      },
    },
  });
  if (changed.count === 1) {
    await tx.browserRuntimeSession.updateMany({
      where: { id: sessionId, quarantinedAt: null, closureVerifiedAt: null },
      data: { quarantinedAt: new Date() },
    });
    await tx.executionResourceLease.updateMany({
      where: { sessionId, mode: "WRITE" },
      data: { quarantined: true },
    });
  }
  return changed;
}

async function verifiedRecovery(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
) {
  if (
    session.status !== "CLOSED" ||
    !session.closureVerifiedAt ||
    !session.closureEvidenceId
  )
    return null;
  const evidence = await tx.sessionClosureEvidence.findUnique({
    where: { id: session.closureEvidenceId },
  });
  if (
    !evidence ||
    evidence.sessionId !== session.id ||
    evidence.sessionFence !== session.fencingToken ||
    evidence.leaseDigest !== leaseDigest(session.leaseToken)
  )
    return null;
  const recovery = await tx.runtimeSessionRecovery.findUnique({
    where: {
      sessionId_expectedSessionFence: {
        sessionId: session.id,
        expectedSessionFence: session.fencingToken,
      },
    },
  });
  return recovery &&
    recovery.id === evidence.recoveryId &&
    recovery.closureState === "VERIFIED" &&
    recovery.closureEvidenceId === evidence.id &&
    recovery.closureVerifiedAt
    ? recovery
    : null;
}

/** The caller holds the shared resource lock and has already persisted closure evidence. */
export async function releaseVerifiedSessionResources(
  tx: Prisma.TransactionClient,
  sessionId: string,
) {
  const session = await tx.browserRuntimeSession.findUnique({
    where: { id: sessionId },
  });
  if (!session) return false;
  const recovery = await verifiedRecovery(tx, session);
  if (!recovery) return false;
  const epoch = {
    sessionId,
    leaseToken: session.leaseToken,
    fencingToken: session.fencingToken,
  };
  await tx.browserRuntimeSlot.deleteMany({ where: epoch });
  await tx.browserRuntimeProfileLease.deleteMany({ where: epoch });
  await tx.browserHumanControlLease.deleteMany({ where: { sessionId } });
  const owner = session.ownerTaskId
    ? await tx.agentRuntimeTask.findUnique({
        where: { id: session.ownerTaskId },
        include: { run: true },
      })
    : null;
  const settled = writeSettled(recovery.writeOutcomeState);
  if (settled) {
    await tx.executionResourceLease.deleteMany({ where: { sessionId } });
  } else {
    await tx.executionResourceLease.updateMany({
      where: { sessionId, mode: "WRITE" },
      data: { quarantined: true },
    });
    await tx.executionResourceLease.deleteMany({
      where: { sessionId, mode: "READ", origin: "NORMAL" },
    });
    if (
      owner &&
      session.ownerFencingToken !== null &&
      owner.fencingToken === session.ownerFencingToken &&
      ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(
        owner.status,
      ) &&
      owner.recoveryStatus !== "RESOLVED"
    ) {
      await tx.agentRuntimeTask.updateMany({
        where: {
          id: owner.id,
          status: owner.status,
          fencingToken: owner.fencingToken,
          recoveryStatus: owner.recoveryStatus,
        },
        data: {
          recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
          recoveryNextAttemptAt: null,
        },
      });
    }
  }
  const remaining = await tx.executionResourceLease.count({
    where: { sessionId, quarantined: true },
  });
  await tx.browserRuntimeSession.updateMany({
    where: {
      id: sessionId,
      fencingToken: session.fencingToken,
      leaseToken: session.leaseToken,
      closureVerifiedAt: { not: null },
    },
    data: {
      identityPermit: null,
      executionPermitExpiresAt: new Date(),
      humanControllerUserId: null,
      humanControlExpiresAt: null,
      quarantinedAt:
        remaining > 0 ? (session.quarantinedAt ?? new Date()) : null,
    },
  });
  return true;
}

/** A final trusted business outcome may complete a previously closed recovery. */
export async function releaseCompletedSessionData(
  tx: Prisma.TransactionClient,
  taskId: string,
) {
  const task = await tx.agentRuntimeTask.findUnique({ where: { id: taskId } });
  if (
    !task ||
    !hasConfirmedBrowserOutcome(task) ||
    task.recoveryStatus === "WRITE_OUTCOME_UNKNOWN"
  )
    return;
  const sessions = await tx.browserRuntimeSession.findMany({
    where: {
      ownerTaskId: taskId,
      ownerFencingToken: task.fencingToken,
      closureVerifiedAt: { not: null },
      closureEvidenceId: { not: null },
    },
  });
  for (const session of sessions) {
    if (
      session.ownerTaskId !== taskId ||
      session.ownerFencingToken !== task.fencingToken
    )
      continue;
    const recovery = await verifiedRecovery(tx, session);
    if (!recovery) continue;
    await refreshRecoveryWriteOutcome(tx, session, recovery);
    await releaseVerifiedSessionResources(tx, session.id);
  }
}
