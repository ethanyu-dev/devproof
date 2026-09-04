import { randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  HumanControlInput,
  RuntimeCommandInput,
  RuntimeSessionCreateInput,
} from "@devproof/contracts";
import {
  RUNTIME_PROTOCOL,
  runtimeCommandMinimumMinor,
} from "@devproof/runtime-protocol";

import type { AuthContext } from "../auth/auth.types.js";
import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import {
  quarantineSession,
  releaseVerifiedSessionResources,
} from "./session-resource-cleanup.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import { RedisService } from "../infrastructure/redis.service.js";
import { AuditService } from "../console/audit.service.js";
import { RuntimeCommandDispatcher } from "./runtime-command-dispatcher.service.js";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function safeProfileJson(
  value: Prisma.JsonValue | null | undefined,
  userBrowserProfileId: string | null | undefined,
): Prisma.JsonValue | null | undefined {
  if (!userBrowserProfileId || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(
      (item) => safeProfileJson(item, userBrowserProfileId) ?? null,
    );
  }
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["profileKey", "runtimeProfileKey"].includes(key))
      .map(([key, item]) => [key, safeProfileJson(item, userBrowserProfileId)]),
  );
}

@Injectable()
export class RuntimeSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly commands: RuntimeCommandDispatcher,
    private readonly storage: ObjectStorageService,
    private readonly audit: AuditService,
  ) {}

  async list(current: AuthContext) {
    const rows = await this.prisma.browserRuntimeSession.findMany({
      include: {
        _count: { select: { artifacts: true, commands: true, events: true } },
        runtime: { select: { id: true, name: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      where: { teamId: current.team.id },
    });
    return rows.map((row) => this.serializeSession(row));
  }

  async detail(current: AuthContext, sessionId: string) {
    const row = await this.prisma.browserRuntimeSession.findFirst({
      include: {
        artifacts: { orderBy: { createdAt: "desc" } },
        commands: { orderBy: { createdAt: "desc" }, take: 100 },
        events: { orderBy: { occurredAt: "desc" }, take: 100 },
        runtime: { select: { id: true, name: true, status: true } },
      },
      where: { id: sessionId, teamId: current.team.id },
    });
    if (!row) {
      throw new NotFoundException("Runtime session was not found.");
    }
    return {
      ...this.serializeSession(row),
      artifacts: await Promise.all(
        row.artifacts.map(async (artifact) => ({
          ...artifact,
          downloadUrl: await this.storage.signedDownloadUrl(
            artifact.storageKey,
          ),
          metadata: safeProfileJson(
            artifact.metadata,
            row.userBrowserProfileId,
          ),
        })),
      ),
      commands: row.commands.map((command) => ({
        ...command,
        error: safeProfileJson(command.error, row.userBrowserProfileId),
        fencingToken: command.fencingToken.toString(),
        ownerFencingToken: command.ownerFencingToken?.toString() ?? null,
        payload: safeProfileJson(command.payload, row.userBrowserProfileId),
        result: safeProfileJson(command.result, row.userBrowserProfileId),
      })),
      events: row.events.map((event) => ({
        ...event,
        fencingToken: event.fencingToken.toString(),
        payload: safeProfileJson(event.payload, row.userBrowserProfileId),
      })),
    };
  }

  async create(current: AuthContext, input: RuntimeSessionCreateInput) {
    const runtime = await this.prisma.browserRuntime.findFirst({
      where: {
        enabled: true,
        id: input.runtimeId,
        revokedAt: null,
        teamId: current.team.id,
      },
    });
    if (!runtime) {
      throw new NotFoundException("Browser Runtime was not found.");
    }
    const userProfile = input.userBrowserProfileId
      ? await this.prisma.userBrowserProfile.findFirst({
          where: {
            id: input.userBrowserProfileId,
            ownerUserId: current.user.id,
            status: {
              in: ["UNINITIALIZED", "PREPARING", "READY", "REAUTH_REQUIRED"],
            },
            teamId: current.team.id,
          },
        })
      : null;
    if (input.userBrowserProfileId && !userProfile) {
      throw new NotFoundException("User browser profile was not found.");
    }
    if (
      userProfile?.status === "READY" &&
      (!userProfile.inactivityExpiresAt ||
        userProfile.inactivityExpiresAt.getTime() <= Date.now())
    ) {
      throw new ConflictException(
        "The user Browser Profile expired and must be prepared again.",
      );
    }
    if (
      !input.userBrowserProfileId &&
      input.profileMode === "PERSISTENT" &&
      input.profileKey &&
      (await this.prisma.userBrowserProfile.findUnique({
        select: { id: true },
        where: {
          teamId_runtimeProfileKey: {
            runtimeProfileKey: input.profileKey,
            teamId: current.team.id,
          },
        },
      }))
    ) {
      throw new ConflictException(
        "A user Browser Profile must be opened through its logical profile id.",
      );
    }
    if (
      userProfile &&
      userProfile.assignedRuntimeId &&
      userProfile.assignedRuntimeId !== runtime.id
    ) {
      throw new ConflictException(
        "User browser profile is assigned to another Browser Runtime.",
      );
    }
    if (userProfile && (runtime.protocolMinor ?? 0) < 9) {
      throw new ConflictException(
        "User browser profiles require Browser Runtime protocol v1.9.",
      );
    }
    const profileKey =
      userProfile?.runtimeProfileKey ??
      input.profileKey ??
      "ephemeral-" + randomUUID().replaceAll("-", "");
    if (input.profileMode === "PERSISTENT" && profileKey) {
      const affinity = await this.prisma.browserRuntimeSession.findFirst({
        orderBy: { createdAt: "desc" },
        select: { runtimeId: true },
        where: {
          profileKey,
          profileMode: "PERSISTENT",
          teamId: current.team.id,
        },
      });
      if (affinity && affinity.runtimeId !== runtime.id) {
        throw new ConflictException(
          "Persistent profile is bound to another Browser Runtime.",
        );
      }
    }
    if (!(await this.redis.isRuntimeOnline(runtime.id))) {
      throw new ConflictException("Browser Runtime is offline.");
    }

    await this.expireSlots(runtime.id);
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      Date.now() + env().RUNTIME_LEASE_SECONDS * 1000,
    );
    let sessionId: string | undefined;

    for (
      let slotNumber = 0;
      slotNumber < runtime.maxConcurrency;
      slotNumber += 1
    ) {
      try {
        const session = await this.prisma.$transaction(
          async (tx) => {
            await acquireAdvisoryTransactionLock(
              tx,
              "browser-execution-resources",
            );
            if (userProfile) {
              await acquireAdvisoryTransactionLock(
                tx,
                `browser-profile:${userProfile.id}`,
              );
              const busy = await tx.browserRuntimeSession.count({
                where: {
                  userBrowserProfileId: userProfile.id,
                  closureVerifiedAt: null,
                  status: { not: "CLOSED" },
                },
              });
              if (busy)
                throw new ConflictException(
                  "The login identity is in use; wait for its sessions to close before maintenance.",
                );
            }
            await acquireAdvisoryTransactionLock(
              tx,
              `browser-runtime:${runtime.id}`,
            );
            const configured = await tx.browserRuntime.findUniqueOrThrow({
              where: { id: runtime.id },
              select: { maxConcurrency: true, enabled: true, revokedAt: true },
            });
            if (!configured.enabled || configured.revokedAt)
              throw new ConflictException(
                "Browser Runtime was disabled before admission.",
              );
            const occupied = await tx.browserRuntimeSlot.count({
              where: { runtimeId: runtime.id },
            });
            if (
              occupied >= configured.maxConcurrency ||
              slotNumber >= configured.maxConcurrency
            )
              throw new ConflictException(
                "Browser Runtime has no available slot.",
              );
            if (
              input.purpose === "EXECUTION" &&
              ((await tx.executionResourceLease.count()) ||
                (await tx.browserRuntimeSession.count({
                  where: {
                    purpose: "EXECUTION",
                    closureVerifiedAt: null,
                    status: { not: "CLOSED" },
                    resourceLeases: { none: {} },
                  },
                })))
            )
              throw new ConflictException(
                "A manual execution requires exclusive business access while other executions are running.",
              );
            const counter = await tx.browserRuntimeFenceCounter.upsert({
              create: { runtimeId: runtime.id, value: 1n },
              update: { value: { increment: 1n } },
              where: { runtimeId: runtime.id },
            });
            const created = await tx.browserRuntimeSession.create({
              data: {
                fencingToken: counter.value,
                leaseExpiresAt,
                leaseToken,
                profileKey,
                profileMode: input.profileMode,
                purpose: input.purpose,
                protocolMajor: RUNTIME_PROTOCOL.major,
                protocolMinor: runtime.protocolMinor ?? RUNTIME_PROTOCOL.minor,
                runtimeId: runtime.id,
                slotNumber,
                teamId: current.team.id,
                ...(userProfile
                  ? { userBrowserProfileId: userProfile.id }
                  : {}),
              },
            });
            await tx.browserRuntimeSlot.create({
              data: {
                expiresAt: leaseExpiresAt,
                fencingToken: counter.value,
                leaseToken,
                runtimeId: runtime.id,
                sessionId: created.id,
                slotNumber,
              },
            });
            if (input.profileMode === "PERSISTENT") {
              await tx.browserRuntimeProfileLease.create({
                data: {
                  expiresAt: leaseExpiresAt,
                  fencingToken: counter.value,
                  leaseToken,
                  profileKey,
                  runtimeId: runtime.id,
                  sessionId: created.id,
                  teamId: current.team.id,
                },
              });
            }
            if (input.purpose === "EXECUTION")
              await tx.executionResourceLease.create({
                data: {
                  sessionId: created.id,
                  rootKey: "*",
                  resourceKey: "",
                  mode: "WRITE",
                },
              });
            return created;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        sessionId = session.id;
        break;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2002" || error.code === "P2034")
        ) {
          if (
            input.profileMode === "PERSISTENT" &&
            (await this.prisma.browserRuntimeProfileLease.findUnique({
              where: {
                teamId_profileKey: { profileKey, teamId: current.team.id },
              },
            }))
          ) {
            throw new ConflictException(
              "Persistent profile is already used by another session.",
            );
          }
          continue;
        }
        throw error;
      }
    }
    if (!sessionId) {
      throw new ConflictException("Browser Runtime has no available slot.");
    }

    const opened = await this.commands.execute({
      commandType: "session.open",
      payload: {
        allowedOrigins: [],
        profileKey,
        profileMode: input.profileMode,
        ...(userProfile
          ? {
              profileRetention: {
                inactivityTtlSeconds: 2_592_000,
                kind: "USER",
              },
            }
          : {}),
      },
      sessionId,
      source: "SYSTEM",
    });
    if (opened?.status === "SUCCEEDED") {
      await this.prisma.$transaction([
        this.prisma.browserRuntimeSession.update({
          data: { openedAt: new Date(), status: "ACTIVE" },
          where: { id: sessionId },
        }),
        ...(userProfile
          ? [
              this.prisma.userBrowserProfile.update({
                data: {
                  assignedRuntimeId: runtime.id,
                  inactivityExpiresAt: new Date(
                    Date.now() + 30 * 24 * 60 * 60 * 1_000,
                  ),
                  lastUsedAt: new Date(),
                },
                where: { id: userProfile.id },
              }),
            ]
          : []),
      ]);
    } else {
      await this.prisma.$transaction((tx) =>
        quarantineSession(tx, sessionId!, "OPEN_UNCONFIRMED"),
      );
      await this.close(current, sessionId, { timeoutSeconds: 15 }).catch(
        () => undefined,
      );
    }
    await this.audit.record(
      current,
      "runtime.session.created",
      "browser_runtime_session",
      sessionId,
      { profileMode: input.profileMode, runtimeId: runtime.id },
    );
    return this.detail(current, sessionId);
  }

  async execute(
    current: AuthContext,
    sessionId: string,
    input: RuntimeCommandInput,
  ) {
    const session = await this.ownedSession(current, sessionId);
    if (!["ACTIVE", "HUMAN_CONTROL"].includes(session.status)) {
      throw new ConflictException("Runtime session is not active.");
    }
    if (
      session.status === "HUMAN_CONTROL" &&
      session.humanControllerUserId !== current.user.id
    ) {
      throw new ForbiddenException(
        "Runtime session is controlled by another user.",
      );
    }
    const requiredMinor = runtimeCommandMinimumMinor(input.commandType);
    if (session.protocolMinor < requiredMinor) {
      throw new ConflictException({
        code: "PROTOCOL_UNSUPPORTED",
        message: `Browser command ${input.commandType} requires Runtime protocol v1.${requiredMinor}.`,
        retryable: false,
      });
    }
    const command = await this.commands.execute({
      commandType: input.commandType,
      payload: input.payload,
      sessionId,
      source: session.status === "HUMAN_CONTROL" ? "HUMAN" : "CONSOLE",
      ...(input.timeoutSeconds !== undefined
        ? { timeoutSeconds: input.timeoutSeconds }
        : {}),
    });
    return command
      ? {
          ...command,
          error: safeProfileJson(command.error, session.userBrowserProfileId),
          fencingToken: command.fencingToken.toString(),
          ownerFencingToken: command.ownerFencingToken?.toString() ?? null,
          payload: safeProfileJson(
            command.payload,
            session.userBrowserProfileId,
          ),
          result: safeProfileJson(command.result, session.userBrowserProfileId),
        }
      : null;
  }

  async publishProfileSnapshot(
    current: AuthContext,
    sessionId: string,
    generation: number,
    verification: {
      url: string;
      authenticatedSelector?: string;
      successUrlPatterns?: string[];
      loginUrlPatterns?: string[];
    },
  ) {
    const session = await this.ownedSession(current, sessionId);
    if (
      session.profileMode !== "PERSISTENT" ||
      !session.userBrowserProfileId ||
      session.protocolMinor < 13 ||
      !["ACTIVE", "HUMAN_CONTROL"].includes(session.status)
    )
      throw new ConflictException(
        "Authentication snapshots require an active Profile preparation session on Runtime protocol v1.13.",
      );
    const command = await this.commands.execute({
      commandType: "profile.snapshot",
      sessionId,
      source: "SYSTEM",
      payload: {
        profileKey: session.profileKey,
        generation,
        verification,
        probeConcurrency: 4,
      },
      timeoutSeconds: 90,
    });
    if (command?.status !== "SUCCEEDED")
      throw new ConflictException({
        code: "AUTH_SNAPSHOT_INCOMPATIBLE",
        message:
          "Independent browser contexts could not reuse this login. Keep serial execution or prepare an account with compatible authentication.",
      });
    return command.result;
  }

  listQuarantines(current: AuthContext) {
    return this.prisma.browserRuntimeSession.findMany({
      where: {
        teamId: current.team.id,
        resourceLeases: { some: { quarantined: true } },
      },
      select: {
        id: true,
        closureVerifiedAt: true,
        quarantinedAt: true,
        createdAt: true,
        status: true,
        browserExecutions: {
          select: { runId: true, run: { select: { goal: true } } },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async resolveWriteOutcome(
    current: AuthContext,
    sessionId: string,
    note: string,
  ) {
    await this.ownedSession(current, sessionId);
    const result = await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      const session = await tx.browserRuntimeSession.findUniqueOrThrow({
        where: { id: sessionId },
        include: { browserExecutions: true },
      });
      if (!session.closureVerifiedAt || session.status !== "CLOSED")
        throw new ConflictException(
          "Confirm that the previous browser is closed before releasing its data locks.",
        );
      const owner = session.ownerTaskId
        ? await tx.agentRuntimeTask.findUnique({
            where: { id: session.ownerTaskId },
            include: { run: true },
          })
        : null;
      if (
        owner &&
        (["PENDING", "RUNNING", "WAITING_HUMAN"].includes(owner.status) ||
          !["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(
            owner.run.lifecycle,
          ))
      )
        throw new ConflictException(
          "The previous execution must stop before its write outcome can be resolved.",
        );
      if (owner) {
        if (
          owner.recoveryStatus !== "WRITE_OUTCOME_UNKNOWN" &&
          owner.recoveryStatus !== "RESOLVED"
        )
          throw new ConflictException(
            "Wait for lease recovery to determine the previous write outcome before resolving it.",
          );
        const resolved = await tx.agentRuntimeTask.updateMany({
          where: {
            id: owner.id,
            status: owner.status,
            recoveryStatus: owner.recoveryStatus,
            fencingToken: owner.fencingToken,
          },
          data: { recoveryStatus: "RESOLVED", recoveryNextAttemptAt: null },
        });
        if (resolved.count !== 1)
          throw new ConflictException(
            "The previous execution changed while its outcome was being resolved.",
          );
      }
      const released = await tx.executionResourceLease.deleteMany({
        where: { sessionId, quarantined: true },
      });
      await tx.browserRuntimeSession.updateMany({
        where: { id: sessionId },
        data: { quarantinedAt: null },
      });
      const execution = session.browserExecutions[0];
      if (released.count && execution)
        await tx.runEvent.create({
          data: {
            teamId: current.team.id,
            runId: execution.runId,
            attemptId: execution.attemptId,
            actor: "HUMAN",
            kind: "runtime.write_outcome.reconciled",
            payload: { note, resolvedByUserId: current.user.id },
          },
        });
      await tx.auditEvent.create({
        data: {
          action: "runtime.write_outcome.reconciled",
          actorUserId: current.user.id,
          entityId: sessionId,
          entityType: "browser_runtime_session",
          metadata: { note, released: released.count },
          teamId: current.team.id,
        },
      });
      return { released: released.count };
    });
    return result;
  }

  async cancel(current: AuthContext, sessionId: string, commandId: string) {
    const session = await this.ownedSession(current, sessionId);
    const command = await this.prisma.browserRuntimeCommand.findFirst({
      where: { id: commandId, sessionId },
    });
    if (!command) {
      throw new NotFoundException("Runtime command was not found.");
    }
    const cancelled = await this.commands.cancel(
      commandId,
      "Cancelled from DevProof Console.",
    );
    return {
      ...cancelled,
      error: safeProfileJson(cancelled.error, session.userBrowserProfileId),
      fencingToken: cancelled.fencingToken.toString(),
      ownerFencingToken: cancelled.ownerFencingToken?.toString() ?? null,
      payload: safeProfileJson(cancelled.payload, session.userBrowserProfileId),
      result: safeProfileJson(cancelled.result, session.userBrowserProfileId),
    };
  }

  async close(
    current: AuthContext,
    sessionId: string,
    options: { timeoutSeconds?: number } = {},
  ): ReturnType<RuntimeSessionsService["detail"]> {
    let session = await this.ownedSession(current, sessionId);
    const timeoutSeconds =
      options.timeoutSeconds ?? env().RUNTIME_COMMAND_TIMEOUT_SECONDS;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (session.status === "CLOSED" || session.closureVerifiedAt) {
        return this.detail(current, sessionId);
      }
      if (session.status === "CLOSING") {
        return this.waitForClosingSession(current, sessionId, timeoutSeconds);
      }
      const claimed = await this.prisma.browserRuntimeSession.updateMany({
        data: { status: "CLOSING" },
        where: { id: sessionId, status: session.status },
      });
      if (claimed.count === 1) break;
      const latest = await this.prisma.browserRuntimeSession.findUnique({
        select: { status: true, userBrowserProfileId: true },
        where: { id: sessionId },
      });
      if (!latest) {
        throw new NotFoundException("Runtime session was not found.");
      }
      session = { ...session, ...latest };
      if (attempt === 2) {
        throw new ConflictException(
          "Runtime session state changed while it was being closed.",
        );
      }
    }
    let closeError: unknown;
    let closed: Awaited<ReturnType<RuntimeCommandDispatcher["execute"]>> = null;
    try {
      closed = await this.commands.execute({
        commandType: "session.close",
        sessionId,
        source: "SYSTEM",
        ...(options.timeoutSeconds === undefined
          ? {}
          : { timeoutSeconds: options.timeoutSeconds }),
      });
    } catch (error) {
      closeError = error;
    }
    const closeFailure = closed?.error ?? {
      code: "CLOSE_FAILED",
      ...(closeError
        ? {
            message:
              closeError instanceof Error
                ? closeError.message
                : String(closeError),
          }
        : {}),
    };
    if (closed?.status !== "SUCCEEDED") {
      await this.prisma.browserRuntimeSession.updateMany({
        data: {
          humanControllerUserId: null,
          humanControlExpiresAt: null,
          lastError: json(closeFailure),
        },
        where: { id: sessionId, status: "CLOSING" },
      });
      await this.audit.record(
        current,
        "runtime.session.close_pending",
        "browser_runtime_session",
        sessionId,
      );
      return this.detail(current, sessionId);
    }
    const closedAt = new Date();
    const finalized = await this.prisma.$transaction(async (tx) => {
      const finalized = await tx.browserRuntimeSession.updateMany({
        data: {
          closedAt,
          closureVerifiedAt: closedAt,
          humanControllerUserId: null,
          humanControlExpiresAt: null,
          lastError: Prisma.JsonNull,
          status: "CLOSED",
        },
        where: { id: sessionId, status: "CLOSING" },
      });
      if (finalized.count !== 1) return false;
      await releaseVerifiedSessionResources(tx, sessionId);
      if (session.userBrowserProfileId) {
        await tx.userBrowserProfile.updateMany({
          data: {
            inactivityExpiresAt: new Date(
              closedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
            ),
            lastUsedAt: closedAt,
          },
          where: { id: session.userBrowserProfileId },
        });
      }
      return true;
    });
    if (finalized) {
      await this.audit.record(
        current,
        "runtime.session.closed",
        "browser_runtime_session",
        sessionId,
      );
    }
    return this.detail(current, sessionId);
  }

  private async waitForClosingSession(
    current: AuthContext,
    sessionId: string,
    timeoutSeconds: number,
  ): ReturnType<RuntimeSessionsService["detail"]> {
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      const session = await this.prisma.browserRuntimeSession.findUnique({
        select: { status: true },
        where: { id: sessionId },
      });
      if (!session) {
        throw new NotFoundException("Runtime session was not found.");
      }
      if (["CLOSED", "FAILED", "LOST"].includes(session.status)) {
        return this.detail(current, sessionId);
      }
      if (session.status !== "CLOSING") {
        return this.close(current, sessionId, {
          timeoutSeconds: Math.max(0.1, (deadline - Date.now()) / 1_000),
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    return this.detail(current, sessionId);
  }

  async closeIdleProfileSessions(profileId: string) {
    const sessions = await this.prisma.browserRuntimeSession.findMany({
      where: {
        purpose: { in: ["PROFILE_PREPARATION", "PROFILE_VERIFICATION"] },
        status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"] },
        userBrowserProfileId: profileId,
      },
    });
    let closedCount = 0;
    for (const session of sessions) {
      const claimed = await this.prisma.browserRuntimeSession.updateMany({
        data: { status: "CLOSING" },
        where: {
          id: session.id,
          status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL"] },
        },
      });
      if (claimed.count !== 1 && session.status !== "CLOSING") continue;
      let closeError: unknown;
      let closed: Awaited<ReturnType<RuntimeCommandDispatcher["execute"]>> =
        null;
      try {
        closed = await this.commands.execute({
          commandType: "session.close",
          sessionId: session.id,
          source: "SYSTEM",
        });
      } catch (error) {
        closeError = error;
      }
      if (closed?.status !== "SUCCEEDED") {
        await this.prisma.browserRuntimeSession.updateMany({
          data: {
            humanControllerUserId: null,
            humanControlExpiresAt: null,
            lastError: json(
              closed?.error ?? {
                code: "CLOSE_FAILED",
                ...(closeError
                  ? {
                      message:
                        closeError instanceof Error
                          ? closeError.message
                          : String(closeError),
                    }
                  : {}),
              },
            ),
          },
          where: { id: session.id, status: "CLOSING" },
        });
        continue;
      }
      const closedAt = new Date();
      const finalized = await this.prisma.$transaction(async (tx) => {
        const finalized = await tx.browserRuntimeSession.updateMany({
          data: {
            closedAt,
            closureVerifiedAt: closedAt,
            humanControllerUserId: null,
            humanControlExpiresAt: null,
            lastError: Prisma.JsonNull,
            status: "CLOSED",
          },
          where: { id: session.id, status: "CLOSING" },
        });
        if (finalized.count !== 1) return false;
        await releaseVerifiedSessionResources(tx, session.id);
        return true;
      });
      if (finalized) closedCount += 1;
    }
    return closedCount;
  }

  async takeover(
    current: AuthContext,
    sessionId: string,
    input: HumanControlInput,
  ) {
    const session = await this.ownedSession(current, sessionId);
    const settings = await this.prisma.runtimeSettings.findUnique({
      where: { teamId: current.team.id },
    });
    if (settings && !settings.hitlEnabled) {
      throw new ForbiddenException("Human control is disabled for this team.");
    }
    if (session.status !== "ACTIVE") {
      throw new ConflictException("Only an active session can be taken over.");
    }
    const humanControlExpiresAt = new Date(
      Date.now() + input.ttlSeconds * 1000,
    );
    const claimed = await this.prisma.browserRuntimeSession.updateMany({
      data: {
        humanControllerUserId: current.user.id,
        humanControlExpiresAt,
        controlGeneration: { increment: 1 },
        status: "HUMAN_CONTROL",
      },
      where: {
        id: sessionId,
        status: "ACTIVE",
        controlGeneration: session.controlGeneration ?? 0,
        leaseExpiresAt: { gt: new Date() },
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("Runtime session is already controlled.");
    }
    const command = await this.commands.execute({
      commandType: "human.takeover",
      payload: {
        controllerUserId: current.user.id,
        expiresAt: humanControlExpiresAt.toISOString(),
      },
      sessionId,
      source: "HUMAN",
    });
    if (command?.status !== "SUCCEEDED") {
      await this.prisma.browserRuntimeSession.updateMany({
        data: {
          humanControllerUserId: null,
          humanControlExpiresAt: null,
          controlGeneration: { increment: 1 },
          status: "ACTIVE",
        },
        where: {
          id: sessionId,
          status: "HUMAN_CONTROL",
          controlGeneration: (session.controlGeneration ?? 0) + 1,
        },
      });
      throw new ConflictException("Browser Runtime rejected human control.");
    }
    await this.audit.record(
      current,
      "runtime.session.human_control.started",
      "browser_runtime_session",
      sessionId,
    );
    return this.detail(current, sessionId);
  }

  async release(current: AuthContext, sessionId: string) {
    const session = await this.ownedSession(current, sessionId);
    if (session.status !== "HUMAN_CONTROL") {
      return this.detail(current, sessionId);
    }
    if (session.humanControllerUserId !== current.user.id) {
      throw new ForbiddenException(
        "Only the current human controller can release this session.",
      );
    }
    const command = await this.commands.execute({
      commandType: "human.release",
      sessionId,
      source: "HUMAN",
    });
    if (command?.status !== "SUCCEEDED") {
      throw new ConflictException("Browser Runtime rejected control release.");
    }
    const released = await this.prisma.browserRuntimeSession.updateMany({
      data: {
        humanControllerUserId: null,
        humanControlExpiresAt: null,
        controlGeneration: { increment: 1 },
        // A browser taken over before its first Agent claim needs a bounded
        // handoff window after release, even if its original startup window elapsed.
        ...(!session.ownerTaskId
          ? {
              executionPermitExpiresAt: new Date(
                Math.min(
                  session.leaseExpiresAt.getTime(),
                  Date.now() + 120_000,
                ),
              ),
            }
          : {}),
        status: "ACTIVE",
      },
      where: {
        id: sessionId,
        status: "HUMAN_CONTROL",
        humanControllerUserId: current.user.id,
        controlGeneration: session.controlGeneration ?? 0,
        closureVerifiedAt: null,
      },
    });
    if (released.count !== 1)
      throw new ConflictException(
        "Browser control changed while it was being released.",
      );
    await this.audit.record(
      current,
      "runtime.session.human_control.released",
      "browser_runtime_session",
      sessionId,
    );
    return this.detail(current, sessionId);
  }

  private ownedSession(current: AuthContext, sessionId: string) {
    return this.prisma.browserRuntimeSession
      .findFirst({ where: { id: sessionId, teamId: current.team.id } })
      .then((session) => {
        if (!session) {
          throw new NotFoundException("Runtime session was not found.");
        }
        return session;
      });
  }

  private async expireSlots(runtimeId: string) {
    const expired = await this.prisma.browserRuntimeSlot.findMany({
      select: { sessionId: true },
      where: { expiresAt: { lte: new Date() }, runtimeId },
    });
    for (const session of expired)
      await this.prisma.$transaction(async (tx) => {
        if (!(await releaseVerifiedSessionResources(tx, session.sessionId)))
          await quarantineSession(tx, session.sessionId, "LEASE_EXPIRED");
      });
  }

  private serializeSession<
    T extends {
      fencingToken: bigint;
      ownerFencingToken?: bigint | null;
      lastError?: Prisma.JsonValue | null;
      profileKey?: string;
      userBrowserProfileId?: string | null;
    },
  >(row: T) {
    if (row.userBrowserProfileId) {
      return {
        ...row,
        fencingToken: row.fencingToken.toString(),
        ownerFencingToken: row.ownerFencingToken?.toString() ?? null,
        lastError: safeProfileJson(row.lastError, row.userBrowserProfileId),
        profileKey: null,
      };
    }
    return {
      ...row,
      fencingToken: row.fencingToken.toString(),
      ownerFencingToken: row.ownerFencingToken?.toString() ?? null,
    };
  }
}
