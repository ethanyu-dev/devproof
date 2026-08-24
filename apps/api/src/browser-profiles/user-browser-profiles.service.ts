import { createHash, randomUUID } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  type TaskProfilePolicy,
  type UserBrowserProfileCreateInput,
  type UserBrowserProfilePrepareInput,
  type UserBrowserProfileUpdateInput,
} from "@devproof/contracts";
import type { BrowserHumanInputEvent } from "@devproof/runtime-protocol";

import type { AuthContext } from "../auth/auth.types.js";
import { AuditService } from "../console/audit.service.js";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../infrastructure/redis.service.js";
import { RuntimeSessionsService } from "../runtime/runtime-sessions.service.js";
import {
  RuntimeHumanControlRelay,
  type HumanPreviewEvent,
} from "../runtime/runtime-human-control-relay.service.js";
import { BrowserExecutionRunner } from "../verification/browser-execution-runner.service.js";
import {
  hostnameMatchesPattern,
  resolveRuntimeRoutingPlan,
} from "../verification/runtime-routing.js";

const PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const profileInclude = {
  assignedRuntime: {
    select: { id: true, name: true, status: true, lastSeenAt: true },
  },
  grants: { orderBy: { createdAt: "asc" as const } },
  owner: { select: { avatarUrl: true, email: true, id: true, name: true } },
  runtimeSessions: {
    orderBy: { createdAt: "desc" as const },
    select: {
      humanControlExpiresAt: true,
      id: true,
      purpose: true,
      status: true,
    },
    take: 1,
  },
} satisfies Prisma.UserBrowserProfileInclude;

type ProfileRow = Prisma.UserBrowserProfileGetPayload<{
  include: typeof profileInclude;
}>;

type ProfileTriggerSource = "CONSOLE" | "FEISHU" | "ISSUE_ASSIGNEE";

