import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { MetricsService } from "../observability/metrics.service.js";
import { RuntimeSessionsService } from "../runtime/runtime-sessions.service.js";
import { BrowserExecutionRunner } from "../verification/browser-execution-runner.service.js";

const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const lifecycleProfileInclude = {
  owner: {
    include: {
      memberships: { select: { teamId: true } },
    },
  },
} satisfies Prisma.UserBrowserProfileInclude;

@Injectable()
export class BrowserProfileLifecycleWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(BrowserProfileLifecycleWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly browser: BrowserExecutionRunner,
    private readonly metrics: MetricsService,
    private readonly sessions: RuntimeSessionsService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.timer = setInterval(() => this.trigger(), SWEEP_INTERVAL_MS);
    this.timer.unref();
    this.trigger();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(limit = 50) {
    if (this.running) return { purged: 0 };
    this.running = true;
    try {
      const now = new Date();
      const profiles = await this.prisma.userBrowserProfile.findMany({
        include: lifecycleProfileInclude,
        orderBy: { updatedAt: "asc" },
        take: limit,
        where: {
          OR: [
            { inactivityExpiresAt: { lte: now } },
            { owner: { status: { not: "ACTIVE" } } },
          ],
        },
      });
      const membershipCandidates = await this.findOffboardedProfiles(limit);
      const combined = new Map(
        [...profiles, ...membershipCandidates]
          .filter(
            (profile) =>
              (profile.inactivityExpiresAt?.getTime() ?? Infinity) <=
                now.getTime() ||
              profile.owner.status !== "ACTIVE" ||
              !profile.owner.memberships.some(
                (membership) => membership.teamId === profile.teamId,
              ),
          )
          .map((profile) => [profile.id, profile] as const),
      );
      let purged = 0;
      for (const profile of combined.values()) {
        const ownerOffboarded =
          profile.owner.status !== "ACTIVE" ||
          !profile.owner.memberships.some(
            (membership) => membership.teamId === profile.teamId,
          );
        const reason = ownerOffboarded
          ? "PROFILE_OWNER_OFFBOARDED"
          : "PROFILE_INACTIVITY_EXPIRED";
        if (await this.purge(profile, reason)) purged += 1;
      }
      return { purged };
    } finally {
      this.running = false;
    }
  }

  private trigger() {
    void this.sweep().catch((error: Error) =>
      this.logger.error(
        `Browser profile lifecycle sweep failed: ${error.message}`,
      ),
    );
  }

  private async findOffboardedProfiles(limit: number) {
    const selected: Array<
      Prisma.UserBrowserProfileGetPayload<{
        include: typeof lifecycleProfileInclude;
      }>
    > = [];
    const pageSize = Math.max(100, limit * 4);
    let cursor: string | undefined;
    while (selected.length < limit) {
      const page = await this.prisma.userBrowserProfile.findMany({
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: lifecycleProfileInclude,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: pageSize,
      });
      for (const profile of page) {
        if (
          profile.owner.status !== "ACTIVE" ||
          !profile.owner.memberships.some(
            (membership) => membership.teamId === profile.teamId,
          )
        ) {
          selected.push(profile);
          if (selected.length === limit) break;
        }
      }
      if (page.length < pageSize) break;
      cursor = page.at(-1)?.id;
      if (!cursor) break;
    }
    return selected;
  }

  private async purge(
    profile: {
      id: string;
      runtimeProfileKey: string;
      teamId: string;
      version: number;
    },
    reason: string,
  ) {
    const now = new Date();
    const claimed = await this.prisma.userBrowserProfile.updateMany({
      data: {
        status: "DISABLED",
        verificationError: json({
          code: reason,
          detectedAt: now.toISOString(),
        }),
        version: { increment: 1 },
      },
      where: { id: profile.id, version: profile.version },
    });
    if (claimed.count !== 1) return false;
    try {
      await this.sessions.closeIdleProfileSessions(profile.id);
    } catch (error) {
      this.logger.warn(
        `Browser profile idle session cleanup failed for ${profile.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    const [activeRuns, activeSessions] = await Promise.all([
      this.prisma.executionRun.count({
        where: {
          browserProfileId: profile.id,
          lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
        },
      }),
      this.prisma.browserRuntimeSession.count({
        where: {
          status: {
            in: ["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"],
          },
          userBrowserProfileId: profile.id,
        },
      }),
    ]);
    if (activeRuns || activeSessions) return false;

    const bindings = await this.prisma.taskProfileBinding.findMany({
      select: { taskExecutionId: true },
      where: { resolvedProfileId: profile.id, status: "RESOLVED" },
    });
    const taskIds = bindings.map((binding) => binding.taskExecutionId);
    try {
      await this.browser.purgeProfile(
        profile.teamId,
        profile.runtimeProfileKey,
        profile.id,
      );
    } catch (error) {
      await this.prisma.userBrowserProfile.updateMany({
        data: {
          verificationError: json({
            code: `${reason}_DELETE_RETRY`,
            message: error instanceof Error ? error.message : String(error),
          }),
        },
        where: { id: profile.id, status: "DISABLED" },
      });
      return false;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.taskProfileBinding.updateMany({
        data: {
          failureCode: reason,
          failureMessage: "The resolved browser profile was deleted.",
          resolvedAt: null,
          resolvedProfileId: null,
          status: "WAITING_INPUT",
          version: { increment: 1 },
        },
        where: { resolvedProfileId: profile.id, status: "RESOLVED" },
      });
      if (taskIds.length) {
        await tx.taskExecution.updateMany({
          data: {
            currentStage: "PROFILE_RESOLUTION",
            lifecycle: "WAITING_INPUT",
            projectionNeededAt: null,
            waitingReason: reason,
          },
          where: {
            id: { in: taskIds },
            lifecycle: { in: ["QUEUED", "RUNNING", "WAITING_INPUT"] },
          },
        });
        await tx.taskExecutionStage.updateMany({
          data: {
            finishedAt: null,
            status: "WAITING_INPUT",
            waitingReason: reason,
          },
          where: {
            taskExecutionId: { in: taskIds },
            type: "PROFILE_RESOLUTION",
          },
        });
        await tx.taskExecutionEvent.createMany({
          data: taskIds.map((taskExecutionId) => ({
            actor: "CONTROL_PLANE",
            kind: "task.profile.deleted",
            payload: json({ profileId: profile.id, reason }),
            taskExecutionId,
            teamId: profile.teamId,
          })),
        });
      }
      await tx.userBrowserProfile.delete({
        where: { id: profile.id },
      });
    });
    this.metrics.increment(
      "devproof_browser_profile_purges_total",
      "User browser profiles physically purged by reason.",
      { reason: reason.toLowerCase() },
    );
    return true;
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
