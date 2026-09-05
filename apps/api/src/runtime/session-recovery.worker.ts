import { randomUUID } from "node:crypto";
import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import type { Prisma, RuntimeSessionRecovery } from "@prisma/client";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";
import { RuntimeCommandDispatcher } from "./runtime-command-dispatcher.service.js";
import { SessionRecoveryService } from "./session-recovery.service.js";
import { SessionClosureService } from "./session-closure.service.js";
import { recoveryEnabled } from "./session-recovery.enabled.js";
import { emitRecoveryChanged, recoveryJson } from "./session-recovery.state.js";

const CLAIM_TTL_MS = 120_000;
const CLOSE_DEADLINE_MS = 90_000;

@Injectable()
export class SessionRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionRecoveryWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private scanCursor: string | undefined;
  constructor(
    private readonly prisma: PrismaService,
    private readonly recoveries: SessionRecoveryService,
    private readonly closures: SessionClosureService,
    private readonly commands: RuntimeCommandDispatcher,
    @Optional() private readonly monitor?: WorkerMonitorService,
  ) {}

  onModuleInit() {
    if (!recoveryEnabled() || !env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor?.register("runtime-session-recovery", 10_000);
    this.timer = setInterval(() => this.trigger(), 10_000);
    this.timer.unref();
    this.trigger();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private trigger() {
    const operation = () => this.tick();
    void (
      this.monitor
        ? this.monitor.run("runtime-session-recovery", operation)
        : operation()
    ).catch((error: unknown) =>
      this.logger.error(
        "Runtime session recovery failed",
        error instanceof Error ? error.stack : String(error),
      ),
    );
  }

  async tick() {
    if (!recoveryEnabled() || this.running) return;
    this.running = true;
    try {
      await this.discover();
      await this.deliverWakeups();
      const batch = await this.claim(20);
      await Promise.all(batch.map((row) => this.dispatch(row)));
    } finally {
      this.running = false;
    }
  }

  /** Keyset scan eventually visits orphan and historical rows even when early rows need an operator. */
  async discover() {
    if (!recoveryEnabled()) return;
    const candidates = await this.prisma.browserRuntimeSession.findMany({
      where: {
        OR: [
          { closureVerifiedAt: null, status: { not: "CLOSED" } },
          { resourceLeases: { some: { quarantined: true, recoveryId: null } } },
        ],
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 100,
      ...(this.scanCursor ? { cursor: { id: this.scanCursor }, skip: 1 } : {}),
    });
    for (const row of candidates)
      await this.recoveries.request(row.id, "PERIODIC_RECONCILIATION");
    this.scanCursor =
      candidates.length === 100 ? candidates.at(-1)!.id : undefined;
  }

  async claim(limit: number) {
    return this.prisma.$transaction(async (tx) => {
      // This phase also persists command rows (and their session FK), so it
      // follows the resource-first order used by closure, rather than a claim-only lock order.
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      const now = new Date();
      const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM runtime_session_recoveries
        WHERE closure_state IN ('REQUESTED', 'RETRY_WAIT', 'WAITING_RUNTIME', 'CLOSING')
          AND closure_verified_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          AND (claim_expires_at IS NULL OR claim_expires_at <= ${now})
        ORDER BY next_attempt_at NULLS FIRST, id
        FOR UPDATE SKIP LOCKED LIMIT ${Math.min(limit, 20)}`;
      const claimed: RuntimeSessionRecovery[] = [];
      for (const { id } of ids) {
        const row = await tx.runtimeSessionRecovery.findUniqueOrThrow({
          where: { id },
        });
        const runtime = await tx.browserRuntime.findUnique({
          where: { id: row.runtimeId },
        });
        if (!runtime || runtime.status !== "ONLINE" || !runtime.enabled) {
          await this.deferWithoutDispatch(
            tx,
            row,
            "WAITING_RUNTIME",
            "RUNTIME_OFFLINE",
            new Date(now.getTime() + 120_000),
          );
          continue;
        }
        if (
          !Array.isArray(runtime.capabilities) ||
          !runtime.capabilities.includes("closure-evidence-v1") ||
          !runtime.hostInstanceId ||
          !runtime.daemonInstanceId
        ) {
          await this.deferWithoutDispatch(
            tx,
            row,
            "NEEDS_OPERATOR",
            "UNSUPPORTED_CLOSURE_EVIDENCE",
            null,
          );
          continue;
        }
        const claimToken = randomUUID();
        const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS);
        // An expired claim alone must not transfer an in-flight RPC to another session.
        const permit = await tx.$queryRaw<{ runtime_id: string }[]>`
          INSERT INTO runtime_recovery_permits (runtime_id, recovery_id, claim_token, claim_expires_at, updated_at)
          VALUES (${row.runtimeId}::uuid, ${row.id}::uuid, ${claimToken}::uuid, ${expiresAt}, ${now})
          ON CONFLICT (runtime_id) DO UPDATE SET recovery_id = EXCLUDED.recovery_id,
            claim_token = EXCLUDED.claim_token, claim_expires_at = EXCLUDED.claim_expires_at, updated_at = EXCLUDED.updated_at
          WHERE runtime_recovery_permits.claim_expires_at <= ${now}
            AND (runtime_recovery_permits.recovery_id = EXCLUDED.recovery_id OR NOT EXISTS (
              SELECT 1 FROM browser_runtime_commands command
              WHERE command.id = runtime_recovery_permits.active_command_id
                AND command.status IN ('PENDING', 'DISPATCHED') AND command.deadline_at > ${now}))
          RETURNING runtime_id`;
        if (!permit.length) continue;
        const session = await tx.browserRuntimeSession.findUniqueOrThrow({
          where: { id: row.sessionId },
        });
        if (
          (session.closureVerifiedAt && session.closureEvidenceId) ||
          session.fencingToken !== row.expectedSessionFence
        ) {
          await tx.runtimeRecoveryPermit.deleteMany({
            where: { runtimeId: row.runtimeId, claimToken },
          });
          continue;
        }
        const previous = row.activeCommandId
          ? await tx.browserRuntimeCommand.findUnique({
              where: { id: row.activeCommandId },
            })
          : null;
        const reuse =
          previous &&
          ["PENDING", "DISPATCHED"].includes(previous.status) &&
          previous.deadlineAt > now;
        const commandId = reuse ? previous.id : randomUUID();
        if (!reuse) {
          const recovery = this.recoveries.closePayload(
            row.id,
            commandId,
            session,
          );
          await tx.browserRuntimeCommand.create({
            data: {
              id: commandId,
              sessionId: session.id,
              commandType: "session.close",
              source: "SYSTEM",
              payload: recoveryJson({ recovery }),
              leaseToken: session.leaseToken,
              fencingToken: session.fencingToken,
              deadlineAt: new Date(now.getTime() + CLOSE_DEADLINE_MS),
            },
          });
        }
        await tx.runtimeRecoveryPermit.updateMany({
          where: { runtimeId: row.runtimeId, claimToken },
          data: { activeCommandId: commandId },
        });
        const updated = await tx.runtimeSessionRecovery.update({
          where: { id: row.id },
          data: {
            closureState: "CLOSING",
            activeCommandId: commandId,
            claimToken,
            claimExpiresAt: expiresAt,
            claimVersion: { increment: 1 },
            attempts: { increment: reuse ? 0 : 1 },
            nextAttemptAt: expiresAt,
            version: { increment: 1 },
          },
        });
        await tx.runtimeRecoveryOutbox.create({
          data: {
            recoveryId: row.id,
            eventType: "REQUEST_CLOSE",
            version: updated.version,
            payload: { commandId },
          },
        });
        await emitRecoveryChanged(tx, updated);
        claimed.push(updated);
      }
      return claimed;
    });
  }

  private async deferWithoutDispatch(
    tx: Prisma.TransactionClient,
    row: RuntimeSessionRecovery,
    state: string,
    errorCode: string,
    retryAt: Date | null,
  ) {
    const updated = await tx.runtimeSessionRecovery.update({
      where: { id: row.id },
      data: {
        closureState: state,
        lastErrorCode: errorCode,
        lastErrorAt: new Date(),
        nextAttemptAt: retryAt,
        claimToken: null,
        claimExpiresAt: null,
        version: { increment: 1 },
      },
    });
    await emitRecoveryChanged(tx, updated);
  }

  private async dispatch(row: RuntimeSessionRecovery) {
    if (!row.activeCommandId || !row.claimToken) return;
    const renew = setInterval(() => {
      const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
      void this.prisma
        .$transaction(async (tx) => {
          const changed = await tx.runtimeSessionRecovery.updateMany({
            where: {
              id: row.id,
              claimToken: row.claimToken,
              closureVerifiedAt: null,
            },
            data: { claimExpiresAt: expiresAt },
          });
          if (changed.count)
            await tx.runtimeRecoveryPermit.updateMany({
              where: {
                runtimeId: row.runtimeId,
                recoveryId: row.id,
                claimToken: row.claimToken!,
              },
              data: { claimExpiresAt: expiresAt },
            });
        })
        .catch((error: unknown) =>
          this.logger.warn(`Recovery claim renewal failed: ${String(error)}`),
        );
    }, 30_000);
    renew.unref();
    try {
      const command = await this.prisma.browserRuntimeCommand.findUniqueOrThrow(
        { where: { id: row.activeCommandId } },
      );
      const result = await this.commands.execute({
        sessionId: row.sessionId,
        commandId: command.id,
        commandType: "session.close",
        source: "SYSTEM",
        payload: command.payload as Record<string, unknown>,
        timeoutSeconds: 90,
      });
      const latest = await this.prisma.runtimeSessionRecovery.findUniqueOrThrow(
        { where: { id: row.id } },
      );
      if (latest.closureState !== "VERIFIED") {
        const error = result?.error as { code?: string } | null;
        await this.closures.recordFailure({
          sessionId: row.sessionId,
          expectedFencingToken: row.expectedSessionFence.toString(),
          expectedLeaseToken: command.leaseToken,
          requestId: command.id,
          claimToken: row.claimToken,
          errorCode:
            error?.code ??
            (result?.status === "SUCCEEDED"
              ? "CLOSURE_EVIDENCE_MISSING"
              : "CLOSE_FAILED"),
        });
      }
      await this.prisma.runtimeRecoveryOutbox.updateMany({
        where: {
          recoveryId: row.id,
          eventType: "REQUEST_CLOSE",
          version: { lte: row.version },
          deliveredAt: null,
        },
        data: { deliveredAt: new Date() },
      });
    } catch (error) {
      const session = await this.prisma.browserRuntimeSession.findUnique({
        where: { id: row.sessionId },
      });
      if (session)
        await this.closures.recordFailure({
          sessionId: row.sessionId,
          expectedFencingToken: row.expectedSessionFence.toString(),
          expectedLeaseToken: session.leaseToken,
          requestId: row.activeCommandId,
          claimToken: row.claimToken,
          errorCode: "CLOSE_DISPATCH_FAILED",
        });
      this.logger.warn(
        `Recovery dispatch failed (${row.id}): ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearInterval(renew);
      // Only this owner's permit is released; an expired/reassigned claim cannot clear its successor.
      const command = await this.prisma.browserRuntimeCommand.findUnique({
        where: { id: row.activeCommandId },
      });
      if (!command || !["PENDING", "DISPATCHED"].includes(command.status))
        await this.prisma.runtimeRecoveryPermit.deleteMany({
          where: {
            runtimeId: row.runtimeId,
            recoveryId: row.id,
            claimToken: row.claimToken,
          },
        });
    }
  }

  async deliverWakeups() {
    await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      const rows = await tx.$queryRaw<{ id: string; recovery_id: string }[]>`
        SELECT id, recovery_id FROM runtime_recovery_outbox WHERE event_type = 'RECOVERY_CHANGED'
          AND delivered_at IS NULL ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 100`;
      for (const row of rows) {
        await tx.browserExecution.updateMany({
          where: {
            blockingRecoveryId: row.recovery_id,
            status: "WAITING_CAPACITY",
            run: {
              lifecycle: {
                in: ["QUEUED", "PREPARING", "RUNNING", "WAITING_HUMAN"],
              },
            },
          },
          data: { nextAdmissionAt: new Date() },
        });
        await tx.runtimeRecoveryOutbox.update({
          where: { id: row.id },
          data: { deliveredAt: new Date() },
        });
      }
    });
  }
}