@Injectable()
export class UserBrowserProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly sessions: RuntimeSessionsService,
    private readonly humanRelay: RuntimeHumanControlRelay,
    private readonly browser: BrowserExecutionRunner,
    private readonly audit: AuditService,
  ) {}

  async list(current: AuthContext) {
    const rows = await this.prisma.userBrowserProfile.findMany({
      include: profileInclude,
      orderBy: { createdAt: "desc" },
      where: { ownerUserId: current.user.id, teamId: current.team.id },
    });
    return rows.map((row) => this.serialize(row));
  }

  async detail(current: AuthContext, id: string) {
    return this.serialize(await this.owned(current, id));
  }

  async create(current: AuthContext, input: UserBrowserProfileCreateInput) {
    const verificationHostname = normalizedHostname(input.verificationUrl);
    if (input.runtimeId) {
      await this.requireRuntime(
        current.team.id,
        input.runtimeId,
        verificationHostname,
      );
    }
    const scopeKey = profileScopeKey({
      authRole: input.authRole,
      environmentKey: input.environmentKey,
      hostname: verificationHostname,
    });
    try {
      const profile = await this.prisma.$transaction(async (tx) => {
        const created = await tx.userBrowserProfile.create({
          data: {
            assignedRuntimeId: input.runtimeId ?? null,
            authRole: input.authRole,
            displayName: input.displayName,
            environmentKey: input.environmentKey,
            ownerUserId: current.user.id,
            runtimeProfileKey: `ubp-${randomUUID().replaceAll("-", "")}`,
            scopeKey,
            teamId: current.team.id,
            verificationRules: json(input.verificationRules),
            verificationUrl: input.verificationUrl,
          },
        });
        await tx.browserProfileGrant.createMany({
          data: input.grants.map((triggerSource) => ({
            consentedByUserId: current.user.id,
            hostnamePattern: verificationHostname,
            profileId: created.id,
            teamId: current.team.id,
            triggerSource,
          })),
        });
        return tx.userBrowserProfile.findUniqueOrThrow({
          include: profileInclude,
          where: { id: created.id },
        });
      });
      await this.audit.record(
        current,
        "browser_profile.created",
        "user_browser_profile",
        profile.id,
        {
          authRole: profile.authRole,
          environmentKey: profile.environmentKey,
          siteHostname: verificationHostname,
        },
      );
      return this.serialize(profile);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "A browser profile already exists for this environment, role, and hostname scope.",
        );
      }
      throw error;
    }
  }

  async provisionForTask(input: {
    authRole: string;
    environmentKey: string;
    ownerUserId: string;
    targetUrl: string;
    teamId: string;
    triggerSource: ProfileTriggerSource;
  }) {
    const owner = await this.prisma.user.findFirst({
      select: { id: true },
      where: {
        id: input.ownerUserId,
        memberships: { some: { teamId: input.teamId } },
        status: "ACTIVE",
      },
    });
    if (!owner) return null;

    const target = new URL(input.targetUrl);
    const targetHostname = normalizedHostname(target);
    const scopeKey = profileScopeKey({
      authRole: input.authRole,
      environmentKey: input.environmentKey,
      hostname: targetHostname,
    });
    const uniqueWhere = {
      teamId_ownerUserId_scopeKey: {
        ownerUserId: input.ownerUserId,
        scopeKey,
        teamId: input.teamId,
      },
    } as const;
    let profile = await this.prisma.userBrowserProfile.findUnique({
      include: profileInclude,
      where: uniqueWhere,
    });
    if (!profile) {
      try {
        profile = await this.prisma.userBrowserProfile.create({
          data: {
            authRole: input.authRole,
            displayName: automaticProfileName(
              target.hostname,
              input.environmentKey,
              input.authRole,
            ),
            environmentKey: input.environmentKey,
            ownerUserId: input.ownerUserId,
            runtimeProfileKey: `ubp-${randomUUID().replaceAll("-", "")}`,
            scopeKey,
            teamId: input.teamId,
            verificationRules: json(
              automaticVerificationRules(input.targetUrl, [
                input.triggerSource,
              ]),
            ),
            verificationUrl: input.targetUrl,
          },
          include: profileInclude,
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2002"
        ) {
          throw error;
        }
        profile = await this.prisma.userBrowserProfile.findUnique({
          include: profileInclude,
          where: uniqueWhere,
        });
      }
    }
    if (!profile) {
      throw new ConflictException("The browser profile could not be created.");
    }

    const activeSources = new Set(
      profile.grants
        .filter((grant) => !grant.revokedAt)
        .map((grant) => grant.triggerSource),
    );
    const rules = verificationRuleRecord(profile.verificationRules);
    const pending = pendingTriggerSources(profile.verificationRules);
    const needsApproval =
      !activeSources.has(input.triggerSource) &&
      !pending.includes(input.triggerSource);
    const expiredReady =
      profile.status === "READY" &&
      (!profile.inactivityExpiresAt ||
        profile.inactivityExpiresAt <= new Date());
    if (needsApproval || expiredReady) {
      profile = await this.prisma.userBrowserProfile.update({
        data: {
          ...(needsApproval
            ? {
                verificationRules: json({
                  ...rules,
                  requestedTriggerSources: [...pending, input.triggerSource],
                }),
              }
            : {}),
          ...(expiredReady ? { status: "REAUTH_REQUIRED" as const } : {}),
          version: { increment: 1 },
        },
        include: profileInclude,
        where: { id: profile.id },
      });
    }
    return this.serialize(profile);
  }

  async update(
    current: AuthContext,
    id: string,
    input: UserBrowserProfileUpdateInput,
  ) {
    const profile = await this.owned(current, id);
    if (input.verificationUrl || input.grants) {
      const [activeRuns, activeSessions, resolvedBindings] = await Promise.all([
        this.prisma.executionRun.count({
          where: {
            browserProfileId: id,
            lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
          },
        }),
        this.prisma.browserRuntimeSession.count({
          where: {
            status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"] },
            userBrowserProfileId: id,
          },
        }),
        this.prisma.taskProfileBinding.count({
          where: {
            resolvedProfileId: id,
            status: "RESOLVED",
            taskExecution: {
              lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
            },
          },
        }),
      ]);
      if (activeRuns || activeSessions || resolvedBindings) {
        throw new ConflictException(
          "Profile target and trigger grants cannot change while a non-terminal task is bound to it.",
        );
      }
    }
    const verificationUrl = input.verificationUrl ?? profile.verificationUrl;
    const hostname = verificationUrl
      ? normalizedHostname(verificationUrl)
      : null;
    const grants =
      input.grants ??
      (input.verificationUrl
        ? [
            ...new Set(
              profile.grants
                .filter((grant) => !grant.revokedAt)
                .map((grant) => grant.triggerSource),
            ),
          ]
        : undefined);
    if (grants && !hostname) {
      throw new ConflictException(
        "Profile verificationUrl is required before trigger grants can be configured.",
      );
    }
    let updated: ProfileRow;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        await tx.userBrowserProfile.update({
          data: {
            ...(input.displayName ? { displayName: input.displayName } : {}),
            ...(input.verificationRules
              ? { verificationRules: json(input.verificationRules) }
              : {}),
            ...(input.verificationUrl
              ? { verificationUrl: input.verificationUrl }
              : {}),
            ...(hostname
              ? {
                  scopeKey: profileScopeKey({
                    authRole: profile.authRole,
                    environmentKey: profile.environmentKey,
                    hostname,
                  }),
                }
              : {}),
            version: { increment: 1 },
          },
          where: { id },
        });
        if (grants) {
          await tx.browserProfileGrant.updateMany({
            data: { revokedAt: new Date() },
            where: { profileId: id, revokedAt: null },
          });
          for (const triggerSource of grants) {
            await tx.browserProfileGrant.upsert({
              create: {
                consentedByUserId: current.user.id,
                hostnamePattern: hostname!,
                profileId: id,
                teamId: current.team.id,
                triggerSource,
              },
              update: {
                consentedAt: new Date(),
                consentedByUserId: current.user.id,
                revokedAt: null,
              },
              where: {
                profileId_triggerSource_hostnamePattern: {
                  hostnamePattern: hostname!,
                  profileId: id,
                  triggerSource,
                },
              },
            });
          }
        }
        return tx.userBrowserProfile.findUniqueOrThrow({
          include: profileInclude,
          where: { id },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "A browser profile already exists for this environment, role, and hostname scope.",
        );
      }
      throw error;
    }
    await this.audit.record(
      current,
      "browser_profile.updated",
      "user_browser_profile",
      id,
    );
    return this.serialize(updated);
  }

  async prepare(
    current: AuthContext,
    id: string,
    input: UserBrowserProfilePrepareInput,
  ) {
    const profile = await this.owned(current, id);
    if (profile.status === "DISABLED") {
      throw new ConflictException("This browser profile cannot be prepared.");
    }
    const existing = profile.runtimeSessions[0];
    if (
      existing &&
      ["OPENING", "ACTIVE", "HUMAN_CONTROL"].includes(existing.status)
    ) {
      if (existing.status === "ACTIVE") {
        await this.sessions.takeover(current, existing.id, {
          ttlSeconds: input.ttlSeconds,
        });
      }
      return {
        profile: this.serialize(await this.owned(current, id)),
        sessionId: existing.id,
      };
    }
    if (!profile.verificationUrl) {
      throw new ConflictException("Profile verificationUrl is not configured.");
    }
    const hostname = new URL(profile.verificationUrl).hostname;
    const runtimeId = await this.selectRuntime(
      current.team.id,
      hostname,
      input.runtimeId ?? profile.assignedRuntimeId ?? undefined,
    );
    const previousStatus = profile.status;
    const claimedVersion = profile.version + 1;
    const claimed = await this.prisma.userBrowserProfile.updateMany({
      data: {
        assignedRuntimeId: runtimeId,
        status: "PREPARING",
        verificationError: Prisma.JsonNull,
        version: { increment: 1 },
      },
      where: { id, status: previousStatus, version: profile.version },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        "Browser profile preparation was started by another request.",
      );
    }
    try {
      const session = await this.sessions.create(current, {
        profileMode: "PERSISTENT",
        purpose: "PROFILE_PREPARATION",
        runtimeId,
        userBrowserProfileId: id,
      });
      if (session.status !== "ACTIVE") {
        throw new ConflictException(
          "Browser Runtime could not open the profile.",
        );
      }
      await this.sessions.execute(current, session.id, {
        commandType: "page.navigate",
        payload: {
          url: profile.verificationUrl,
          waitUntil: "domcontentloaded",
        },
      });
      await this.sessions.takeover(current, session.id, {
        ttlSeconds: input.ttlSeconds,
      });
      await this.prisma.userBrowserProfile.update({
        data: {
          inactivityExpiresAt: new Date(Date.now() + PROFILE_TTL_MS),
          lastPreparedAt: new Date(),
        },
        where: { id },
      });
      await this.audit.record(
        current,
        "browser_profile.preparation_started",
        "user_browser_profile",
        id,
        { runtimeId, sessionId: session.id },
      );
      return {
        profile: this.serialize(await this.owned(current, id)),
        sessionId: session.id,
      };
    } catch (error) {
      await this.prisma.userBrowserProfile.updateMany({
        data: {
          status:
            previousStatus === "REAUTH_REQUIRED"
              ? "REAUTH_REQUIRED"
              : "UNINITIALIZED",
          verificationError: json({
            code: "PROFILE_PREPARATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          }),
          version: { increment: 1 },
        },
        where: { id, status: "PREPARING", version: claimedVersion },
      });
      throw error;
    }
  }

  async verify(current: AuthContext, id: string) {
    const profile = await this.owned(current, id);
    const session = profile.runtimeSessions.find((candidate) =>
      ["ACTIVE", "HUMAN_CONTROL"].includes(candidate.status),
    );
    if (!session) {
      throw new ConflictException("Profile preparation session is not active.");
    }
    const rules = verificationRules(profile.verificationRules);
    try {
      if (rules.automatic && profile.verificationUrl) {
        await this.sessions.execute(current, session.id, {
          commandType: "page.navigate",
          payload: {
            url: profile.verificationUrl,
            waitUntil: "domcontentloaded",
          },
        });
      }
      const urlCommand = await this.sessions.execute(current, session.id, {
        commandType: "page.get_url",
        payload: {},
      });
      const currentUrl = commandString(urlCommand?.result, "url");
      if (!currentUrl) {
        throw new ConflictException(
          "Browser Runtime did not return the page URL.",
        );
      }
      if (
        rules.loginUrlPatterns.some((pattern) =>
          urlMatches(currentUrl, pattern),
        )
      ) {
        throw new ConflictException("The browser is still on a login page.");
      }
      const authenticatedUrlMatches =
        rules.automatic && profile.verificationUrl
          ? sameVerificationLocation(currentUrl, profile.verificationUrl)
          : !rules.successUrlPatterns.length ||
            rules.successUrlPatterns.some((pattern) =>
              urlMatches(currentUrl, pattern),
            );
      if (!authenticatedUrlMatches) {
        throw new ConflictException(
          "The browser URL does not prove authentication.",
        );
      }
      if (rules.authenticatedSelector) {
        const countCommand = await this.sessions.execute(current, session.id, {
          commandType: "locator.count",
          payload: { target: { selector: rules.authenticatedSelector } },
        });
        if (commandNumber(countCommand?.result, "count") < 1) {
          throw new ConflictException(
            "The authenticated verification element was not found.",
          );
        }
      }
      if (session.status === "HUMAN_CONTROL") {
        await this.sessions.release(current, session.id);
      }
      await this.sessions.close(current, session.id);
      const now = new Date();
      const approvedSources = pendingTriggerSources(profile.verificationRules);
      await this.prisma.$transaction(async (tx) => {
        await this.activatePendingGrants(tx, profile, approvedSources, now);
        await tx.userBrowserProfile.update({
          data: {
            inactivityExpiresAt: new Date(now.getTime() + PROFILE_TTL_MS),
            lastUsedAt: now,
            lastVerifiedAt: now,
            status: "READY",
            verificationError: Prisma.JsonNull,
          },
          where: { id },
        });
      });
      await this.audit.record(
        current,
        "browser_profile.verified",
        "user_browser_profile",
        id,
        { approvedSources },
      );
      return this.serialize(await this.owned(current, id));
    } catch (error) {
      await this.prisma.userBrowserProfile.update({
        data: {
          status: "REAUTH_REQUIRED",
          verificationError: json({
            code: "PROFILE_VERIFICATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          }),
        },
        where: { id },
      });
      throw error;
    }
  }

  async approve(current: AuthContext, id: string) {
    const profile = await this.owned(current, id);
    if (profile.status !== "READY") {
      throw new ConflictException(
        "Complete profile login before approving task access.",
      );
    }
    const approvedSources = pendingTriggerSources(profile.verificationRules);
    if (!approvedSources.length) return this.serialize(profile);
    const now = new Date();
    await this.prisma.$transaction((tx) =>
      this.activatePendingGrants(tx, profile, approvedSources, now),
    );
    await this.audit.record(
      current,
      "browser_profile.grants_approved",
      "user_browser_profile",
      id,
      { approvedSources },
    );
    return this.serialize(await this.owned(current, id));
  }

  async reauth(
    current: AuthContext,
    id: string,
    input: UserBrowserProfilePrepareInput,
  ) {
    const profile = await this.owned(current, id);
    if (!["READY", "REAUTH_REQUIRED", "LOST"].includes(profile.status)) {
      throw new ConflictException(
        "This browser profile cannot be reauthenticated.",
      );
    }
    await this.prisma.userBrowserProfile.update({
      data: { status: "REAUTH_REQUIRED" },
      where: { id },
    });
    return this.prepare(current, id, input);
  }

  async stream(
    current: AuthContext,
    id: string,
    emit: (event: HumanPreviewEvent) => void,
  ) {
    return this.humanRelay.subscribe(
      await this.controlledSession(current, id),
      emit,
    );
  }

  async input(
    current: AuthContext,
    id: string,
    events: BrowserHumanInputEvent[],
  ) {
    await this.humanRelay.dispatch(
      await this.controlledSession(current, id),
      events,
    );
    return { accepted: true };
  }

  async disable(current: AuthContext, id: string) {
    const profile = await this.owned(current, id);
    if (profile.status === "DISABLED") return this.serialize(profile);
    const claimed = await this.prisma.userBrowserProfile.updateMany({
      data: { status: "DISABLED", version: { increment: 1 } },
      where: { id, status: profile.status, version: profile.version },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("The profile state changed concurrently.");
    }
    const activeRuns = await this.prisma.executionRun.count({
      where: {
        browserProfileId: id,
        lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
      },
    });
    if (activeRuns) {
      await this.restoreLifecycleClaim(profile, "DISABLED");
      throw new ConflictException(
        "The profile cannot be disabled while a task Run is active.",
      );
    }
    await this.closeActiveSessions(current, id);
    const updated = await this.owned(current, id);
    await this.audit.record(
      current,
      "browser_profile.disabled",
      "user_browser_profile",
      id,
    );
    await this.detachProfileFromTasks(
      id,
      "PROFILE_OWNER_DISABLED",
      "The profile owner disabled this browser profile.",
    );
    return this.serialize(updated);
  }

  async remove(current: AuthContext, id: string) {
    const profile = await this.owned(current, id);
    const claimedVersion = profile.version + 1;
    const claimed = await this.prisma.userBrowserProfile.updateMany({
      data: {
        status: "DISABLED",
        version: { increment: 1 },
      },
      where: { id, status: profile.status, version: profile.version },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("The profile state changed concurrently.");
    }
    const activeRuns = await this.prisma.executionRun.count({
      where: {
        browserProfileId: id,
        lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
      },
    });
    if (activeRuns) {
      await this.restoreLifecycleClaim(profile, "DISABLED", claimedVersion);
      throw new ConflictException(
        "The profile cannot be deleted while a task Run is active.",
      );
    }
    try {
      await this.closeActiveSessions(current, id);
    } catch (error) {
      await this.restoreLifecycleClaim(profile, "DISABLED", claimedVersion);
      throw error;
    }
    const lateActiveRuns = await this.prisma.executionRun.count({
      where: {
        browserProfileId: id,
        lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
      },
    });
    if (lateActiveRuns) {
      await this.restoreLifecycleClaim(profile, "DISABLED", claimedVersion);
      throw new ConflictException(
        "The profile became active while deletion was being claimed.",
      );
    }
    try {
      await this.browser.purgeProfile(
        current.team.id,
        profile.runtimeProfileKey,
        profile.id,
      );
    } catch (error) {
      await this.restoreLifecycleClaim(profile, "DISABLED", claimedVersion);
      throw error;
    }
    await this.detachProfileFromTasks(
      id,
      "PROFILE_OWNER_DELETED",
      "The profile owner deleted this browser profile.",
      true,
    );
    await this.audit.record(
      current,
      "browser_profile.deleted",
      "user_browser_profile",
      id,
    );
    return { deleted: true, id };
  }

  async resolveProfile(input: {
    ownerUserId: string;
    policy: TaskProfilePolicy;
    targetHostname: string;
    teamId: string;
    triggerSource: "CONSOLE" | "FEISHU" | "ISSUE_ASSIGNEE";
  }) {
    if (input.policy.strategy === "EPHEMERAL") return null;
    const profiles = await this.prisma.userBrowserProfile.findMany({
      include: { grants: { where: { revokedAt: null } } },
      where: {
        authRole: input.policy.scope.authRole,
        environmentKey: input.policy.scope.environmentKey,
        ownerUserId: input.ownerUserId,
        owner: {
          memberships: { some: { teamId: input.teamId } },
          status: "ACTIVE",
        },
        inactivityExpiresAt: { gt: new Date() },
        status: "READY",
        teamId: input.teamId,
        ...(input.policy.profileId ? { id: input.policy.profileId } : {}),
      },
    });
    return (
      profiles.find((profile) =>
        profile.grants.some(
          (grant) =>
            grant.triggerSource === input.triggerSource &&
            hostnameMatchesPattern(input.targetHostname, grant.hostnamePattern),
        ),
      ) ?? null
    );
  }

  private async closeActiveSessions(current: AuthContext, profileId: string) {
    const sessions = await this.prisma.browserRuntimeSession.findMany({
      select: { id: true, humanControllerUserId: true, status: true },
      where: {
        status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"] },
        teamId: current.team.id,
        userBrowserProfileId: profileId,
      },
    });
    for (const session of sessions) {
      if (
        session.status === "HUMAN_CONTROL" &&
        session.humanControllerUserId === current.user.id
      ) {
        await this.sessions.release(current, session.id).catch(() => undefined);
      }
      await this.sessions.close(current, session.id);
    }
  }

  private restoreLifecycleClaim(
    profile: ProfileRow,
    claimedStatus: "DISABLED",
    claimedVersion = profile.version + 1,
  ) {
    return this.prisma.userBrowserProfile.updateMany({
      data: {
        status: profile.status,
        verificationError:
          profile.verificationError === null
            ? Prisma.JsonNull
            : json(profile.verificationError),
        version: { increment: 1 },
      },
      where: {
        id: profile.id,
        status: claimedStatus,
        version: claimedVersion,
      },
    });
  }

  private async detachProfileFromTasks(
    profileId: string,
    reason: string,
    message: string,
    deleteProfile = false,
  ) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const bindings = await tx.taskProfileBinding.findMany({
        select: { taskExecutionId: true },
        where: { resolvedProfileId: profileId, status: "RESOLVED" },
      });
      const taskIds = bindings.map((binding) => binding.taskExecutionId);
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
        },
      });
      await tx.taskProfileBinding.updateMany({
        data: {
          failureCode: reason,
          failureMessage: message,
          resolvedAt: null,
          resolvedProfileId: null,
          status: "WAITING_INPUT",
          version: { increment: 1 },
        },
        where: { resolvedProfileId: profileId, status: "RESOLVED" },
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
      }
      if (deleteProfile) {
        await tx.userBrowserProfile.delete({ where: { id: profileId } });
      }
    });
  }

  private async controlledSession(current: AuthContext, profileId: string) {
    await this.owned(current, profileId);
    const session = await this.prisma.browserRuntimeSession.findFirst({
      where: {
        humanControlExpiresAt: { gt: new Date() },
        humanControllerUserId: current.user.id,
        status: "HUMAN_CONTROL",
        teamId: current.team.id,
        userBrowserProfileId: profileId,
      },
    });
    if (!session?.leaseToken) {
      throw new ConflictException(
        "The profile preparation control lease is unavailable.",
      );
    }
    return {
      fencingToken: session.fencingToken,
      id: session.id,
      leaseToken: session.leaseToken,
      runtimeId: session.runtimeId,
    };
  }

  private owned(current: AuthContext, id: string) {
    return this.prisma.userBrowserProfile
      .findFirst({
        include: profileInclude,
        where: {
          id,
          ownerUserId: current.user.id,
          teamId: current.team.id,
        },
      })
      .then((profile) => {
        if (!profile)
          throw new NotFoundException("Browser profile was not found.");
        return profile;
      });
  }

  private serialize(profile: ProfileRow) {
    const { runtimeProfileKey: _runtimeProfileKey, ...safe } = profile;
    const rules = verificationRules(profile.verificationRules);
    return {
      ...safe,
      configurationSource: rules.automatic ? "TASK" : "MANUAL",
      grants: profile.grants.filter((grant) => !grant.revokedAt),
      inactivityDays: 30,
      activeSession: profile.runtimeSessions[0] ?? null,
      pendingTriggerSources: rules.pendingTriggerSources,
      siteHostname: profile.verificationUrl
        ? normalizedHostname(profile.verificationUrl)
        : null,
    };
  }

  private async activatePendingGrants(
    tx: Prisma.TransactionClient,
    profile: ProfileRow,
    sources: ProfileTriggerSource[],
    consentedAt: Date,
  ) {
    const rules = verificationRules(profile.verificationRules);
    if (!profile.verificationUrl) {
      throw new ConflictException(
        "Profile verificationUrl is required before grants can be approved.",
      );
    }
    const grantHostname = normalizedHostname(profile.verificationUrl);
    for (const triggerSource of sources) {
      await tx.browserProfileGrant.upsert({
        create: {
          consentedAt,
          consentedByUserId: profile.ownerUserId,
          hostnamePattern: grantHostname,
          profileId: profile.id,
          teamId: profile.teamId,
          triggerSource,
        },
        update: {
          consentedAt,
          consentedByUserId: profile.ownerUserId,
          revokedAt: null,
        },
        where: {
          profileId_triggerSource_hostnamePattern: {
            hostnamePattern: grantHostname,
            profileId: profile.id,
            triggerSource,
          },
        },
      });
    }
    const rulesRecord = verificationRuleRecord(profile.verificationRules);
    const { requestedTriggerSources: _requested, ...approvedRules } =
      rulesRecord;
    await tx.userBrowserProfile.update({
      data: {
        verificationRules: json(approvedRules),
        version: { increment: 1 },
      },
      where: { id: profile.id },
    });
  }

  private async selectRuntime(
    teamId: string,
    hostname: string,
    preferredRuntimeId?: string,
  ) {
    const [runtimes, rules] = await Promise.all([
      this.prisma.browserRuntime.findMany({
        where: {
          enabled: true,
          protocolMajor: 1,
          protocolMinor: { gte: 9 },
          revokedAt: null,
          teamId,
        },
      }),
      this.prisma.runtimeRoutingRule.findMany({
        where: { enabled: true, teamId },
      }),
    ]);
    const plan = resolveRuntimeRoutingPlan({
      allRuntimeIds: runtimes.map((runtime) => runtime.id),
      hostname,
      rules,
    });
    const candidates = preferredRuntimeId
      ? plan.candidateIds.filter((id) => id === preferredRuntimeId)
      : plan.candidateIds;
    for (const id of candidates) {
      const runtime = runtimes.find((candidate) => candidate.id === id);
      if (runtime && (await this.redis.isRuntimeOnline(runtime.id))) {
        return runtime.id;
      }
    }
    throw new ConflictException(
      preferredRuntimeId
        ? "Selected Browser Runtime is offline or incompatible with the profile hostname."
        : "No online Browser Runtime can host this user profile.",
    );
  }

  private async requireRuntime(
    teamId: string,
    runtimeId: string,
    hostname: string,
  ) {
    await this.selectRuntime(teamId, hostname, runtimeId);
  }
}

