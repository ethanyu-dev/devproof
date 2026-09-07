import { ConflictException } from "@nestjs/common";
import type {
  BrowserRuntime,
  Prisma,
  RuntimeDrainAttestation,
} from "@prisma/client";
import { leaseDigest } from "./session-recovery.state.js";

/** Caller holds the resource advisory lock and the Runtime row lock. */
export function assertResumeScope(
  runtime: BrowserRuntime,
  drain: RuntimeDrainAttestation,
) {
  if (
    runtime.teamId !== drain.teamId ||
    runtime.id !== drain.runtimeId ||
    !["ATTESTED", "RESUMING"].includes(runtime.drainState) ||
    runtime.enabled ||
    !["OFFLINE", "REVOKED"].includes(runtime.status) ||
    drain.state !== "ATTESTED" ||
    !drain.attestedAt ||
    drain.resumedAt ||
    runtime.drainGeneration !== drain.drainGeneration ||
    runtime.connectionGeneration !==
      (drain.resumeConnectionGeneration ?? drain.connectionGeneration) ||
    !drain.hostInstanceId ||
    runtime.hostInstanceId !== drain.hostInstanceId ||
    !runtime.daemonInstanceId
  )
    throw new ConflictException(
      "Resume requires the current attested, disabled and offline Runtime on its original host.",
    );
}

/** Rechecks durable epochs, not a status-only/empty-process inference. */
export async function assertResumeInventory(
  tx: Prisma.TransactionClient,
  runtimeId: string,
) {
  const sessions = await tx.browserRuntimeSession.findMany({
    where: { runtimeId },
  });
  const proofs = await tx.sessionClosureEvidence.findMany({
    where: { runtimeId },
  });
  const byId = new Map(proofs.map((proof) => [proof.id, proof]));
  const now = new Date();
  for (const session of sessions) {
    const proof = session.closureEvidenceId
      ? byId.get(session.closureEvidenceId)
      : undefined;
    if (
      session.status !== "CLOSED" ||
      !session.closureVerifiedAt ||
      !proof ||
      proof.sessionId !== session.id ||
      proof.sessionFence !== session.fencingToken ||
      proof.leaseDigest !== leaseDigest(session.leaseToken) ||
      session.identityPermit !== null ||
      (session.executionPermitExpiresAt &&
        session.executionPermitExpiresAt > now)
    )
      throw new ConflictException(
        "Every historical session must have matching closure evidence and no execution permit before resume.",
      );
  }
  const [slots, leases, recoveryPermits] = await Promise.all([
    tx.browserRuntimeSlot.count({ where: { runtimeId } }),
    tx.browserRuntimeProfileLease.count({ where: { runtimeId } }),
    tx.runtimeRecoveryPermit.count({
      where: { runtimeId, claimExpiresAt: { gt: now } },
    }),
  ]);
  if (slots || leases || recoveryPermits)
    throw new ConflictException(
      "Runtime physical leases or recovery permits must be released before resume.",
    );
  // Business WRITE guards deliberately remain: closure does not resolve UNKNOWN.
}
