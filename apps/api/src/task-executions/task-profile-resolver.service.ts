import { createHash } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  taskExecutionCreateInputSchema,
  taskProfilePolicySchema,
  testGenerationContextSchema,
  type TaskProfilePolicy,
  type TaskProfileSelectionInput,
} from "@devproof/contracts";

import { UserBrowserProfilesService } from "../browser-profiles/user-browser-profiles.service.js";
import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { enqueueTaskWaitingNotification } from "./task-waiting-notification.js";

const bindingInclude = {
  deployments: {
    select: { id: true, targetUrl: true },
    where: { enabled: true },
  },
  profileBinding: true,
  specificationSnapshots: {
    orderBy: { generatedAt: "desc" as const },
    select: { context: true },
    take: 1,
  },
  stages: true,
} satisfies Prisma.TaskExecutionInclude;

type ResolutionFailure = {
  code: string;
  message: string;
  snapshot?: Record<string, unknown>;
};

@Injectable()
export class TaskProfileResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: UserBrowserProfilesService,
  ) {}

  async select(
    teamId: string,
    userId: string,
    taskExecutionId: string,
    input: TaskProfileSelectionInput,
  ) {
    const task = await this.prisma.taskExecution.findFirst({
      include: {
        executionRuns: { select: { id: true } },
        profileBinding: true,
      },
      where: { id: taskExecutionId, teamId },
    });
    if (!task) throw new NotFoundException("Task execution was not found.");
    if (!task.profileBinding || task.kind !== "ISSUE_SPEC") {
      throw new ConflictException(
        "This task does not support profile selection.",
      );
    }
    if (task.executionRuns.length) {
      throw new ConflictException(
        "The profile is immutable after execution starts.",
      );
    }
    if (["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(task.lifecycle)) {
      throw new ConflictException("A terminal task cannot change profiles.");
    }
    const claimRequester =
      input.profilePolicy.strategy === "REQUESTER" &&
      task.requestedByUserId === null;
    if (
      input.profilePolicy.strategy === "REQUESTER" &&
      task.requestedByUserId !== null &&
      task.requestedByUserId !== userId
    ) {
      throw new ConflictException(
        "Only the requester can select requester profile mode.",
      );
    }
    if (input.profilePolicy.profileId) {
      const owned = await this.prisma.userBrowserProfile.findFirst({
        select: { id: true },
        where: {
          id: input.profilePolicy.profileId,
          ownerUserId: userId,
          teamId,
        },
      });
      if (!owned) {
        throw new ConflictException("The explicit profile must belong to you.");
      }
    }
    const parsedInput = taskExecutionCreateInputSchema.parse(
      task.inputSnapshot,
    );
    if (parsedInput.kind !== "ISSUE_SPEC") {
      throw new ConflictException(
        "This task does not support profile selection.",
      );
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.taskDeploymentProfileBinding.deleteMany({
        where: { taskExecutionId: task.id },
      });
      await tx.taskProfileBinding.update({
        data: {
          externalIdentitySnapshot: {},
          failureCode: null,
          failureMessage: null,
          profileOwnerUserId: null,
          requestedProfileId: input.profilePolicy.profileId ?? null,
          resolvedAt: null,
          resolvedProfileId: null,
          scopeKey: profilePolicyScopeKey(input.profilePolicy),
          status: "PENDING",
          strategy: input.profilePolicy.strategy,
          triggerSource:
            input.profilePolicy.strategy === "ISSUE_ASSIGNEE"
              ? "ISSUE_ASSIGNEE"
              : "CONSOLE",
          unavailablePolicy: input.profilePolicy.onUnavailable,
          version: { increment: 1 },
        },
        where: { id: task.profileBinding!.id },
      });
      await tx.taskExecution.update({
        data: {
          currentStage: "PROFILE_RESOLUTION",
          inputSnapshot: json({
            ...parsedInput,
            profilePolicy: input.profilePolicy,
          }),
          lifecycle: "RUNNING",
          ...(claimRequester
            ? { requestedByKind: "USER", requestedByUserId: userId }
            : {}),
          waitingReason: null,
        },
        where: { id: task.id },
      });
      await tx.taskExecutionStage.updateMany({
        data: {
          finishedAt: null,
          lastError: Prisma.JsonNull,
          startedAt: now,
          status: "PENDING",
          waitingReason: null,
        },
        where: { taskExecutionId: task.id, type: "PROFILE_RESOLUTION" },
      });
      await tx.taskExecutionEvent.create({
        data: taskEvent(
          teamId,
          task.id,
          "HUMAN",
          "task.profile.selection_updated",
          {
            requesterClaimed: claimRequester,
            strategy: input.profilePolicy.strategy,
          },
        ),
      });
    });
    return this.resolve(task.id);
  }

  async reconcile(limit = 25) {
    const tasks = await this.prisma.taskExecution.findMany({
      orderBy: { updatedAt: "asc" },
      select: { id: true },
      take: limit,
      where: {
        cancelRequestedAt: null,
        deadlineAt: { gt: new Date() },
        kind: "ISSUE_SPEC",
        lifecycle: { in: ["RUNNING", "WAITING_INPUT"] },
        stages: {
          some: {
            status: { in: ["PENDING", "WAITING_INPUT"] },
            type: "PROFILE_RESOLUTION",
          },
        },
      },
    });
    let resolved = 0;
    for (const task of tasks) {
      const result = await this.resolve(task.id).catch(() => null);
      if (result?.status === "RESOLVED") resolved += 1;
    }
    return resolved;
  }

  async resolve(taskExecutionId: string) {
    const task = await this.prisma.taskExecution.findUnique({
      include: bindingInclude,
      where: { id: taskExecutionId },
    });
    if (!task?.profileBinding || task.kind !== "ISSUE_SPEC") return null;
    if (["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(task.lifecycle)) {
      return task.profileBinding;
    }
    const analysis = task.stages.find(
      (stage) => stage.type === "SPEC_ANALYSIS",
    );
    if (analysis?.status !== "SUCCEEDED") return task.profileBinding;

    const input = taskExecutionCreateInputSchema.parse(task.inputSnapshot);
    if (input.kind !== "ISSUE_SPEC") return task.profileBinding;
    const policy = taskProfilePolicySchema.parse(input.profilePolicy);
    const environment = record(task.environmentSnapshot);
    const deployments = task.deployments ?? [];
    const deploymentTargetUrls = deployments.map(
      (deployment) => deployment.targetUrl,
    );
    const targetUrl =
      deploymentTargetUrls[0] ??
      (typeof environment.targetUrl === "string"
        ? environment.targetUrl
        : null);
    const targetHostname = targetUrl
      ? new URL(targetUrl).hostname
      : policy.scope.hostname;
    const triggerSource = task.profileBinding.triggerSource ?? "CONSOLE";
    const now = new Date();

    if (policy.strategy === "EPHEMERAL") {
      return this.succeed(task, policy, null, null, targetHostname, now);
    }
    if (!targetHostname) {
      return this.unavailable(
        task,
        { ...policy, onUnavailable: "WAIT_FOR_PROFILE" },
        {
          code: "DEPLOYMENT_TARGET_REQUIRED",
          message:
            "A deployment target is required before a profile can be authorized.",
        },
      );
    }

    const owner = await this.resolveOwner(task, policy);
    if ("code" in owner) {
      return this.unavailable(task, policy, owner, targetHostname);
    }
    const deploymentProfiles: Array<{
      deploymentId: string;
      profileId: string;
    }> = [];
    const pendingProfiles: Array<{
      deploymentId: string | null;
      profile: Awaited<
        ReturnType<UserBrowserProfilesService["provisionForTask"]>
      >;
      targetUrl: string;
    }> = [];
    const targets = deployments.length
      ? deployments
      : targetUrl
        ? [{ id: null, targetUrl }]
        : [];
    for (const deployment of targets) {
      const hostname = new URL(deployment.targetUrl).hostname;
      const profile = await this.profiles.resolveProfile({
        ownerUserId: owner.userId,
        policy,
        targetHostname: hostname,
        teamId: task.teamId,
        triggerSource,
      });
      if (profile) {
        if (deployment.id) {
          deploymentProfiles.push({
            deploymentId: deployment.id,
            profileId: profile.id,
          });
        }
        continue;
      }
      const pendingProfile =
        policy.strategy !== "EXPLICIT_PROFILE" &&
        policy.onUnavailable === "WAIT_FOR_PROFILE"
          ? await this.profiles.provisionForTask({
              authRole: policy.scope.authRole,
              environmentKey: policy.scope.environmentKey,
              ownerUserId: owner.userId,
              targetUrl: deployment.targetUrl,
              teamId: task.teamId,
              triggerSource,
            })
          : null;
      pendingProfiles.push({
        deploymentId: deployment.id,
        profile: pendingProfile,
        targetUrl: deployment.targetUrl,
      });
    }
    if (pendingProfiles.length) {
      const firstPending = pendingProfiles.find(
        (item) => item.profile,
      )?.profile;
      const allReady = pendingProfiles.every(
        (item) => item.profile?.status === "READY",
      );
      return this.unavailable(
        task,
        policy,
        firstPending
          ? {
              code: allReady
                ? "PROFILE_ACCESS_APPROVAL_REQUIRED"
                : "PROFILE_LOGIN_REQUIRED",
              message: allReady
                ? "The profile owner must approve access for every Deployment before execution."
                : "The profile owner must complete browser login for every Deployment before execution.",
              snapshot: {
                ...owner.snapshot,
                pendingProfiles: pendingProfiles.map((item) => ({
                  deploymentId: item.deploymentId,
                  profileId: item.profile?.id ?? null,
                  targetUrl: item.targetUrl,
                })),
              },
            }
          : {
              code: "PROFILE_NOT_READY_OR_NOT_AUTHORIZED",
              message:
                "No READY profile owned by the selected user grants this trigger access to every Deployment hostname.",
              snapshot: owner.snapshot,
            },
        targetHostname,
        firstPending
          ? {
              ownerUserId: owner.userId,
              requestedProfileId: firstPending.id,
            }
          : { ownerUserId: owner.userId },
      );
    }
    const primaryProfileId =
      deploymentProfiles[0]?.profileId ?? policy.profileId ?? null;
    return this.succeed(
      task,
      policy,
      primaryProfileId,
      owner.userId,
      targetHostname,
      now,
      owner.snapshot,
      deploymentProfiles,
    );
  }

  private async resolveOwner(
    task: Prisma.TaskExecutionGetPayload<{ include: typeof bindingInclude }>,
    policy: TaskProfilePolicy,
  ): Promise<
    { snapshot: Record<string, unknown>; userId: string } | ResolutionFailure
  > {
    if (policy.strategy === "REQUESTER") {
      return task.requestedByUserId
        ? { snapshot: { source: "REQUESTER" }, userId: task.requestedByUserId }
        : {
            code: "PROFILE_REQUESTER_UNKNOWN",
            message: "The task requester is not linked to a DevProof user.",
          };
    }
    if (policy.strategy === "EXPLICIT_PROFILE") {
      const profile = await this.prisma.userBrowserProfile.findFirst({
        select: { ownerUserId: true },
        where: { id: policy.profileId!, teamId: task.teamId },
      });
      return profile
        ? {
            snapshot: {
              profileId: policy.profileId,
              source: "EXPLICIT_PROFILE",
            },
            userId: profile.ownerUserId,
          }
        : {
            code: "PROFILE_EXPLICIT_NOT_FOUND",
            message: "The selected profile does not exist in this team.",
          };
    }
    const snapshot = task.specificationSnapshots[0];
    if (!snapshot) {
      return {
        code: "PROFILE_ISSUE_CONTEXT_MISSING",
        message: "Issue context is not available yet.",
      };
    }
    const assignee = testGenerationContextSchema.parse(snapshot.context).issue
      .assignee;
    if (!assignee) {
      return {
        code: "PROFILE_ISSUE_UNASSIGNED",
        message: "The Linear issue has no assignee.",
      };
    }
    if (assignee.type === "AGENT") {
      return {
        code: "PROFILE_ISSUE_ASSIGNEE_IS_AGENT",
        message: "Agent assignees cannot own a user browser profile.",
        snapshot: { assignee },
      };
    }
    const issuerKey =
      assignee.issuerKey ?? env().LINEAR_WORKSPACE_ID ?? "linear:mcp:default";
    const identity = await this.prisma.userExternalIdentity.findUnique({
      where: {
        provider_issuerKey_externalUserId: {
          externalUserId: assignee.externalId,
          issuerKey,
          provider: "LINEAR",
        },
      },
    });
    if (identity?.teamId === task.teamId) {
      return {
        snapshot: { assignee, issuerKey, source: "LINEAR_IDENTITY" },
        userId: identity.userId,
      };
    }
    if (identity) {
      return {
        code: "PROFILE_ISSUE_ASSIGNEE_ISSUER_CONFLICT",
        message:
          "The Linear assignee identity is already linked outside this team.",
        snapshot: { assignee, issuerKey },
      };
    }
    if (assignee.email) {
      const candidates = await this.prisma.user.findMany({
        select: { id: true },
        take: 2,
        where: {
          email: { equals: assignee.email, mode: "insensitive" },
          memberships: { some: { teamId: task.teamId } },
          status: "ACTIVE",
        },
      });
      if (candidates.length === 1 && candidates[0]) {
        let linked: { teamId: string; userId: string } | null;
        try {
          linked = await this.prisma.userExternalIdentity.create({
            data: {
              externalUserId: assignee.externalId,
              issuerKey,
              metadata: { assignee },
              normalizedEmail: assignee.email.toLowerCase(),
              provider: "LINEAR",
              teamId: task.teamId,
              userId: candidates[0].id,
              verifiedAt: new Date(),
            },
            select: { teamId: true, userId: true },
          });
        } catch (error) {
          if (
            !(error instanceof Prisma.PrismaClientKnownRequestError) ||
            error.code !== "P2002"
          ) {
            throw error;
          }
          linked = await this.prisma.userExternalIdentity.findUnique({
            select: { teamId: true, userId: true },
            where: {
              provider_issuerKey_externalUserId: {
                externalUserId: assignee.externalId,
                issuerKey,
                provider: "LINEAR",
              },
            },
          });
        }
        if (
          !linked ||
          linked.teamId !== task.teamId ||
          linked.userId !== candidates[0].id
        ) {
          return {
            code: "PROFILE_ISSUE_ASSIGNEE_ISSUER_CONFLICT",
            message:
              "The Linear assignee identity was concurrently linked to another user or team.",
            snapshot: { assignee, issuerKey },
          };
        }
        return {
          snapshot: { assignee, issuerKey, source: "VERIFIED_EMAIL_EXACT" },
          userId: linked.userId,
        };
      }
    }
    return {
      code: "PROFILE_ISSUE_ASSIGNEE_UNMAPPED",
      message: "The Linear assignee is not linked to one active DevProof user.",
      snapshot: { assignee, issuerKey },
    };
  }

  private async unavailable(
    task: Prisma.TaskExecutionGetPayload<{ include: typeof bindingInclude }>,
    policy: TaskProfilePolicy,
    failure: ResolutionFailure,
    targetHostname?: string,
    pending?: { ownerUserId: string; requestedProfileId?: string },
  ) {
    const binding = task.profileBinding;
    if (!binding) return null;
    if (policy.onUnavailable === "USE_EPHEMERAL") {
      return this.succeed(
        task,
        { ...policy, strategy: "EPHEMERAL" },
        null,
        null,
        targetHostname ?? policy.scope.hostname,
        new Date(),
        { ...failure.snapshot, fallbackCode: failure.code },
      );
    }
    const now = new Date();
    const rejected = policy.onUnavailable === "FAIL";
    const requestedProfileId =
      pending?.requestedProfileId ?? binding.requestedProfileId ?? null;
    const profileOwnerUserId = pending?.ownerUserId ?? null;
    const profileStage = task.stages.find(
      (stage) => stage.type === "PROFILE_RESOLUTION",
    );
    const sameWaitingState =
      !rejected &&
      task.lifecycle === "WAITING_INPUT" &&
      task.waitingReason === failure.code &&
      profileStage?.status === "WAITING_INPUT" &&
      profileStage.waitingReason === failure.code &&
      binding.status === "WAITING_INPUT" &&
      binding.failureCode === failure.code &&
      binding.failureMessage === failure.message &&
      (binding.requestedProfileId ?? null) === requestedProfileId &&
      (binding.profileOwnerUserId ?? null) === profileOwnerUserId;
    const notificationGeneration = binding.version + (sameWaitingState ? 0 : 1);
    const waitingInput =
      failure.code === "DEPLOYMENT_TARGET_REQUIRED"
        ? "DEPLOYMENT_TARGET"
        : "BROWSER_PROFILE";
    await this.prisma.$transaction(async (tx) => {
      if (!sameWaitingState) {
        await tx.taskDeploymentProfileBinding.deleteMany({
          where: { taskExecutionId: task.id },
        });
        await tx.taskProfileBinding.update({
          data: {
            externalIdentitySnapshot: json(failure.snapshot ?? {}),
            failureCode: failure.code,
            failureMessage: failure.message,
            ...(pending
              ? {
                  profileOwnerUserId: pending.ownerUserId,
                  ...(pending.requestedProfileId
                    ? { requestedProfileId: pending.requestedProfileId }
                    : {}),
                }
              : {}),
            resolvedAt: null,
            resolvedProfileId: null,
            status: rejected ? "REJECTED" : "WAITING_INPUT",
            version: { increment: 1 },
          },
          where: { id: binding.id },
        });
        await tx.taskExecutionStage.updateMany({
          data: {
            finishedAt: rejected ? now : null,
            lastError: rejected
              ? json({ code: failure.code, message: failure.message })
              : Prisma.JsonNull,
            startedAt: profileStage?.startedAt ?? now,
            status: rejected ? "FAILED" : "WAITING_INPUT",
            waitingReason: rejected ? null : failure.code,
          },
          where: { taskExecutionId: task.id, type: "PROFILE_RESOLUTION" },
        });
        if (rejected) {
          await tx.taskExecutionStage.updateMany({
            data: { finishedAt: now, status: "SKIPPED" },
            where: { taskExecutionId: task.id, type: "SPEC_EXECUTION" },
          });
        }
        await tx.taskExecution.update({
          data: rejected
            ? {
                currentStage: "PROFILE_RESOLUTION",
                executionDisposition: "BLOCKED",
                finishedAt: now,
                lifecycle: "COMPLETED",
                projectionNeededAt: null,
                verdict: "INCONCLUSIVE",
                waitingReason: null,
              }
            : {
                currentStage: "PROFILE_RESOLUTION",
                lifecycle: "WAITING_INPUT",
                projectionNeededAt: null,
                waitingReason: failure.code,
              },
          where: { id: task.id },
        });
        await tx.taskExecutionEvent.create({
          data: taskEvent(
            task.teamId,
            task.id,
            "CONTROL_PLANE",
            rejected ? "task.profile.rejected" : "task.waiting_input",
            {
              code: failure.code,
              input: waitingInput,
              message: failure.message,
              profileId: requestedProfileId,
              profileOwnerUserId,
            },
          ),
        });
      }
      if (!rejected) {
        await enqueueTaskWaitingNotification(tx, {
          generation: notificationGeneration,
          input: waitingInput,
          message: failure.message,
          notificationContext: task.notificationContext,
          profileId: requestedProfileId,
          profileOwnerUserId,
          reason: failure.code,
          taskExecutionId: task.id,
          teamId: task.teamId,
          title: task.title,
        });
      }
    });
    return this.prisma.taskProfileBinding.findUnique({
      where: { id: binding.id },
    });
  }

  private async succeed(
    task: Prisma.TaskExecutionGetPayload<{ include: typeof bindingInclude }>,
    policy: TaskProfilePolicy,
    profileId: string | null,
    ownerUserId: string | null,
    targetHostname: string | undefined,
    now: Date,
    snapshot: Record<string, unknown> = {},
    deploymentProfiles: Array<{
      deploymentId: string;
      profileId: string;
    }> = [],
  ) {
    const binding = task.profileBinding;
    if (!binding) return null;
    const environment = record(task.environmentSnapshot);
    const targetAvailable = typeof environment.targetUrl === "string";
    await this.prisma.$transaction(async (tx) => {
      await tx.taskDeploymentProfileBinding.deleteMany({
        where: { taskExecutionId: task.id },
      });
      if (deploymentProfiles.length) {
        await tx.taskDeploymentProfileBinding.createMany({
          data: deploymentProfiles.map((deploymentProfile) => ({
            ...deploymentProfile,
            taskExecutionId: task.id,
            teamId: task.teamId,
          })),
        });
      }
      await tx.taskProfileBinding.update({
        data: {
          externalIdentitySnapshot: json(snapshot),
          failureCode: null,
          failureMessage: null,
          profileOwnerUserId: ownerUserId,
          resolvedAt: now,
          resolvedProfileId: profileId,
          status: "RESOLVED",
          strategy: policy.strategy,
          version: { increment: 1 },
        },
        where: { id: binding.id },
      });
      await tx.taskExecutionStage.updateMany({
        data: {
          finishedAt: now,
          lastError: Prisma.JsonNull,
          startedAt: now,
          status: "SUCCEEDED",
          waitingReason: null,
        },
        where: { taskExecutionId: task.id, type: "PROFILE_RESOLUTION" },
      });
      await tx.taskExecutionStage.updateMany({
        data: {
          currentAttemptNumber: targetAvailable ? 1 : 0,
          startedAt: targetAvailable ? now : null,
          status: targetAvailable ? "RUNNING" : "WAITING_INPUT",
          waitingReason: targetAvailable ? null : "DEPLOYMENT_TARGET_REQUIRED",
        },
        where: { taskExecutionId: task.id, type: "SPEC_EXECUTION" },
      });
      await tx.taskExecution.update({
        data: {
          currentStage: "SPEC_EXECUTION",
          lifecycle: targetAvailable ? "RUNNING" : "WAITING_INPUT",
          projectionNeededAt: targetAvailable ? now : null,
          waitingReason: targetAvailable ? null : "DEPLOYMENT_TARGET_REQUIRED",
        },
        where: { id: task.id },
      });
      await tx.taskExecutionEvent.create({
        data: taskEvent(
          task.teamId,
          task.id,
          "CONTROL_PLANE",
          "task.profile.resolved",
          {
            hostname: targetHostname ?? null,
            profileId,
            deploymentProfiles,
            strategy: policy.strategy,
          },
        ),
      });
      if (!targetAvailable) {
        await enqueueTaskWaitingNotification(tx, {
          generation: binding.version + 1,
          input: "DEPLOYMENT_TARGET",
          message: "A deployment target is required before Case execution.",
          notificationContext: task.notificationContext,
          reason: "DEPLOYMENT_TARGET_REQUIRED",
          taskExecutionId: task.id,
          teamId: task.teamId,
          title: task.title,
        });
      }
    });
    return this.prisma.taskProfileBinding.findUnique({
      where: { id: binding.id },
    });
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function profilePolicyScopeKey(policy: TaskProfilePolicy) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        authRole: policy.scope.authRole,
        environmentKey: policy.scope.environmentKey,
        hostname: policy.scope.hostname ?? null,
      }),
    )
    .digest("hex");
}

function record(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function taskEvent(
  teamId: string,
  taskExecutionId: string,
  actor: string,
  kind: string,
  payload: Record<string, unknown>,
): Prisma.TaskExecutionEventUncheckedCreateInput {
  return { actor, kind, payload: json(payload), taskExecutionId, teamId };
}
