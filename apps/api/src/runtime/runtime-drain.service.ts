import { randomUUID } from "node:crypto";
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RuntimeDrainAttestation } from "@prisma/client";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { SessionRecoveryService } from "./session-recovery.service.js";
import { SessionClosureService } from "./session-closure.service.js";
import {
  ensureRecovery,
  leaseDigest,
  recoveryJson,
} from "./session-recovery.state.js";
import { requireRecoveryEnabled } from "./session-recovery.enabled.js";

type FrozenSession = {
  sessionId: string;
  fencingToken: string;
  leaseDigest: string;
  status: string;
  closureVerifiedAt: string | null;
};
const visibleSession = ({ leaseDigest: _private, ...row }: FrozenSession) =>
  row;
const drainDto = (row: RuntimeDrainAttestation) => ({
  id: row.id,
  snapshotDigest: row.snapshotDigest,
  state: row.state,
  frozenSessions: (row.frozenSessions as unknown as FrozenSession[]).map(
    visibleSession,
  ),
});

@Injectable()
export class RuntimeDrainService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recoveries: SessionRecoveryService,
    private readonly closures: SessionClosureService,
  ) {}

  async preview(current: AuthContext, runtimeId: string) {
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await this.snapshot(tx, current.team.id, runtimeId);
      const existing = await tx.runtimeDrainAttestation.findFirst({
        where: { runtimeId, teamId: current.team.id, state: "FROZEN" },
        orderBy: { drainGeneration: "desc" },
      });
      return {
        runtimeId,
        connectionGeneration: snapshot.runtime.connectionGeneration.toString(),
        hostInstanceId: snapshot.runtime.hostInstanceId,
        snapshotDigest: snapshot.digest,
        sessions: snapshot.sessions.map(visibleSession),
        drainState: snapshot.runtime.drainState,
        existingDrain: existing ? drainDto(existing) : null,
      };
    });
  }

  async freeze(
    current: AuthContext,
    runtimeId: string,
    input: { snapshotDigest: string; note?: string | undefined },
  ) {
    requireRecoveryEnabled();
    return this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      await this.recoveries.requireAdmin(current, tx);
      await tx.$queryRaw`SELECT id FROM browser_runtimes WHERE id = ${runtimeId}::uuid FOR UPDATE`;
      const snapshot = await this.snapshot(tx, current.team.id, runtimeId);
      const existing = await tx.runtimeDrainAttestation.findFirst({
        where: { runtimeId, state: "FROZEN" },
        orderBy: { drainGeneration: "desc" },
      });
      if (existing) {
        if (existing.snapshotDigest !== input.snapshotDigest)
          throw new ConflictException(
            "An existing frozen drain must be completed first.",
          );
        return drainDto(existing);
      }
      if (snapshot.digest !== input.snapshotDigest)
        throw new ConflictException(
          "Runtime inventory changed. Preview again before freezing it.",
        );
      const generation = snapshot.runtime.drainGeneration + 1;
      await tx.browserRuntime.update({
        where: { id: runtimeId },
        data: {
          enabled: false,
          drainState: "FROZEN",
          drainGeneration: generation,
        },
      });
      // Allocation observes the same resource lock and the disabled/drain state.
      for (const frozen of snapshot.sessions) {
        await tx.$queryRaw`SELECT id FROM browser_runtime_sessions WHERE id = ${frozen.sessionId}::uuid FOR UPDATE`;
        const session = await tx.browserRuntimeSession.findUniqueOrThrow({
          where: { id: frozen.sessionId },
        });
        await ensureRecovery(tx, session, "ADMIN_DRAIN");
        await tx.browserRuntimeSession.updateMany({
          where: {
            id: session.id,
            fencingToken: session.fencingToken,
            closureVerifiedAt: null,
          },
          data: {
            status: "LOST",
            executionPermitExpiresAt: new Date(),
            quarantinedAt: session.quarantinedAt ?? new Date(),
            humanControllerUserId: null,
            humanControlExpiresAt: null,
          },
        });
      }
      const row = await tx.runtimeDrainAttestation.create({
        data: {
          runtimeId,
          teamId: current.team.id,
          drainGeneration: generation,
          connectionGeneration: snapshot.runtime.connectionGeneration,
          hostInstanceId: snapshot.runtime.hostInstanceId,
          frozenSessions: recoveryJson(snapshot.sessions),
          snapshotDigest: snapshot.digest,
          createdBy: current.user.id,
          note: input.note ?? null,
        },
      });
      await this.audit(tx, current, row.id, "runtime.drain.frozen", {
        runtimeId,
        count: snapshot.sessions.length,
        note: input.note ?? null,
      });
      return drainDto(row);
    });
  }

  async attest(
    current: AuthContext,
    runtimeId: string,
    drainId: string,
    input: {
      snapshotDigest: string;
      idempotencyKey: string;
      note: string;
      evidenceRefs: string[];
      infrastructureTerminated: true;
    },
  ) {
    requireRecoveryEnabled();
    return this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      await this.recoveries.requireAdmin(current, tx);
      await tx.$queryRaw`SELECT id FROM browser_runtimes WHERE id = ${runtimeId}::uuid FOR UPDATE`;
      const runtime = await tx.browserRuntime.findFirst({
        where: { id: runtimeId, teamId: current.team.id },
      });
      const drain = await tx.runtimeDrainAttestation.findFirst({
        where: { id: drainId, runtimeId, teamId: current.team.id },
      });
      if (!runtime || !drain)
        throw new NotFoundException("Frozen Runtime drain was not found.");
      const digest = leaseDigest(
        JSON.stringify({
          snapshotDigest: input.snapshotDigest,
          note: input.note,
          evidenceRefs: input.evidenceRefs,
          infrastructureTerminated: input.infrastructureTerminated,
        }),
      );
      if (drain.idempotencyKey === input.idempotencyKey) {
        if (drain.attestationDigest !== digest)
          throw new ConflictException(
            "Idempotency key was already used for different drain evidence.",
          );
        return drainDto(drain);
      }
      if (
        drain.state !== "FROZEN" ||
        drain.snapshotDigest !== input.snapshotDigest ||
        runtime.drainState !== "FROZEN" ||
        runtime.drainGeneration !== drain.drainGeneration ||
        runtime.connectionGeneration !== drain.connectionGeneration ||
        runtime.hostInstanceId !== drain.hostInstanceId ||
        runtime.enabled ||
        !["OFFLINE", "REVOKED"].includes(runtime.status) ||
        input.infrastructureTerminated !== true
      )
        throw new ConflictException(
          "Drain evidence requires the unchanged frozen Runtime to be disabled and offline or revoked. A reconnect invalidates this operation.",
        );
      const frozen = drain.frozenSessions as unknown as FrozenSession[];
      for (const row of [...frozen].sort((a, b) =>
        a.sessionId.localeCompare(b.sessionId),
      )) {
        await tx.$queryRaw`SELECT id FROM browser_runtime_sessions WHERE id = ${row.sessionId}::uuid FOR UPDATE`;
        await this.closures.acceptAdminDrainEvidence(tx, {
          sessionId: row.sessionId,
          expectedFencingToken: row.fencingToken,
          expectedLeaseDigest: row.leaseDigest,
          evidenceId: randomUUID(),
          drainId,
          actorId: current.user.id,
          hostInstanceId: drain.hostInstanceId,
          evidenceRefs: input.evidenceRefs,
        });
      }
      const updated = await tx.runtimeDrainAttestation.update({
        where: { id: drain.id },
        data: {
          state: "ATTESTED",
          attestedBy: current.user.id,
          idempotencyKey: input.idempotencyKey,
          attestationDigest: digest,
          note: input.note,
          evidenceRefs: recoveryJson(input.evidenceRefs),
          attestedAt: new Date(),
        },
      });
      await tx.browserRuntime.update({
        where: { id: runtimeId },
        data: { drainState: "ATTESTED" },
      });
      await this.audit(tx, current, drainId, "runtime.drain.attested", {
        runtimeId,
        evidenceRefs: input.evidenceRefs,
        note: input.note,
        count: frozen.length,
      });
      return drainDto(updated);
    });
  }

  private async snapshot(
    tx: Prisma.TransactionClient,
    teamId: string,
    runtimeId: string,
  ) {
    const runtime = await tx.browserRuntime.findFirst({
      where: { id: runtimeId, teamId },
    });
    if (!runtime) throw new NotFoundException("Runtime was not found.");
    const rows = await tx.browserRuntimeSession.findMany({
      where: {
        runtimeId,
        OR: [
          { status: { not: "CLOSED" }, closureEvidenceId: null },
          { resourceLeases: { some: { quarantined: true } } },
        ],
      },
      orderBy: { id: "asc" },
    });
    const sessions: FrozenSession[] = rows.map((row) => ({
      sessionId: row.id,
      fencingToken: row.fencingToken.toString(),
      leaseDigest: leaseDigest(row.leaseToken),
      status: row.status,
      closureVerifiedAt: row.closureVerifiedAt?.toISOString() ?? null,
    }));
    const digest = leaseDigest(
      JSON.stringify({
        runtimeId,
        connectionGeneration: runtime.connectionGeneration.toString(),
        hostInstanceId: runtime.hostInstanceId,
        sessions,
      }),
    );
    return { runtime, sessions, digest };
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
        teamId: current.team.id,
        actorUserId: current.user.id,
        action,
        entityId: id,
        entityType: "runtime_drain",
        metadata: recoveryJson(metadata),
      },
    });
  }
}
