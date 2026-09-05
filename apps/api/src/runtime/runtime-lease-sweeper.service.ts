import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../database/prisma.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { env } from "../config/env.js";
import { RuntimeCommandDispatcher } from "./runtime-command-dispatcher.service.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";
import { quarantineSession } from "./session-resource-cleanup.js";

const STALE_PROFILE_VERIFICATION_MS = 2 * 60 * 1_000;

@Injectable()
export class RuntimeLeaseSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RuntimeLeaseSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: RuntimeCommandDispatcher,
    @Optional() private readonly monitor?: WorkerMonitorService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor?.register("runtime-lease-sweeper", 10_000);
    this.timer = setInterval(() => this.trigger(), 10_000);
    this.timer.unref();
    this.trigger();
  }

  private trigger() {
    const operation = () => this.sweep();
    const running = this.monitor
      ? this.monitor.run("runtime-lease-sweeper", operation)
      : operation();
    void running.catch((error: Error) => {
      this.logger.error("Runtime lease sweep failed: " + error.message);
    });
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async sweep() {
    const now = new Date();
    const expiredSessions = await this.prisma.browserRuntimeSession.findMany({
      select: { id: true },
      where: {
        leaseExpiresAt: { lte: now },
        status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"] },
      },
    });
    if (expiredSessions.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
        for (const session of expiredSessions) {
          const expired = await tx.browserRuntimeSession.updateMany({
            where: {
              id: session.id,
              leaseExpiresAt: { lte: now },
              closureVerifiedAt: null,
              status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"] },
            },
            data: { status: "LOST" },
          });
          if (expired.count !== 1) continue;
          await quarantineSession(tx, session.id, "LEASE_EXPIRED");
        }
      });
    }

    const staleVerificationCutoff = new Date(
      now.getTime() - STALE_PROFILE_VERIFICATION_MS,
    );
    const staleVerificationWhere = {
      runtimeSessions: {
        none: {
          status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"] },
        },
      },
      status: "VERIFYING" as const,
      updatedAt: { lte: staleVerificationCutoff },
    } satisfies Prisma.UserBrowserProfileWhereInput;
    await Promise.all([
      this.prisma.userBrowserProfile.updateMany({
        data: {
          status: "UNINITIALIZED",
          verificationError: {
            code: "PROFILE_VERIFICATION_INTERRUPTED",
            message:
              "The verification process ended before the profile could be saved.",
          },
          version: { increment: 1 },
        },
        where: { ...staleVerificationWhere, lastVerifiedAt: null },
      }),
      this.prisma.userBrowserProfile.updateMany({
        data: {
          status: "REAUTH_REQUIRED",
          verificationError: {
            code: "PROFILE_VERIFICATION_INTERRUPTED",
            message:
              "The verification process ended before the profile could be saved.",
          },
          version: { increment: 1 },
        },
        where: {
          ...staleVerificationWhere,
          lastVerifiedAt: { not: null },
        },
      }),
    ]);

    const expiredCommands = await this.prisma.browserRuntimeCommand.findMany({
      select: { id: true },
      take: 100,
      where: {
        deadlineAt: { lte: now },
        status: { in: ["PENDING", "DISPATCHED"] },
      },
    });
    for (const command of expiredCommands) {
      await this.commands.cancel(
        command.id,
        "Runtime command deadline expired.",
      );
      await this.prisma.browserRuntimeCommand.updateMany({
        data: { status: "TIMED_OUT" },
        where: { id: command.id, status: "CANCELLED" },
      });
    }

    const expiredHumanControls =
      await this.prisma.browserRuntimeSession.findMany({
        select: { id: true, controlGeneration: true },
        take: 50,
        where: {
          humanControlExpiresAt: { lte: now },
          leaseExpiresAt: { gt: now },
          status: "HUMAN_CONTROL",
        },
      });
    for (const session of expiredHumanControls) {
      await this.prisma.$transaction(async (tx) => {
        await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
        const expired = await tx.browserRuntimeSession.updateMany({
          data: { controlGeneration: { increment: 1 } },
          where: {
            id: session.id,
            status: "HUMAN_CONTROL",
            controlGeneration: session.controlGeneration,
            humanControlExpiresAt: { lte: now },
            closureVerifiedAt: null,
          },
        });
        if (expired.count !== 1) return;
        // A control TTL is a permit expiry, so the same browser authority must
        // not be revived by human.release. Heartbeat reconciliation closes LOST
        // sessions and releases capacity only after browser closure is verified.
        await quarantineSession(tx, session.id, "HUMAN_CONTROL_EXPIRED");
      });
    }
  }
}
