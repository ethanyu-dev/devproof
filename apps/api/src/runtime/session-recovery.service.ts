import { randomUUID } from "node:crypto";
import {
  recoveryEnabled,
  requireRecoveryEnabled,
} from "./session-recovery.enabled.js";
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { releaseVerifiedSessionResources } from "./session-resource-cleanup.js";
import {
  emitRecoveryChanged,
  ensureRecovery,
  isHealthySession,
  leaseDigest,
  lockRuntimeAndSession,
  materializeRecoveryGuards,
  recoveryDto,
  recoveryJson,
  terminalAgent,
  terminalRun,
} from "./session-recovery.state.js";

@Injectable()
export class SessionRecoveryService {
  constructor(private readonly prisma: PrismaService) {}

  async request(
    sessionId: string,
    reason: string,
    options: { sourceRunId?: string; explicitClose?: boolean } = {},
  ) {
    requireRecoveryEnabled();
    return this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      const initial = await tx.browserRuntimeSession.findUnique({
        where: { id: sessionId },
      });
      if (!initial)
        throw new NotFoundException("Runtime session was not found.");
      await lockRuntimeAndSession(tx, initial.runtimeId, sessionId);
      const session = await tx.browserRuntimeSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      const healthy =
        !options.explicitClose &&
        (await isHealthySession(tx, session, new Date()));
      const recovery = await ensureRecovery(tx, session, reason, {
        ...(options.sourceRunId ? { sourceRunId: options.sourceRunId } : {}),
        observed: healthy,
      });
      if (session.closureVerifiedAt && session.closureEvidenceId)
        await releaseVerifiedSessionResources(tx, session.id);
      if (!healthy && !session.closureVerifiedAt) {
        await tx.browserRuntimeSession.updateMany({
          where: {
            id: session.id,
            fencingToken: session.fencingToken,
            leaseToken: session.leaseToken,
            closureVerifiedAt: null,
          },
          data: {
            status: "LOST",
            executionPermitExpiresAt: new Date(),
            humanControlExpiresAt: null,
            humanControllerUserId: null,
            quarantinedAt: session.quarantinedAt ?? new Date(),
          },
        });
      }
      return recovery;
    });
  }

  async prepareClose(sessionId: string, proposedCommandId: string) {
    requireRecoveryEnabled();
    const requested = await this.request(sessionId, "EXPLICIT_CLOSE", {
      explicitClose: true,
    });
    return this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      await lockRuntimeAndSession(tx, requested.runtimeId, sessionId);
      await tx.$queryRaw`SELECT id FROM runtime_session_recoveries WHERE id = ${requested.id}::uuid FOR UPDATE`;
      const recovery = await tx.runtimeSessionRecovery.findUniqueOrThrow({
        where: { id: requested.id },
      });
      const session = await tx.browserRuntimeSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      if (
        session.fencingToken !== recovery.expectedSessionFence ||
        leaseDigest(session.leaseToken) !== recovery.expectedLeaseDigest
      )
        throw new ConflictException("The session epoch changed.");
      if (session.closureVerifiedAt && session.closureEvidenceId)
        throw new ConflictException(
          "The session already has verified closure evidence.",
        );
      const prior = recovery.activeCommandId
        ? await tx.browserRuntimeCommand.findUnique({
            where: { id: recovery.activeCommandId },
          })
        : null;
      const pending =
        prior &&
        ["PENDING", "DISPATCHED"].includes(prior.status) &&
        prior.deadlineAt > new Date();
      const commandId = pending ? prior.id : proposedCommandId;
      const now = new Date();
      const claimToken = randomUUID();
      const claimExpiresAt = new Date(now.getTime() + 120_000);
      const permit = await tx.$queryRaw<{ runtime_id: string }[]>`
        INSERT INTO runtime_recovery_permits (runtime_id, recovery_id, active_command_id, claim_token, claim_expires_at, updated_at)
        VALUES (${session.runtimeId}::uuid, ${recovery.id}::uuid, ${commandId}::uuid, ${claimToken}::uuid, ${claimExpiresAt}, ${now})
        ON CONFLICT (runtime_id) DO UPDATE SET recovery_id = EXCLUDED.recovery_id, active_command_id = EXCLUDED.active_command_id,
          claim_token = EXCLUDED.claim_token, claim_expires_at = EXCLUDED.claim_expires_at, updated_at = EXCLUDED.updated_at
        WHERE runtime_recovery_permits.recovery_id = EXCLUDED.recovery_id OR
          (runtime_recovery_permits.claim_expires_at <= ${now} AND NOT EXISTS (
            SELECT 1 FROM browser_runtime_commands command WHERE command.id = runtime_recovery_permits.active_command_id
              AND command.status IN ('PENDING', 'DISPATCHED') AND command.deadline_at > ${now}))
        RETURNING runtime_id`;
      if (!permit.length)
        throw new ConflictException(
          "Another session closure is still pending on this Runtime.",
        );
      const payload = this.closePayload(recovery.id, commandId, session);
      if (!pending)
        await tx.browserRuntimeCommand.create({
          data: {
            id: commandId,
            sessionId,
            commandType: "session.close",
            source: "SYSTEM",
            payload: recoveryJson({ recovery: payload }),
            leaseToken: session.leaseToken,
            fencingToken: session.fencingToken,
            deadlineAt: new Date(Date.now() + 90_000),
          },
        });
      const updated = await tx.runtimeSessionRecovery.update({
        where: { id: recovery.id },
        data: {
          activeCommandId: commandId,
          claimToken,
          claimExpiresAt,
          closureState: "CLOSING",
          nextAttemptAt: new Date(Date.now() + 120_000),
          version: { increment: 1 },
        },
      });
      await emitRecoveryChanged(tx, updated);
      await tx.runtimeRecoveryOutbox.create({
        data: {
          recoveryId: recovery.id,
          eventType: "REQUEST_CLOSE",
          version: updated.version,
          payload: { commandId },
        },
      });
      return pending
        ? (prior.payload as { recovery: typeof payload }).recovery
        : payload;
    });
  }

  closePayload(
    recoveryId: string,
    requestId: string,
    session: {
      id: string;
      leaseToken: string;
      fencingToken: bigint;
      launchIdentity: Prisma.JsonValue | null;
    },
  ) {
    const identity = session.launchIdentity;
    const launchId =
      typeof identity === "string"
        ? identity
        : identity &&
            typeof identity === "object" &&
            !Array.isArray(identity) &&
            typeof identity.id === "string"
          ? identity.id
          : undefined;
    return {
      recoveryId,
      requestId,
      sessionId: session.id,
      expectedLeaseToken: session.leaseToken,
      expectedFencingToken: session.fencingToken.toString(),
      ...(launchId ? { expectedLaunchIdentity: launchId } : {}),
    };
  }

  /** Reconnection is a useful retry signal, never closure evidence. */
  async wakeRuntime(runtimeId: string) {
    if (!recoveryEnabled()) return 0;
    return this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      const runtime = await tx.browserRuntime.findUnique({
        where: { id: runtimeId },
      });
      if (
        !runtime ||
        !runtime.enabled ||
        runtime.status !== "ONLINE" ||
        !Array.isArray(runtime.capabilities) ||
        !runtime.capabilities.includes("closure-evidence-v1")
      )
        return 0;
      const waiting = await tx.runtimeSessionRecovery.findMany({
        where: {
          runtimeId,
          closureEvidenceId: null,
          OR: [
            { closureState: "WAITING_RUNTIME" },
            {
              closureState: "NEEDS_OPERATOR",
              lastErrorCode: "UNSUPPORTED_CLOSURE_EVIDENCE",
            },
          ],
        },
        orderBy: { id: "asc" },
        take: 100,
      });
      for (const row of waiting) {
        const changed = await tx.runtimeSessionRecovery.updateMany({
          where: { id: row.id, version: row.version, closureEvidenceId: null },
          data: {
            closureState: "REQUESTED",
            nextAttemptAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (changed.count === 1) {
          const updated = await tx.runtimeSessionRecovery.findUniqueOrThrow({
            where: { id: row.id },
          });
          await emitRecoveryChanged(tx, updated);
        }
      }
      return waiting.length;
    });
  }

  async requireAdmin(
    current: AuthContext,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const membership = await tx.teamMembership.findUnique({
      where: {
        teamId_userId: { teamId: current.team.id, userId: current.user.id },
      },
    });
    if (membership?.role !== "ADMIN")
      throw new ForbiddenException(
        "A current team administrator must perform this recovery action.",
      );
  }

  async requestForUser(
    current: AuthContext,
    sessionId: string,
    reason = "OPERATOR_REQUEST",
  ) {
    await this.requireAdmin(current);
    const session = await this.prisma.browserRuntimeSession.findFirst({
      where: { id: sessionId, teamId: current.team.id },
    });
    if (!session) throw new NotFoundException("Runtime session was not found.");
    // A recovery request does not grant permission to stop a healthy execution.
    return recoveryDto(await this.request(sessionId, reason));
  }

  async list(
    current: AuthContext,
    query: { cursor?: string; limit?: number; state?: string } = {},
  ) {
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    if (
      query.cursor &&
      !(await this.prisma.runtimeSessionRecovery.findFirst({
        where: { id: query.cursor, teamId: current.team.id },
        select: { id: true },
      }))
    )
      throw new NotFoundException("Recovery cursor was not found.");
    const rows = await this.prisma.runtimeSessionRecovery.findMany({
      where: {
        teamId: current.team.id,
        ...(query.state ? { closureState: query.state } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    return {
      items: rows.slice(0, limit).map(recoveryDto),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }

  async detail(current: AuthContext, id: string) {
    const row = await this.owned(current, id);
    const [evidence, guards] = await Promise.all([
      this.prisma.sessionClosureEvidence.findMany({
        where: { recoveryId: id },
        select: {
          evidenceId: true,
          method: true,
          capabilityVersion: true,
          serverVerifiedAt: true,
          auditRef: true,
        },
        orderBy: { serverVerifiedAt: "desc" },
      }),
      this.prisma.executionResourceLease.findMany({
        where: { recoveryId: id },
        select: {
          rootKey: true,
          resourceKey: true,
          mode: true,
          origin: true,
          quarantined: true,
        },
      }),
    ]);
    return { ...recoveryDto(row), evidence, guards };
  }

  async retry(current: AuthContext, id: string, expectedVersion: number) {
    requireRecoveryEnabled();
    return this.prisma.$transaction(async (tx) => {
      await this.requireAdmin(current, tx);
      const row = await this.owned(current, id, tx);
      if (row.closureState === "VERIFIED") return recoveryDto(row);
      if (row.closureState === "OBSERVED")
        throw new ConflictException(
          "The execution still owns a valid lease; wait for it to stop.",
        );
      const changed = await tx.runtimeSessionRecovery.updateMany({
        where: {
          id,
          version: expectedVersion,
          closureVerifiedAt: null,
          OR: [
            { claimExpiresAt: null },
            { claimExpiresAt: { lte: new Date() } },
          ],
        },
        data: {
          closureState: "REQUESTED",
          nextAttemptAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new ConflictException(
          "Recovery changed or is being processed. Refresh before retrying.",
        );
      const updated = await tx.runtimeSessionRecovery.findUniqueOrThrow({
        where: { id },
      });
      await this.audit(tx, current, id, "runtime.recovery.retry", {});
      await emitRecoveryChanged(tx, updated);
      return recoveryDto(updated);
    });
  }

  async resolveWriteOutcome(
    current: AuthContext,
    id: string,
    input: {
      expectedVersion: number;
      idempotencyKey: string;
      outcome: "NO_WRITE" | "VERIFIED" | "COMPENSATED";
      note: string;
      evidenceRefs: string[];
    },
  ) {
    requireRecoveryEnabled();
    return this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      await this.requireAdmin(current, tx);
      const initial = await this.owned(current, id, tx);
      await lockRuntimeAndSession(tx, initial.runtimeId, initial.sessionId);
      await tx.$queryRaw`SELECT id FROM runtime_session_recoveries WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await this.owned(current, id, tx);
      const digest = leaseDigest(
        JSON.stringify({
          outcome: input.outcome,
          note: input.note,
          evidenceRefs: input.evidenceRefs,
        }),
      );
      if (row.resolutionKey === input.idempotencyKey) {
        if (row.resolutionDigest !== digest)
          throw new ConflictException(
            "Idempotency key was already used for different evidence.",
          );
        return { ...recoveryDto(row), released: 0 };
      }
      if (
        row.version !== input.expectedVersion ||
        row.writeOutcomeState === "RESOLVED"
      )
        throw new ConflictException(
          "Recovery changed. Refresh before resolving its write outcome.",
        );
      const session = await tx.browserRuntimeSession.findUniqueOrThrow({
        where: { id: row.sessionId },
        include: { browserExecutions: { include: { run: true } } },
      });
      if (
        session.fencingToken !== row.expectedSessionFence ||
        leaseDigest(session.leaseToken) !== row.expectedLeaseDigest ||
        session.status !== "CLOSED" ||
        !session.closureVerifiedAt ||
        !session.closureEvidenceId ||
        row.closureState !== "VERIFIED"
      )
        throw new ConflictException(
          "A verified closure proof for this session epoch is required.",
        );
      const evidence = await tx.sessionClosureEvidence.findUnique({
        where: { id: session.closureEvidenceId },
      });
      if (
        !evidence ||
        evidence.sessionId !== session.id ||
        evidence.sessionFence !== session.fencingToken ||
        evidence.recoveryId !== row.id
      )
        throw new ConflictException(
          "A durable closure evidence record is required before resolving writes.",
        );
      const owner = session.ownerTaskId
        ? await tx.agentRuntimeTask.findUnique({
            where: { id: session.ownerTaskId },
            include: { run: true },
          })
        : null;
      if (
        (owner &&
          (!terminalAgent(owner.status) ||
            !terminalRun(owner.run.lifecycle))) ||
        session.browserExecutions.some(
          (execution) => !terminalRun(execution.run.lifecycle),
        )
      )
        throw new ConflictException(
          "The previous execution must stop before its business result can be resolved.",
        );
      if (
        owner &&
        ["PENDING", "CLOSING", "RETRY_SCHEDULED"].includes(
          owner.recoveryStatus ?? "",
        )
      )
        throw new ConflictException(
          "The Agent lease recovery is still pending.",
        );
      if (owner) {
        const changed = await tx.agentRuntimeTask.updateMany({
          where: {
            id: owner.id,
            fencingToken: owner.fencingToken,
            status: owner.status,
            recoveryStatus: owner.recoveryStatus,
          },
          data: { recoveryStatus: "RESOLVED", recoveryNextAttemptAt: null },
        });
        if (changed.count !== 1)
          throw new ConflictException(
            "The previous execution changed during reconciliation.",
          );
      }
      await materializeRecoveryGuards(tx, session, row);
      const updated = await tx.runtimeSessionRecovery.update({
        where: { id },
        data: {
          writeOutcomeState: "RESOLVED",
          resolutionOutcome: input.outcome,
          resolutionNote: input.note,
          outcomeEvidenceRefs: recoveryJson(input.evidenceRefs),
          resolvedBy: current.user.id,
          resolutionKey: input.idempotencyKey,
          resolutionDigest: digest,
          writeResolvedAt: new Date(),
          resolvedAt: new Date(),
          version: { increment: 1 },
        },
      });
      const released = await tx.executionResourceLease.deleteMany({
        where: { sessionId: session.id, recoveryId: id },
      });
      await tx.browserRuntimeSession.updateMany({
        where: {
          id: session.id,
          fencingToken: row.expectedSessionFence,
          closureVerifiedAt: { not: null },
        },
        data: { quarantinedAt: null },
      });
      await this.audit(tx, current, id, "runtime.write_outcome.reconciled", {
        outcome: input.outcome,
        note: input.note,
        evidenceRefs: input.evidenceRefs,
        released: released.count,
      });
      await emitRecoveryChanged(tx, updated);
      return { ...recoveryDto(updated), released: released.count };
    });
  }

  async owned(
    current: AuthContext,
    id: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const row = await tx.runtimeSessionRecovery.findFirst({
      where: { id, teamId: current.team.id },
    });
    if (!row) throw new NotFoundException("Runtime recovery was not found.");
    return row;
  }

  private audit(
    tx: Prisma.TransactionClient,
    current: AuthContext,
    id: string,
    action: string,
    metadata: unknown,
  ) {
    return tx.auditEvent.create({
      data: {
        action,
        actorUserId: current.user.id,
        entityId: id,
        entityType: "runtime_session_recovery",
        metadata: recoveryJson(metadata),
        teamId: current.team.id,
      },
    });
  }
}