function profileScopeKey(input: {
  authRole: string;
  environmentKey: string;
  hostname: string;
}) {
  return `v1-${createHash("sha256")
    .update(
      JSON.stringify({
        authRole: input.authRole,
        environmentKey: input.environmentKey,
        hostnames: [input.hostname],
      }),
    )
    .digest("hex")}`;
}

function normalizedHostname(value: string | URL) {
  const hostname =
    typeof value === "string" ? new URL(value).hostname : value.hostname;
  return hostname.toLowerCase().replace(/\.$/u, "");
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function automaticProfileName(
  hostname: string,
  environmentKey: string,
  authRole: string,
) {
  const scope = [environmentKey, authRole].filter(
    (value) => value !== "default",
  );
  return scope.length ? `${hostname} · ${scope.join(" / ")}` : hostname;
}

function automaticVerificationRules(
  verificationUrl: string,
  requestedTriggerSources: ProfileTriggerSource[],
) {
  const target = new URL(verificationUrl);
  target.hash = "";
  target.search = "";
  return {
    loginUrlPatterns: ["*/login*", "*/signin*"],
    provisionedBy: "TASK_TARGET",
    requestedTriggerSources,
    successUrlPatterns: [`${target.toString()}*`],
  };
}

function verificationRuleRecord(value: Prisma.JsonValue) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function verificationRules(value: Prisma.JsonValue) {
  const record = verificationRuleRecord(value);
  return {
    automatic: record.provisionedBy === "TASK_TARGET",
    authenticatedSelector:
      typeof record.authenticatedSelector === "string"
        ? record.authenticatedSelector
        : null,
    loginUrlPatterns: stringArray(record.loginUrlPatterns),
    pendingTriggerSources: pendingTriggerSources(value),
    successUrlPatterns: stringArray(record.successUrlPatterns),
  };
}

function pendingTriggerSources(value: Prisma.JsonValue) {
  const record = verificationRuleRecord(value);
  return stringArray(record.requestedTriggerSources).filter(
    (source): source is ProfileTriggerSource =>
      source === "CONSOLE" ||
      source === "FEISHU" ||
      source === "ISSUE_ASSIGNEE",
  );
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function urlMatches(url: string, pattern: string) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u").test(url);
}

function sameVerificationLocation(currentUrl: string, verificationUrl: string) {
  const current = new URL(currentUrl);
  const expected = new URL(verificationUrl);
  return (
    current.origin === expected.origin &&
    normalizedPathname(current.pathname) ===
      normalizedPathname(expected.pathname)
  );
}

function normalizedPathname(value: string) {
  return value.length > 1 ? value.replace(/\/+$/u, "") : value;
}

function commandString(
  value: Prisma.JsonValue | null | undefined,
  key: string,
) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value[key] === "string"
    ? value[key]
    : null;
}

function commandNumber(
  value: Prisma.JsonValue | null | undefined,
  key: string,
) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value[key] === "number"
    ? value[key]
    : 0;
}
