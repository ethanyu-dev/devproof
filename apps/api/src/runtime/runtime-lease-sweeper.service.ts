import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service.js";
import { RuntimeCommandDispatcher } from "./runtime-command-dispatcher.service.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";

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
      const ids = expiredSessions.map((row) => row.id);
      await this.prisma.$transaction([
        this.prisma.browserRuntimeSession.updateMany({
          data: {
            humanControllerUserId: null,
            humanControlExpiresAt: null,
            lastError: {
              code: "LEASE_EXPIRED",
              message: "Runtime did not renew the session lease.",
            },
            status: "LOST",
          },
          where: { id: { in: ids } },
        }),
        this.prisma.browserRuntimeSlot.deleteMany({
          where: { sessionId: { in: ids } },
        }),
        this.prisma.browserRuntimeProfileLease.deleteMany({
          where: { sessionId: { in: ids } },
        }),
      ]);
    }

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
        select: { id: true },
        take: 50,
        where: {
          humanControlExpiresAt: { lte: now },
          leaseExpiresAt: { gt: now },
          status: "HUMAN_CONTROL",
        },
      });
    for (const session of expiredHumanControls) {
      const result = await this.commands.execute({
        commandType: "human.release",
        sessionId: session.id,
        source: "SYSTEM",
      });
      if (result?.status === "SUCCEEDED") {
        await this.prisma.browserRuntimeSession.update({
          data: {
            humanControllerUserId: null,
            humanControlExpiresAt: null,
            status: "ACTIVE",
          },
          where: { id: session.id },
        });
      }
    }
  }
}
