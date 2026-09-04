import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { CaseSchedulingDecision } from "@devproof/test-domain";

import { PrismaService } from "../database/prisma.service.js";
import { hostnameMatchesPattern } from "../verification/runtime-routing.js";

const RESERVATION_LEASE_MS = 5 * 60 * 1_000;
const terminalTaskLifecycles = ["COMPLETED", "CANCELLED", "TIMED_OUT"] as const;

@Injectable()
export class ProfileReservationService {
  constructor(private readonly prisma: PrismaService) {}

  async acquire(taskExecutionId: string, deploymentId?: string) {
    const task = await this.prisma.taskExecution.findUnique({
      include: {
        deployments: {
          select: { id: true, targetUrl: true },
          where: {
            enabled: true,
            ...(deploymentId ? { id: deploymentId } : {}),
          },
        },
        deploymentProfileBindings: {
          include: {
            profile: {
              include: {
                grants: { where: { revokedAt: null } },
                owner: {
                  include: { memberships: { select: { teamId: true } } },
                },
              },
            },
          },
          ...(deploymentId ? { where: { deploymentId } } : {}),
        },
        profileBinding: {
          include: {
            resolvedProfile: {
              include: {
                grants: { where: { revokedAt: null } },
                owner: {
                  include: { memberships: { select: { teamId: true } } },
                },
              },
            },
          },
        },
      },
      where: { id: taskExecutionId },
    });
    const profile =
      task?.deploymentProfileBindings?.[0]?.profile ??
      task?.profileBinding?.resolvedProfile;
    if (!task || !profile) return { acquired: true as const, profile: null };
    const blocked = (
      reason: string,
      blockedBy: CaseSchedulingDecision["blockedBy"] = null,
      queue: CaseSchedulingDecision["queue"] = null,
    ) => ({
      acquired: false as const,
      profile,
      reason,
      blockedBy,
      queue,
    });
    const now = new Date();
    if (
      task.profileBinding?.status !== "RESOLVED" ||
      profile.status !== "READY" ||
      terminalTaskLifecycles.includes(
        task.lifecycle as (typeof terminalTaskLifecycles)[number],
      )
    ) {
      return blocked("AUTH_REQUIRED");
    }
    if (
      !profile.inactivityExpiresAt ||
      profile.inactivityExpiresAt.getTime() <= now.getTime()
    ) {
      await this.invalidateBinding(task.id, task.teamId, profile.id, {
        code: "PROFILE_INACTIVITY_EXPIRED",
        eventKind: "task.profile.expired",
        message:
          "The resolved browser profile expired before task dispatch and must be prepared again.",
      });
      return blocked("PROFILE_INACTIVITY_EXPIRED");
    }
    const targetHostnames = environmentHostnames(
      task.environmentSnapshot,
      task.deployments ?? [],
    );
    const triggerSource = task.profileBinding.triggerSource;
    const ownerActive =
      profile.owner.status === "ACTIVE" &&
      profile.owner.memberships.some(
        (membership) => membership.teamId === task.teamId,
      );
    const grantActive =
      triggerSource !== null &&
      targetHostnames.length > 0 &&
      targetHostnames.every((targetHostname) =>
        profile.grants.some(
          (grant) =>
            grant.triggerSource === triggerSource &&
            hostnameMatchesPattern(targetHostname, grant.hostnamePattern),
        ),
      );
    if (!ownerActive || !grantActive) {
      await this.invalidateBinding(task.id, task.teamId, profile.id);
      return blocked("PROFILE_AUTHORIZATION_CHANGED");
    }

    // Identity is shared only through isolated contexts. Snapshot availability,
    // identity permits and business locks are decided atomically at admission.
    if (profile.executionMode === "ISOLATED_AUTH") {
      return { acquired: true as const, profile };
    }

    const current = await this.prisma.browserProfileReservation.upsert({
      create: {
        profileId: profile.id,
        status: "QUEUED",
        taskExecutionId: task.id,
        teamId: task.teamId,
      },
      update: {},
      where: {
        profileId_taskExecutionId: {
          profileId: profile.id,
          taskExecutionId: task.id,
        },
      },
    });
    if (current.status === "ACTIVE") {
      await this.renew(current.id, now);
      return { acquired: true as const, profile };
    }
    if (!["QUEUED", "EXPIRED"].includes(current.status)) {
      return blocked("PROFILE_RESERVED", {
        resourceType: "PROFILE",
        resourceId: profile.id,
      });
    }
    if (current.status === "EXPIRED") {
      await this.prisma.browserProfileReservation.update({
        data: { status: "QUEUED" },
        where: { id: current.id },
      });
    }

    await this.releaseStaleActive(profile.id, now);
    const active = await this.prisma.browserProfileReservation.findFirst({
      select: { id: true, taskExecutionId: true },
      where: { profileId: profile.id, status: "ACTIVE" },
    });
    const queuePosition = async (): Promise<
      CaseSchedulingDecision["queue"]
    > => ({
      scope: "PROFILE_TASK",
      position:
        1 +
        (await this.prisma.browserProfileReservation.count({
          where: {
            profileId: profile.id,
            status: "QUEUED",
            OR: [
              { queuedAt: { lt: current.queuedAt ?? now } },
              { queuedAt: current.queuedAt ?? now, id: { lt: current.id } },
            ],
          },
        })),
      snapshotAt: now.toISOString(),
    });
    if (active)
      return blocked(
        "PROFILE_RESERVED",
        {
          resourceType: "PROFILE",
          resourceId: profile.id,
          taskId: active.taskExecutionId,
        },
        await queuePosition(),
      );
    const first = await this.prisma.browserProfileReservation.findFirst({
      orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
      select: { id: true },
      where: { profileId: profile.id, status: "QUEUED" },
    });
    if (first?.id !== current.id)
      return blocked(
        "PROFILE_RESERVED",
        { resourceType: "PROFILE", resourceId: profile.id },
        await queuePosition(),
      );

    const leaseToken = randomUUID();
    try {
      const activated = await this.prisma.browserProfileReservation.updateMany({
        data: {
          activatedAt: current.activatedAt ?? now,
          leaseExpiresAt: new Date(now.getTime() + RESERVATION_LEASE_MS),
          leaseOwner: `task:${task.id}`,
          leaseToken,
          releasedAt: null,
          status: "ACTIVE",
        },
        where: {
          id: current.id,
          status: "QUEUED",
        },
      });
      return activated.count === 1
        ? { acquired: true as const, profile }
        : blocked("PROFILE_RESERVED", {
            resourceType: "PROFILE",
            resourceId: profile.id,
          });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034"].includes(error.code)
      ) {
        return blocked("PROFILE_RESERVED", {
          resourceType: "PROFILE",
          resourceId: profile.id,
        });
      }
      throw error;
    }
  }

  async recordUsage(input: {
    executionRunId: string;
    hostname: string;
    profileId: string;
    requesterUserId: string | null;
    taskExecutionId: string;
    teamId: string;
    triggerSource: "CONSOLE" | "FEISHU" | "ISSUE_ASSIGNEE";
  }) {
    await this.prisma.browserProfileUsage.create({ data: input });
  }

  private async invalidateBinding(
    taskExecutionId: string,
    teamId: string,
    profileId: string,
    reason: {
      code: string;
      eventKind: string;
      message: string;
    } = {
      code: "PROFILE_AUTHORIZATION_CHANGED",
      eventKind: "task.profile.authorization_changed",
      message:
        "The Profile owner, hostname, or trigger authorization changed before dispatch.",
    },
  ) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const invalidated = await tx.taskProfileBinding.updateMany({
        data: {
          failureCode: reason.code,
          failureMessage: reason.message,
          requestedProfileId: profileId,
          resolvedAt: null,
          resolvedProfileId: null,
          status: "WAITING_INPUT",
          version: { increment: 1 },
        },
        where: {
          OR: [
            { resolvedProfileId: profileId },
            {
              taskExecution: {
                deploymentProfileBindings: { some: { profileId } },
              },
            },
          ],
          status: "RESOLVED",
          taskExecutionId,
        },
      });
      if (invalidated.count !== 1) return;
      await tx.taskDeploymentProfileBinding.deleteMany({
        where: { taskExecutionId },
      });
      await tx.browserProfileReservation.updateMany({
        data: {
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          releasedAt: now,
          status: "CANCELLED",
        },
        where: {
          profileId,
          status: { in: ["ACTIVE", "QUEUED", "EXPIRED"] },
          taskExecutionId,
        },
      });
      await tx.taskExecution.updateMany({
        data: {
          currentStage: "PROFILE_RESOLUTION",
          lifecycle: "WAITING_INPUT",
          projectionNeededAt: null,
          waitingReason: reason.code,
        },
        where: {
          id: taskExecutionId,
          lifecycle: { in: ["QUEUED", "RUNNING", "WAITING_INPUT"] },
        },
      });
      await tx.taskExecutionStage.updateMany({
        data: {
          finishedAt: null,
          status: "WAITING_INPUT",
          waitingReason: reason.code,
        },
        where: { taskExecutionId, type: "PROFILE_RESOLUTION" },
      });
      await tx.taskExecutionEvent.create({
        data: {
          actor: "CONTROL_PLANE",
          kind: reason.eventKind,
          payload: { profileId, reason: reason.code },
          taskExecutionId,
          teamId,
        },
      });
    });
  }

  async releaseTask(taskExecutionId: string) {
    const now = new Date();
    await this.prisma.browserProfileReservation.updateMany({
      data: {
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
        releasedAt: now,
        status: "RELEASED",
      },
      where: {
        status: { in: ["ACTIVE", "QUEUED", "EXPIRED"] },
        taskExecutionId,
      },
    });
  }

  async reconcile(limit = 100) {
    const now = new Date();
    const active = await this.prisma.browserProfileReservation.findMany({
      include: {
        taskExecution: { select: { lifecycle: true } },
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      where: { status: "ACTIVE" },
    });
    let released = 0;
    for (const reservation of active) {
      if (
        terminalTaskLifecycles.includes(
          reservation.taskExecution
            .lifecycle as (typeof terminalTaskLifecycles)[number],
        )
      ) {
        await this.releaseTask(reservation.taskExecutionId);
        released += 1;
      } else {
        await this.renew(reservation.id, now);
      }
    }
    const usages = await this.prisma.browserProfileUsage.findMany({
      include: {
        executionRun: {
          select: {
            executionDisposition: true,
            lifecycle: true,
            verdict: true,
          },
        },
      },
      take: limit,
      where: { executionRunId: { not: null }, finishedAt: null },
    });
    let finishedUsages = 0;
    for (const usage of usages) {
      const run = usage.executionRun;
      if (
        run &&
        ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(run.lifecycle)
      ) {
        await this.prisma.browserProfileUsage.update({
          data: {
            finishedAt: now,
            outcome: run.verdict ?? run.executionDisposition ?? run.lifecycle,
          },
          where: { id: usage.id },
        });
        finishedUsages += 1;
      }
    }
    return { finishedUsages, released };
  }

  private renew(id: string, now: Date) {
    return this.prisma.browserProfileReservation.updateMany({
      data: { leaseExpiresAt: new Date(now.getTime() + RESERVATION_LEASE_MS) },
      where: { id, status: "ACTIVE" },
    });
  }

  private async releaseStaleActive(profileId: string, now: Date) {
    const stale = await this.prisma.browserProfileReservation.findMany({
      include: {
        taskExecution: {
          select: {
            executionRuns: {
              select: { id: true },
              where: {
                lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
              },
            },
            lifecycle: true,
          },
        },
      },
      where: {
        leaseExpiresAt: { lt: now },
        profileId,
        status: "ACTIVE",
      },
    });
    for (const reservation of stale) {
      if (
        reservation.taskExecution.executionRuns.length ||
        !terminalTaskLifecycles.includes(
          reservation.taskExecution
            .lifecycle as (typeof terminalTaskLifecycles)[number],
        )
      ) {
        await this.renew(reservation.id, now);
      } else {
        await this.releaseTask(reservation.taskExecutionId);
      }
    }
  }
}

function environmentHostnames(
  value: Prisma.JsonValue,
  deployments: readonly { targetUrl: string }[] | undefined,
) {
  const configuredDeployments = deployments ?? [];
  const urls = configuredDeployments.length
    ? configuredDeployments.map((deployment) => deployment.targetUrl)
    : value && typeof value === "object" && !Array.isArray(value)
      ? typeof value.targetUrl === "string"
        ? [value.targetUrl]
        : []
      : [];
  return Array.from(
    new Set(
      urls.flatMap((url) => {
        try {
          return [new URL(url).hostname];
        } catch {
          return [];
        }
      }),
    ),
  );
}
