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
      await this.prisma.$transaction([
        this.prisma.browserRuntimeSession.update({
          data: {
            lastError: opened?.error ?? json({ code: "OPEN_FAILED" }),
            status: "FAILED",
          },
          where: { id: sessionId },
        }),
        this.prisma.browserRuntimeSlot.deleteMany({ where: { sessionId } }),
        this.prisma.browserRuntimeProfileLease.deleteMany({
          where: { sessionId },
        }),
      ]);
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
          payload: safeProfileJson(
            command.payload,
            session.userBrowserProfileId,
          ),
          result: safeProfileJson(command.result, session.userBrowserProfileId),
        }
      : null;
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
      payload: safeProfileJson(cancelled.payload, session.userBrowserProfileId),
      result: safeProfileJson(cancelled.result, session.userBrowserProfileId),
    };
  }

  async close(current: AuthContext, sessionId: string) {
    const session = await this.ownedSession(current, sessionId);
    if (["CLOSED", "FAILED", "LOST"].includes(session.status)) {
      return this.detail(current, sessionId);
    }
    await this.prisma.browserRuntimeSession.update({
      data: { status: "CLOSING" },
      where: { id: sessionId },
    });
    const closed = await this.commands.execute({
      commandType: "session.close",
      sessionId,
      source: "SYSTEM",
    });
    const closedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.browserRuntimeSession.update({
        data: {
          closedAt,
          lastError:
            closed?.status === "SUCCEEDED"
              ? Prisma.JsonNull
              : closed?.error
                ? json(closed.error)
                : json({ code: "CLOSE_FAILED" }),
          status: closed?.status === "SUCCEEDED" ? "CLOSED" : "LOST",
        },
        where: { id: sessionId },
      }),
      this.prisma.browserRuntimeSlot.deleteMany({ where: { sessionId } }),
      this.prisma.browserRuntimeProfileLease.deleteMany({
        where: { sessionId },
      }),
      ...(session.userBrowserProfileId
        ? [
            this.prisma.userBrowserProfile.updateMany({
              data: {
                inactivityExpiresAt: new Date(
                  closedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
                ),
                lastUsedAt: closedAt,
              },
              where: {
                id: session.userBrowserProfileId,
              },
            }),
          ]
        : []),
    ]);
    await this.audit.record(
      current,
      "runtime.session.closed",
      "browser_runtime_session",
      sessionId,
    );
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
      const closed = await this.commands.execute({
        commandType: "session.close",
        sessionId: session.id,
        source: "SYSTEM",
      });
      const closedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.browserRuntimeSession.update({
          data: {
            closedAt,
            humanControllerUserId: null,
            humanControlExpiresAt: null,
            lastError:
              closed?.status === "SUCCEEDED"
                ? Prisma.JsonNull
                : closed?.error
                  ? json(closed.error)
                  : json({ code: "CLOSE_FAILED" }),
            status: closed?.status === "SUCCEEDED" ? "CLOSED" : "LOST",
          },
          where: { id: session.id },
        }),
        this.prisma.browserRuntimeSlot.deleteMany({
          where: { sessionId: session.id },
        }),
        this.prisma.browserRuntimeProfileLease.deleteMany({
          where: { sessionId: session.id },
        }),
      ]);
      closedCount += 1;
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
        status: "HUMAN_CONTROL",
      },
      where: { id: sessionId, status: "ACTIVE" },
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
      await this.prisma.browserRuntimeSession.update({
        data: {
          humanControllerUserId: null,
          humanControlExpiresAt: null,
          status: "ACTIVE",
        },
        where: { id: sessionId },
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
    await this.prisma.browserRuntimeSession.update({
      data: {
        humanControllerUserId: null,
        humanControlExpiresAt: null,
        status: "ACTIVE",
      },
      where: { id: sessionId },
    });
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
    if (expired.length === 0) {
      return;
    }
    const sessionIds = expired.map((row) => row.sessionId);
    await this.prisma.$transaction([
      this.prisma.browserRuntimeSession.updateMany({
        data: {
          lastError: {
            code: "LEASE_EXPIRED",
            message: "Runtime session lease expired.",
          },
          status: "LOST",
        },
        where: {
          id: { in: sessionIds },
          status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"] },
        },
      }),
      this.prisma.browserRuntimeSlot.deleteMany({
        where: { sessionId: { in: sessionIds } },
      }),
      this.prisma.browserRuntimeProfileLease.deleteMany({
        where: { sessionId: { in: sessionIds } },
      }),
    ]);
  }

  private serializeSession<
    T extends {
      fencingToken: bigint;
      lastError?: Prisma.JsonValue | null;
      profileKey?: string;
      userBrowserProfileId?: string | null;
    },
  >(row: T) {
    if (row.userBrowserProfileId) {
      return {
        ...row,
        fencingToken: row.fencingToken.toString(),
        lastError: safeProfileJson(row.lastError, row.userBrowserProfileId),
        profileKey: null,
      };
    }
    return { ...row, fencingToken: row.fencingToken.toString() };
  }
}
