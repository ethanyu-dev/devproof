import { randomUUID } from "node:crypto";
import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  BrowserRuntimeSession,
  RuntimeSessionRecovery,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import type {
  AuthenticatedRuntimeContext,
  RuntimeClosureProof,
  SessionClosureFailure,
} from "./session-closure.types.js";
import {
  emitRecoveryChanged,
  ensureRecovery,
  leaseDigest,
  lockRuntimeAndSession,
  materializeRecoveryGuards,
  refreshRecoveryWriteOutcome,
  recoveryJson,
  writeSettled,
} from "./session-recovery.state.js";
import { releaseVerifiedSessionResources } from "./session-resource-cleanup.js";
import { requireRecoveryEnabled } from "./session-recovery.enabled.js";

@Injectable()
export class SessionClosureService {
  constructor(private readonly prisma: PrismaService) {}

  async acceptRuntimeEvidence(
    context: AuthenticatedRuntimeContext,
    proof: RuntimeClosureProof,
  ) {
    requireRecoveryEnabled();
    if (
      !context.capabilities.has("closure-evidence-v1") ||
      context.negotiatedMinor < 14 ||
      proof.networkRevoked !== true ||
      !context.hostInstanceId ||
      !context.daemonInstanceId ||
      context.hostInstanceId !== proof.hostInstanceId ||
      context.daemonInstanceId !== proof.daemonInstanceId ||
      ![
        "LIVE_SESSION_TERMINATED",
        "IDENTIFIED_PROCESS_SET_TERMINATED",
      ].includes(proof.method) ||
      proof.launchIdentityVersion < 1
    )
      throw new ConflictException(
        "The authenticated Runtime cannot supply this closure evidence.",
      );
    return this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      await lockRuntimeAndSession(tx, context.runtimeId, proof.sessionId);
      const runtime = await tx.browserRuntime.findUnique({
        where: { id: context.runtimeId },
      });
      if (
        !runtime ||
        !runtime.enabled ||
        runtime.revokedAt ||
        runtime.drainState !== "NONE" ||
        runtime.status !== "ONLINE" ||
        runtime.connectionId !== context.connectionId ||
        runtime.connectionGeneration !== context.connectionGeneration ||
        runtime.hostInstanceId !== context.hostInstanceId ||
        runtime.daemonInstanceId !== context.daemonInstanceId
      )
        throw new ConflictException(
          "Closure evidence came from a superseded Runtime connection.",
        );
      const session = await tx.browserRuntimeSession.findUnique({
        where: { id: proof.sessionId },
      });
      if (
        !session ||
        session.runtimeId !== runtime.id ||
        session.leaseToken !== proof.leaseToken ||
        session.fencingToken.toString() !== proof.fencingToken ||
        (session.launchHostInstanceId &&
          session.launchHostInstanceId !== proof.hostInstanceId)
      )
        throw new ConflictException(
          "Closure evidence does not match the session epoch or launch host.",
        );
      const recovery = await tx.runtimeSessionRecovery.findUnique({
        where: { id: proof.recoveryId },
      });
      if (
        !recovery ||
        recovery.sessionId !== session.id ||
        recovery.runtimeId !== runtime.id ||
        recovery.expectedSessionFence !== session.fencingToken ||
        recovery.expectedLeaseDigest !== leaseDigest(proof.leaseToken)
      )
        throw new ConflictException(
          "Closure recovery does not match this epoch.",
        );
      const command = await tx.browserRuntimeCommand.findUnique({
        where: { id: proof.requestId },
      });
      const payload = command?.payload as {
        recovery?: {
          recoveryId?: string;
          requestId?: string;
          expectedLaunchIdentity?: string;
        };
      } | null;
      if (
        !command ||
        command.commandType !== "session.close" ||
        command.sessionId !== session.id ||
        command.leaseToken !== session.leaseToken ||
        command.fencingToken !== session.fencingToken ||
        payload?.recovery?.recoveryId !== recovery.id ||
        payload.recovery.requestId !== proof.requestId
      )
        throw new ConflictException(
          "Closure evidence has no matching durable close challenge.",
        );
      // Empty inventories and session UUID scans cannot prove termination of an unknown legacy process set.
      if (
        proof.method === "IDENTIFIED_PROCESS_SET_TERMINATED" &&
        !payload.recovery.expectedLaunchIdentity
      )
        throw new ConflictException(
          "Identified-process closure requires a previously registered launch identity.",
        );
      return this.commitEvidence(tx, session, recovery, {
        evidenceId: proof.evidenceId,
        requestId: proof.requestId,
        connectionGeneration: context.connectionGeneration,
        hostInstanceId: proof.hostInstanceId,
        daemonInstanceId: proof.daemonInstanceId,
        launchIdentityVersion: proof.launchIdentityVersion ?? null,
        method: proof.method,
        capabilityVersion: "closure-evidence-v1",
        summary: {
          networkRevoked: true,
          closureCompletedAt: proof.closureCompletedAt,
        },
      });
    });
  }

  /** Profile purge is a control-plane allocation which is forbidden to launch a browser. */
  async acceptNeverLaunched(
    sessionId: string,
    expectedFencingToken: string,
    expectedLeaseToken: string,
  ) {
    requireRecoveryEnabled();
    return this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      const initial = await tx.browserRuntimeSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      await lockRuntimeAndSession(tx, initial.runtimeId, initial.id);
      const session = await tx.browserRuntimeSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      if (
        session.purpose !== "PROFILE_PURGE" ||
        session.launchConnectionGeneration === null ||
        session.fencingToken.toString() !== expectedFencingToken ||
        session.leaseToken !== expectedLeaseToken ||
        (await tx.browserRuntimeCommand.count({
          where: { sessionId, commandType: { not: "profile.purge" } },
        }))
      )
        throw new ConflictException(
          "This allocation has no complete no-launch audit.",
        );
      const recovery = await ensureRecovery(
        tx,
        session,
        "CONTROL_PLANE_NO_LAUNCH",
      );
      return this.commitEvidence(tx, session, recovery, {
        evidenceId: randomUUID(),
        requestId: recovery.id,
        method: "CONTROL_PLANE_NO_LAUNCH",
        capabilityVersion: "control-plane-no-launch-v1",
        summary: { purpose: "PROFILE_PURGE" },
      });
    });
  }

  /** Drain service authenticates and locks the frozen operation before calling this in its transaction. */
  async acceptAdminDrainEvidence(
    tx: Prisma.TransactionClient,
    input: {
      sessionId: string;
      expectedFencingToken: string;
      expectedLeaseDigest: string;
      evidenceId: string;
      drainId: string;
      actorId: string;
      hostInstanceId: string | null;
      evidenceRefs: string[];
    },
  ) {
    requireRecoveryEnabled();
    const session = await tx.browserRuntimeSession.findUniqueOrThrow({
      where: { id: input.sessionId },
    });
    if (
      session.fencingToken.toString() !== input.expectedFencingToken ||
      leaseDigest(session.leaseToken) !== input.expectedLeaseDigest
    )
      throw new ConflictException("Frozen drain session changed its epoch.");
    const recovery = await ensureRecovery(tx, session, "ADMIN_DRAIN");
    return this.commitEvidence(tx, session, recovery, {
      evidenceId: input.evidenceId,
      requestId: input.drainId,
      hostInstanceId: input.hostInstanceId,
      method: "ADMIN_DRAIN_ATTESTATION",
      capabilityVersion: "admin-drain-v1",
      actorId: input.actorId,
      auditRef: input.drainId,
      summary: { evidenceRefs: input.evidenceRefs },
    });
  }

  private async commitEvidence(
    tx: Prisma.TransactionClient,
    session: BrowserRuntimeSession,
    recovery: RuntimeSessionRecovery,
    proof: {
      evidenceId: string;
      requestId: string;
      connectionGeneration?: bigint;
      hostInstanceId?: string | null;
      daemonInstanceId?: string;
      launchIdentityVersion?: number;
      method: string;
      capabilityVersion: string;
      summary: unknown;
      actorId?: string;
      auditRef?: string;
    },
  ) {
    recovery = await refreshRecoveryWriteOutcome(tx, session, recovery);
    const prior = await tx.sessionClosureEvidence.findUnique({
      where: { evidenceId: proof.evidenceId },
    });
    if (
      prior &&
      (prior.sessionId !== session.id ||
        prior.sessionFence !== session.fencingToken ||
        prior.recoveryId !== recovery.id ||
        prior.requestId !== proof.requestId)
    )
      throw new ConflictException(
        "Closure evidence ID was replayed for another operation.",
      );
    if (session.closureVerifiedAt && session.closureEvidenceId) {
      await releaseVerifiedSessionResources(tx, session.id);
      return {
        accepted: true as const,
        recoveryId: recovery.id,
        closureVerifiedAt: session.closureVerifiedAt,
      };
    }
    await materializeRecoveryGuards(tx, session, recovery);
    const now = new Date();
    const evidence =
      prior ??
      (await tx.sessionClosureEvidence.create({
        data: {
          evidenceId: proof.evidenceId,
          recoveryId: recovery.id,
          requestId: proof.requestId,
          sessionId: session.id,
          sessionFence: session.fencingToken,
          leaseDigest: leaseDigest(session.leaseToken),
          runtimeId: session.runtimeId,
          connectionGeneration: proof.connectionGeneration ?? null,
          hostInstanceId: proof.hostInstanceId ?? null,
          daemonInstanceId: proof.daemonInstanceId ?? null,
          launchIdentityVersion: proof.launchIdentityVersion ?? null,
          method: proof.method,
          capabilityVersion: proof.capabilityVersion,
          summary: recoveryJson(proof.summary),
          serverVerifiedAt: now,
          actorId: proof.actorId ?? null,
          auditRef: proof.auditRef ?? null,
        },
      }));
    const changed = await tx.browserRuntimeSession.updateMany({
      where: {
        id: session.id,
        fencingToken: session.fencingToken,
        leaseToken: session.leaseToken,
        OR: [{ closureVerifiedAt: null }, { closureEvidenceId: null }],
      },
      data: {
        status: "CLOSED",
        closedAt: now,
        closureVerifiedAt: now,
        closureEvidenceId: evidence.id,
        executionPermitExpiresAt: now,
        identityPermit: null,
        humanControllerUserId: null,
        humanControlExpiresAt: null,
      },
    });
    if (changed.count !== 1)
      throw new ConflictException("The session epoch changed during closure.");
    const updated = await tx.runtimeSessionRecovery.update({
      where: { id: recovery.id },
      data: {
        closureState: "VERIFIED",
        closureEvidenceId: evidence.id,
        closureVerifiedAt: now,
        nextAttemptAt: null,
        claimToken: null,
        claimExpiresAt: null,
        version: { increment: 1 },
        resolvedAt: writeSettled(recovery.writeOutcomeState) ? now : null,
      },
    });
    await releaseVerifiedSessionResources(tx, session.id);
    if (session.userBrowserProfileId && session.purpose === "EXECUTION") {
      await tx.userBrowserProfile.updateMany({
        where: {
          id: session.userBrowserProfileId,
          teamId: session.teamId,
          status: "READY",
        },
        data: {
          lastUsedAt: now,
          inactivityExpiresAt: new Date(
            now.getTime() + 30 * 24 * 60 * 60 * 1_000,
          ),
        },
      });
    }

    await tx.browserExecution.updateMany({
      where: {
        runtimeSessionId: session.id,
        status: {
          in: ["ACTIVE", "HUMAN_CONTROL", "RELEASING", "LOST", "FAILED"],
        },
      },
      data: { status: "RELEASED", finishedAt: now, allocationToken: null },
    });
    await tx.runtimeRecoveryPermit.deleteMany({
      where: { runtimeId: session.runtimeId, recoveryId: recovery.id },
    });
    await tx.browserRuntimeEvent.create({
      data: {
        sessionId: session.id,
        kind: "CLOSURE_VERIFIED",
        leaseToken: session.leaseToken,
        fencingToken: session.fencingToken,
        occurredAt: now,
        payload: {
          recoveryId: recovery.id,
          evidenceId: proof.evidenceId,
          method: proof.method,
          requestId: proof.requestId,
        },
      },
    });
    if (proof.actorId)
      await tx.auditEvent.create({
        data: {
          teamId: session.teamId,
          action: "runtime.session.closure_verified",
          actorUserId: proof.actorId,
          entityType: "runtime_session_recovery",
          entityId: recovery.id,
          metadata: {
            evidenceId: proof.evidenceId,
            method: proof.method,
            requestId: proof.requestId,
          },
        },
      });
    await emitRecoveryChanged(tx, updated);
    return {
      accepted: true as const,
      recoveryId: recovery.id,
      closureVerifiedAt: now,
    };
  }

  async recordFailure(input: SessionClosureFailure) {
    requireRecoveryEnabled();
    return this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      const initial = await tx.browserRuntimeSession.findUnique({
        where: { id: input.sessionId },
      });
      if (!initial) return { changed: false };
      await lockRuntimeAndSession(tx, initial.runtimeId, initial.id);
      const session = await tx.browserRuntimeSession.findUniqueOrThrow({
        where: { id: initial.id },
      });
      if (
        (session.closureVerifiedAt && session.closureEvidenceId) ||
        session.fencingToken.toString() !== input.expectedFencingToken ||
        session.leaseToken !== input.expectedLeaseToken
      )
        return { changed: false };
      const recovery = await ensureRecovery(tx, session, input.errorCode);
      if (
        (input.requestId && recovery.activeCommandId !== input.requestId) ||
        (input.claimToken && recovery.claimToken !== input.claimToken)
      )
        return { changed: false };
      const now = new Date();
      const needsOperator =
        [
          "CLOSURE_UNVERIFIED",
          "LAUNCH_IDENTITY_UNAVAILABLE",
          "UNSUPPORTED_CLOSURE_EVIDENCE",
        ].includes(input.errorCode) || recovery.attempts >= 6;
      const offline = input.errorCode === "RUNTIME_OFFLINE";
      const delay =
        [5, 15, 30, 60, 120][Math.min(recovery.attempts, 4)]! * 1000;
      await tx.browserRuntimeSession.updateMany({
        where: {
          id: session.id,
          fencingToken: session.fencingToken,
          leaseToken: session.leaseToken,
          closureVerifiedAt: null,
        },
        data: {
          status: "LOST",
          executionPermitExpiresAt: now,
          quarantinedAt: session.quarantinedAt ?? now,
          lastError: {
            code: input.errorCode,
            message: "Closure recovery needs another verified attempt.",
          },
        },
      });
      const updated = await tx.runtimeSessionRecovery.update({
        where: { id: recovery.id },
        data: {
          closureState: needsOperator
            ? "NEEDS_OPERATOR"
            : offline
              ? "WAITING_RUNTIME"
              : "RETRY_WAIT",
          lastErrorCode: input.errorCode,
          lastErrorAt: now,
          nextAttemptAt: needsOperator
            ? null
            : new Date(
                now.getTime() + Math.floor(delay * (0.8 + Math.random() * 0.4)),
              ),
          claimToken: null,
          claimExpiresAt: null,
          version: { increment: 1 },
        },
      });
      await emitRecoveryChanged(tx, updated);
      return { changed: true };
    });
  }
}
