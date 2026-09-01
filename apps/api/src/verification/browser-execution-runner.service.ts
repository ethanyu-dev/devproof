import { randomUUID } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  RuntimeCommandInput,
  VerificationRequest,
} from "@devproof/contracts";
import {
  RUNTIME_PROTOCOL,
  runtimeCommandMinimumMinor,
} from "@devproof/runtime-protocol";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../infrastructure/redis.service.js";
import { RuntimeCommandDispatcher } from "../runtime/runtime-command-dispatcher.service.js";
import type {
  ExecutionRunner,
  ExecutionRunnerDescriptor,
  ExecutionRunnerLease,
} from "./runtime-adapters.js";
import { ExecutionRunnerUnavailableError } from "./runtime-adapters.js";
import {
  resolveRuntimeRoutingPlan,
  verificationTargetHostname,
} from "./runtime-routing.js";
import { VerificationLifecycleService } from "./verification-lifecycle.service.js";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface BrowserVideoFinalizationFailure {
  code: string;
  message: string;
  stepFrameCount: number;
  type: "VIDEO_FINALIZATION";
}

export function browserVideoFinalizationFailure(
  command: {
    result: unknown;
    status: string;
  } | null,
): BrowserVideoFinalizationFailure | null {
  if (!command || command.status !== "SUCCEEDED") return null;
  const result = record(command.result);
  const stepFrameCount =
    typeof result.stepFrameCount === "number" ? result.stepFrameCount : 0;
  if (result.videoCreated !== false || stepFrameCount === 0) return null;
  const videoError = record(result.videoError);
  return {
    code:
      typeof videoError.code === "string"
        ? videoError.code
        : "VIDEO_COMPOSITION_FAILED",
    message:
      typeof videoError.message === "string"
        ? videoError.message
        : "Browser Runtime closed without creating the step video.",
    stepFrameCount,
    type: "VIDEO_FINALIZATION",
  };
}

class RuntimeCapacityExhaustedError extends Error {}

export function supportsBrowserAgentProtocol(runtime: {
  protocolMajor: number | null;
  protocolMinor: number | null;
}): boolean {
  return (
    runtime.protocolMajor === RUNTIME_PROTOCOL.major &&
    (runtime.protocolMinor ?? 0) >= runtimeCommandMinimumMinor("page.snapshot")
  );
}

@Injectable()
export class BrowserExecutionRunner implements ExecutionRunner {
  readonly kind = "BROWSER";

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly commands: RuntimeCommandDispatcher,
    private readonly lifecycle: VerificationLifecycleService,
  ) {}

  async describe(teamId: string): Promise<ExecutionRunnerDescriptor[]> {
    const runtimes = await this.prisma.browserRuntime.findMany({
      where: { enabled: true, revokedAt: null, teamId },
    });
    return Promise.all(
      runtimes.map(async (runtime) => ({
        available: await this.redis.isRuntimeOnline(runtime.id),
        capabilities: ["browser", ...this.capabilities(runtime.capabilities)],
        id: runtime.id,
        kind: this.kind,
      })),
    );
  }

  async acquire(
    teamId: string,
    runId: string,
    request: VerificationRequest,
  ): Promise<ExecutionRunnerLease> {
    const existing = await this.ownedRun(teamId, runId);
    if (existing.runtimeSessionId) {
      const session = await this.prisma.browserRuntimeSession.findUnique({
        where: { id: existing.runtimeSessionId },
      });
      if (
        session &&
        ["OPENING", "ACTIVE", "HUMAN_CONTROL"].includes(session.status)
      ) {
        return this.lease(session.runtimeId, session);
      }
    }

    const profileMode = request.execution.profile.mode;
    const requestedProfileKey = request.execution.profile.key;
    const profileKey =
      requestedProfileKey ?? "verification-" + runId.replaceAll("-", "");
    if (
      profileMode === "PERSISTENT" &&
      (await this.prisma.userBrowserProfile.findUnique({
        select: { id: true },
        where: {
          teamId_runtimeProfileKey: {
            runtimeProfileKey: profileKey,
            teamId,
          },
        },
      }))
    ) {
      throw new ExecutionRunnerUnavailableError(
        "NO_MATCHING_RUNNER",
        "Legacy Verification Runs cannot open a user Browser Profile by raw key.",
        request.execution.availabilityPolicy,
      );
    }
    const affinity =
      profileMode === "PERSISTENT"
        ? await this.prisma.browserRuntimeSession.findFirst({
            orderBy: { createdAt: "desc" },
            select: { runtimeId: true },
            where: { profileKey, profileMode: "PERSISTENT", teamId },
          })
        : null;
    const selection = await this.selectRuntimes(
      teamId,
      request,
      affinity?.runtimeId,
    );
    let unavailableReason:
      "NO_MATCHING_RUNNER" | "NO_AVAILABLE_SLOT" | "SESSION_OPEN_FAILED" =
      "NO_MATCHING_RUNNER";

    for (const runtime of selection.runtimes) {
      await this.expireSlots(runtime.id);
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(
        Date.now() + env().RUNTIME_LEASE_SECONDS * 1000,
      );
      let session: Awaited<ReturnType<typeof this.allocateSession>> | undefined;

      for (
        let slotNumber = 0;
        slotNumber < runtime.maxConcurrency;
        slotNumber += 1
      ) {
        try {
          session = await this.allocateSession({
            leaseExpiresAt,
            leaseToken,
            profileKey,
            profileMode,
            runtimeId: runtime.id,
            slotNumber,
            teamId,
          });
          break;
        } catch (error) {
          if (error instanceof RuntimeCapacityExhaustedError) break;
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            (error.code === "P2002" || error.code === "P2034")
          ) {
            continue;
          }
          throw error;
        }
      }
      if (!session) {
        unavailableReason = "NO_AVAILABLE_SLOT";
        continue;
      }

      const opened = await this.commands.execute({
        commandType: "session.open",
        payload: {
          // Kept on the wire for compatibility with Runtime protocol 1.x.
          // Navigation access is governed by the centrally managed network policy.
          allowedOrigins: [],
          profileKey,
          profileMode,
        },
        sessionId: session.id,
        source: "SYSTEM",
      });
      if (opened?.status !== "SUCCEEDED") {
        unavailableReason = "SESSION_OPEN_FAILED";
        await this.failOpen(session.id, opened?.error);
        continue;
      }

      await this.prisma.$transaction([
        this.prisma.browserRuntimeSession.update({
          data: { openedAt: new Date(), status: "ACTIVE" },
          where: { id: session.id },
        }),
        this.prisma.verificationRun.update({
          data: { runnerId: runtime.id, runtimeSessionId: session.id },
          where: { id: runId },
        }),
      ]);
      return this.lease(runtime.id, session, selection.routing);
    }

    const messages = {
      NO_AVAILABLE_SLOT: "Matching Browser Runtimes have no available slot.",
      NO_MATCHING_RUNNER:
        "No online Browser Runtime satisfies the routing policy and required capabilities.",
      SESSION_OPEN_FAILED:
        "Matching Browser Runtimes could not open a session.",
    } as const;
    throw new ExecutionRunnerUnavailableError(
      unavailableReason,
      messages[unavailableReason],
      selection.availabilityPolicyOverride,
    );
  }

  async acquireForExecutionRun(
    teamId: string,
    browserExecutionId: string,
    request: VerificationRequest,
  ): Promise<ExecutionRunnerLease> {
    const execution = await this.ownedBrowserExecution(
      teamId,
      browserExecutionId,
    );
    if (execution.runtimeSessionId) {
      const session = await this.prisma.browserRuntimeSession.findUnique({
        where: { id: execution.runtimeSessionId },
      });
      if (
        session &&
        ["OPENING", "ACTIVE", "HUMAN_CONTROL"].includes(session.status)
      ) {
        return this.lease(session.runtimeId, session);
      }
    }

    const profileMode = request.execution.profile.mode;
    const requestedProfileKey = request.execution.profile.key;
    const profileKey =
      requestedProfileKey ?? "execution-" + execution.runId.replaceAll("-", "");
    const userProfile =
      profileMode === "PERSISTENT"
        ? await this.prisma.userBrowserProfile.findUnique({
            where: {
              teamId_runtimeProfileKey: {
                runtimeProfileKey: profileKey,
                teamId,
              },
            },
          })
        : null;
    if (
      (userProfile && execution.run.browserProfileId !== userProfile.id) ||
      (execution.run.browserProfileId &&
        userProfile?.id !== execution.run.browserProfileId)
    ) {
      throw new ExecutionRunnerUnavailableError(
        "NO_MATCHING_RUNNER",
        "The browser profile was not authorized by this execution Run.",
        request.execution.availabilityPolicy,
      );
    }
    if (
      userProfile &&
      (userProfile.status !== "READY" ||
        !userProfile.inactivityExpiresAt ||
        userProfile.inactivityExpiresAt.getTime() <= Date.now())
    ) {
      throw new ExecutionRunnerUnavailableError(
        "NO_MATCHING_RUNNER",
        "The selected user browser profile is not READY or has expired.",
        request.execution.availabilityPolicy,
      );
    }
    const historicalAffinity =
      profileMode === "PERSISTENT" && !userProfile?.assignedRuntimeId
        ? await this.prisma.browserRuntimeSession.findFirst({
            orderBy: { createdAt: "desc" },
            select: { runtimeId: true },
            where: { profileKey, profileMode: "PERSISTENT", teamId },
          })
        : null;
    const selection = await this.selectRuntimes(
      teamId,
      request,
      userProfile?.assignedRuntimeId ?? historicalAffinity?.runtimeId,
    );
    let unavailableReason:
      "NO_MATCHING_RUNNER" | "NO_AVAILABLE_SLOT" | "SESSION_OPEN_FAILED" =
      "NO_MATCHING_RUNNER";

    for (const runtime of selection.runtimes) {
      if (userProfile && (runtime.protocolMinor ?? 0) < 9) continue;
      await this.expireSlots(runtime.id);
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(
        Date.now() + env().RUNTIME_LEASE_SECONDS * 1_000,
      );
      let session: Awaited<ReturnType<typeof this.allocateSession>> | undefined;
      for (
        let slotNumber = 0;
        slotNumber < runtime.maxConcurrency;
        slotNumber += 1
      ) {
        try {
          session = await this.allocateSession({
            leaseExpiresAt,
            leaseToken,
            profileKey,
            profileMode,
            runtimeId: runtime.id,
            slotNumber,
            teamId,
            ...(userProfile ? { userBrowserProfileId: userProfile.id } : {}),
          });
          break;
        } catch (error) {
          if (error instanceof RuntimeCapacityExhaustedError) break;
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            (error.code === "P2002" || error.code === "P2034")
          ) {
            continue;
          }
          throw error;
        }
      }
      if (!session) {
        unavailableReason = "NO_AVAILABLE_SLOT";
        continue;
      }

      const opened = await this.commands.execute({
        commandType: "session.open",
        payload: {
          allowedOrigins: [],
          profileKey,
          profileMode,
          ...(userProfile
            ? {
                profileRetention: {
                  inactivityTtlSeconds: 2_592_000,
                  kind: "USER",
                },
              }
            : {}),
        },
        sessionId: session.id,
        source: "SYSTEM",
      });
      if (opened?.status !== "SUCCEEDED") {
        unavailableReason = "SESSION_OPEN_FAILED";
        await this.failOpen(session.id, opened?.error);
        continue;
      }

      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.browserRuntimeSession.update({
          data: { openedAt: now, status: "ACTIVE" },
          where: { id: session.id },
        }),
        this.prisma.browserExecution.update({
          data: {
            error: Prisma.JsonNull,
            runtimeSessionId: session.id,
            startedAt: execution.startedAt ?? now,
            status: "ACTIVE",
          },
          where: { id: browserExecutionId },
        }),
        this.prisma.runEvent.create({
          data: {
            actor: "BROWSER_RUNTIME",
            attemptId: execution.attemptId,
            kind: "browser.execution.acquired",
            payload: json({
              routing: selection.routing,
              runtimeId: runtime.id,
              sessionId: session.id,
            }),
            runId: execution.runId,
            teamId,
          },
        }),
        ...(userProfile
          ? [
              this.prisma.userBrowserProfile.update({
                data: {
                  assignedRuntimeId: runtime.id,
                  inactivityExpiresAt: new Date(
                    now.getTime() + 30 * 24 * 60 * 60 * 1_000,
                  ),
                  lastUsedAt: now,
                },
                where: { id: userProfile.id },
              }),
            ]
          : []),
      ]);
      return this.lease(runtime.id, session, selection.routing);
    }

    const messages = {
      NO_AVAILABLE_SLOT: "Matching Browser Runtimes have no available slot.",
      NO_MATCHING_RUNNER:
        "No online Browser Runtime satisfies the routing policy and required capabilities.",
      SESSION_OPEN_FAILED:
        "Matching Browser Runtimes could not open a session.",
    } as const;
    await this.prisma.$transaction(async (tx) => {
      await tx.browserExecution.update({
        data: {
          error: json({
            code: unavailableReason,
            message: messages[unavailableReason],
          }),
          status: "WAITING_CAPACITY",
        },
        where: { id: browserExecutionId },
      });
      if (execution.status !== "WAITING_CAPACITY") {
        await tx.runEvent.create({
          data: {
            actor: "CONTROL_PLANE",
            attemptId: execution.attemptId,
            kind: "browser.execution.waiting_capacity",
            payload: json({
              message: messages[unavailableReason],
              reason: unavailableReason,
            }),
            runId: execution.runId,
            teamId,
          },
        });
      }
    });
    throw new ExecutionRunnerUnavailableError(
      unavailableReason,
      messages[unavailableReason],
      selection.availabilityPolicyOverride,
    );
  }

  async executeForExecutionRun(
    teamId: string,
    browserExecutionId: string,
    input: RuntimeCommandInput,
    signal?: AbortSignal,
  ) {
    const execution = await this.ownedBrowserExecution(
      teamId,
      browserExecutionId,
    );
    if (!execution.runtimeSessionId) {
      throw new ConflictException(
        "Browser execution has not acquired a session.",
      );
    }
    const session = await this.prisma.browserRuntimeSession.findFirst({
      where: { id: execution.runtimeSessionId, teamId },
    });
    if (!session || session.status !== "ACTIVE") {
      throw new ConflictException(
        session?.status === "HUMAN_CONTROL"
          ? "Execution is paused while a human controls the browser."
          : "Browser execution session is not active.",
      );
    }
    const requiredMinor = runtimeCommandMinimumMinor(input.commandType);
    if (session.protocolMinor < requiredMinor) {
      throw new ConflictException({
        code: "PROTOCOL_UNSUPPORTED",
        message: `Browser command ${input.commandType} requires Runtime protocol v1.${requiredMinor}; restart the Browser Runtime after upgrading it.`,
        retryable: false,
      });
    }

    const commandId = randomUUID();
    const startedAt = new Date();
    await this.prisma.runEvent.create({
      data: {
        actor: "AGENT_RUNTIME",
        attemptId: execution.attemptId,
        kind: "browser.command.started",
        payload: json({ commandId, commandType: input.commandType }),
        runId: execution.runId,
        teamId,
      },
    });
    const command = await this.commands.execute({
      commandId,
      commandType: input.commandType,
      payload: input.payload,
      sessionId: session.id,
      ...(signal ? { signal } : {}),
      source: "AGENT",
      ...(input.timeoutSeconds === undefined
        ? {}
        : { timeoutSeconds: input.timeoutSeconds }),
    });
    if (!command) {
      throw new ConflictException(
        "Browser command disappeared before completion.",
      );
    }

    if (command.artifacts.length > 0) {
      await this.prisma.runEvidence.createMany({
        data: command.artifacts.map((artifact) => ({
          attemptId: execution.attemptId,
          externalId: `artifact://${artifact.id}`,
          kind: artifact.kind,
          metadata: json(artifact.metadata),
          runId: execution.runId,
          runtimeArtifactId: artifact.id,
          teamId,
        })),
        skipDuplicates: true,
      });
    }
    const evidenceRefs = command.artifacts.map(
      (artifact) => `artifact://${artifact.id}`,
    );
    await this.prisma.runEvent.create({
      data: {
        actor: "BROWSER_RUNTIME",
        attemptId: execution.attemptId,
        kind: "browser.command.completed",
        payload: json({
          commandId: command.id,
          commandType: input.commandType,
          durationMs: Math.max(0, Date.now() - startedAt.getTime()),
          error: command.error,
          evidenceRefs,
          status: command.status,
        }),
        runId: execution.runId,
        teamId,
      },
    });
    return {
      ...command,
      evidenceRefs,
      fencingToken: command.fencingToken.toString(),
    };
  }

  async releaseForExecutionRun(
    teamId: string,
    browserExecutionId: string,
  ): Promise<void> {
    const execution = await this.ownedBrowserExecution(
      teamId,
      browserExecutionId,
    );
    if (!execution.runtimeSessionId) {
      await this.prisma.browserExecution.update({
        data: { finishedAt: new Date(), status: "RELEASED" },
        where: { id: execution.id },
      });
      return;
    }
    const session = await this.prisma.browserRuntimeSession.findFirst({
      where: { id: execution.runtimeSessionId, teamId },
    });
    if (!session || ["CLOSED", "FAILED", "LOST"].includes(session.status)) {
      await this.prisma.browserExecution.update({
        data: { finishedAt: new Date(), status: "RELEASED" },
        where: { id: execution.id },
      });
      return;
    }
    const claimed = await this.prisma.browserRuntimeSession.updateMany({
      data: { status: "CLOSING" },
      where: {
        id: session.id,
        status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL"] },
      },
    });
    if (claimed.count !== 1) return;
    await this.prisma.browserExecution.update({
      data: { status: "RELEASING" },
      where: { id: execution.id },
    });
    const closed = await this.commands.execute({
      commandType: "session.close",
      sessionId: session.id,
      source: "SYSTEM",
      timeoutSeconds: 60,
    });
    if (closed?.artifacts.length) {
      await this.prisma.runEvidence.createMany({
        data: closed.artifacts.map((artifact) => ({
          attemptId: execution.attemptId,
          externalId: `artifact://${artifact.id}`,
          kind: artifact.kind,
          metadata: json(artifact.metadata),
          runId: execution.runId,
          runtimeArtifactId: artifact.id,
          teamId,
        })),
        skipDuplicates: true,
      });
    }
    const now = new Date();
    const released = closed?.status === "SUCCEEDED";
    const videoFailure = browserVideoFinalizationFailure(closed);
    await this.prisma.$transaction([
      this.prisma.browserRuntimeSession.update({
        data: {
          closedAt: now,
          lastError: released
            ? videoFailure
              ? json(videoFailure)
              : Prisma.JsonNull
            : closed?.error
              ? json(closed.error)
              : json({ code: "CLOSE_FAILED" }),
          status: released ? "CLOSED" : "LOST",
        },
        where: { id: session.id },
      }),
      this.prisma.browserRuntimeSlot.deleteMany({
        where: { sessionId: session.id },
      }),
      this.prisma.browserRuntimeProfileLease.deleteMany({
        where: { sessionId: session.id },
      }),
      this.prisma.browserExecution.update({
        data: {
          error: released
            ? Prisma.JsonNull
            : json(closed?.error ?? { code: "CLOSE_FAILED" }),
          finishedAt: now,
          status: released ? "RELEASED" : "LOST",
        },
        where: { id: execution.id },
      }),
      this.prisma.runEvent.create({
        data: {
          actor: "CONTROL_PLANE",
          attemptId: execution.attemptId,
          kind: "browser.execution.released",
          payload: json({
            sessionId: session.id,
            status: closed?.status ?? "LOST",
            ...(videoFailure
              ? { videoCreated: false, videoError: videoFailure }
              : {}),
          }),
          runId: execution.runId,
          teamId,
        },
      }),
      ...(session.userBrowserProfileId
        ? [
            this.prisma.userBrowserProfile.updateMany({
              data: {
                inactivityExpiresAt: new Date(
                  now.getTime() + 30 * 24 * 60 * 60 * 1_000,
                ),
                lastUsedAt: now,
              },
              where: {
                id: session.userBrowserProfileId,
              },
            }),
          ]
        : []),
    ]);
  }

  async execute(
    teamId: string,
    runId: string,
    input: RuntimeCommandInput,
    signal?: AbortSignal,
  ) {
    const run = await this.ownedRun(teamId, runId);
    if (!run.runtimeSessionId) {
      throw new ConflictException(
        "Verification has not acquired an execution session.",
      );
    }
    const session = await this.prisma.browserRuntimeSession.findFirst({
      where: { id: run.runtimeSessionId, teamId },
    });
    if (!session || session.status !== "ACTIVE") {
      throw new ConflictException(
        session?.status === "HUMAN_CONTROL"
          ? "Execution is paused while a human controls the browser."
          : "Browser execution session is not active.",
      );
    }
    const requiredMinor = runtimeCommandMinimumMinor(input.commandType);
    if (session.protocolMinor < requiredMinor) {
      throw new ConflictException({
        code: "PROTOCOL_UNSUPPORTED",
        message: `Browser command ${input.commandType} requires Runtime protocol v1.${requiredMinor}; restart the Browser Runtime after upgrading it.`,
        retryable: false,
      });
    }
    const commandId = randomUUID();
    const started = await this.lifecycle.appendEvent({
      actor: "AGENT",
      kind: "execution.command.started",
      payload: {
        commandId,
        commandType: input.commandType,
      },
      runtimeCommandId: commandId,
      status: "STARTED",
      runId,
      teamId,
    });
    let command: Awaited<ReturnType<RuntimeCommandDispatcher["execute"]>>;
    try {
      command = await this.commands.execute({
        commandId,
        commandType: input.commandType,
        payload: input.payload,
        sessionId: session.id,
        ...(signal ? { signal } : {}),
        source: "AGENT",
        ...(input.timeoutSeconds === undefined
          ? {}
          : { timeoutSeconds: input.timeoutSeconds }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : error instanceof Error
            ? error.name.toUpperCase()
            : "COMMAND_DISPATCH_FAILED";
      await this.lifecycle
        .appendEvent({
          actor: "RUNNER",
          durationMs: Math.max(0, Date.now() - started.occurredAt.getTime()),
          errorCode: code,
          errorMessage: message.slice(0, 4_000),
          kind: "execution.command.failed",
          payload: { commandId, commandType: input.commandType },
          runId,
          runtimeCommandId: commandId,
          status: signal?.aborted ? "CANCELLED" : "FAILED",
          teamId,
        })
        .catch(() => undefined);
      throw error;
    }
    if (!command) {
      throw new ConflictException(
        "Browser command disappeared before completion.",
      );
    }

    if (command.artifacts.length > 0) {
      await this.prisma.verificationArtifact.createMany({
        data: command.artifacts.map((artifact) => ({
          eventId: started.id,
          kind: artifact.kind,
          metadata: json(artifact.metadata),
          runId,
          runtimeArtifactId: artifact.id,
          storageKey: artifact.storageKey,
          teamId,
        })),
        skipDuplicates: true,
      });
    }
    const verificationArtifacts =
      command.artifacts.length === 0
        ? []
        : await this.prisma.verificationArtifact.findMany({
            orderBy: { createdAt: "asc" },
            select: { id: true },
            where: {
              runId,
              runtimeArtifactId: {
                in: command.artifacts.map((artifact) => artifact.id),
              },
            },
          });
    const evidenceRefs = verificationArtifacts.map(
      (artifact) => `artifact://${artifact.id}`,
    );
    await this.lifecycle.appendEvent({
      actor: "RUNNER",
      kind: "execution.command.completed",
      payload: {
        artifactIds: command.artifacts.map((artifact) => artifact.id),
        commandId: command.id,
        commandType: input.commandType,
        error: command.error,
        status: command.status,
      },
      ...(command.completedAt === null
        ? {}
        : {
            durationMs: Math.max(
              0,
              command.completedAt.getTime() - command.createdAt.getTime(),
            ),
          }),
      ...(command.error &&
      typeof command.error === "object" &&
      !Array.isArray(command.error) &&
      "code" in command.error &&
      typeof command.error.code === "string"
        ? { errorCode: command.error.code }
        : {}),
      ...(command.error &&
      typeof command.error === "object" &&
      !Array.isArray(command.error) &&
      "message" in command.error &&
      typeof command.error.message === "string"
        ? { errorMessage: command.error.message }
        : {}),
      runtimeCommandId: command.id,
      status:
        command.status === "SUCCEEDED"
          ? "SUCCEEDED"
          : command.status === "CANCELLED"
            ? "CANCELLED"
            : command.status === "TIMED_OUT"
              ? "TIMED_OUT"
              : "FAILED",
      runId,
      teamId,
    });
    return {
      ...command,
      evidenceRefs,
      fencingToken: command.fencingToken.toString(),
    };
  }

  async release(teamId: string, runId: string): Promise<void> {
    const run = await this.ownedRun(teamId, runId);
    if (!run.runtimeSessionId) {
      return;
    }
    const session = await this.prisma.browserRuntimeSession.findFirst({
      where: { id: run.runtimeSessionId, teamId },
    });
    if (!session || ["CLOSED", "FAILED", "LOST"].includes(session.status)) {
      return;
    }
    const claimed = await this.prisma.browserRuntimeSession.updateMany({
      data: { status: "CLOSING" },
      where: {
        id: session.id,
        status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL"] },
      },
    });
    if (claimed.count !== 1) return;
    const closed = await this.commands.execute({
      commandType: "session.close",
      sessionId: session.id,
      source: "SYSTEM",
      timeoutSeconds: 60,
    });
    if (closed?.artifacts.length) {
      await this.prisma.verificationArtifact.createMany({
        data: closed.artifacts.map((artifact) => ({
          kind: artifact.kind,
          metadata: json(artifact.metadata),
          runId,
          runtimeArtifactId: artifact.id,
          storageKey: artifact.storageKey,
          teamId,
        })),
        skipDuplicates: true,
      });
    }
    const released = closed?.status === "SUCCEEDED";
    const videoFailure = browserVideoFinalizationFailure(closed);
    await this.prisma.$transaction([
      this.prisma.browserRuntimeSession.update({
        data: {
          closedAt: new Date(),
          lastError: released
            ? videoFailure
              ? json(videoFailure)
              : Prisma.JsonNull
            : closed?.error
              ? json(closed.error)
              : json({ code: "CLOSE_FAILED" }),
          status: released ? "CLOSED" : "LOST",
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
    await this.lifecycle.appendEvent({
      actor: "RUNNER",
      kind: "execution.released",
      payload: {
        sessionId: session.id,
        status: closed?.status ?? "LOST",
        ...(videoFailure
          ? { videoCreated: false, videoError: videoFailure }
          : {}),
      },
      runId,
      teamId,
    });
  }

  async purgeProfile(
    teamId: string,
    profileKey: string,
    authorizedUserProfileId?: string,
  ) {
    const userProfile = await this.prisma.userBrowserProfile.findUnique({
      select: { id: true },
      where: {
        teamId_runtimeProfileKey: {
          runtimeProfileKey: profileKey,
          teamId,
        },
      },
    });
    if (
      (userProfile && userProfile.id !== authorizedUserProfileId) ||
      (authorizedUserProfileId && userProfile?.id !== authorizedUserProfileId)
    ) {
      throw new ConflictException(
        "A user Browser Profile can only be purged through its logical profile resource.",
      );
    }
    const affinity = await this.prisma.browserRuntimeSession.findFirst({
      orderBy: { createdAt: "desc" },
      select: { runtimeId: true },
      where: { profileKey, profileMode: "PERSISTENT", teamId },
    });
    if (!affinity) {
      return { profileKey, purged: true, runtimeId: null };
    }
    const runtime = await this.prisma.browserRuntime.findFirst({
      where: {
        enabled: true,
        id: affinity.runtimeId,
        revokedAt: null,
        teamId,
      },
    });
    if (!runtime || !(await this.redis.isRuntimeOnline(runtime.id))) {
      throw new ConflictException(
        "Persistent profile cannot be purged while its Browser Runtime is offline.",
      );
    }
    if (
      runtime.protocolMajor !== RUNTIME_PROTOCOL.major ||
      (runtime.protocolMinor ?? 0) < runtimeCommandMinimumMinor("profile.purge")
    ) {
      throw new ConflictException(
        "Persistent profile purge requires Browser Runtime protocol v1.6.",
      );
    }
    if (
      await this.prisma.browserRuntimeProfileLease.findUnique({
        where: { teamId_profileKey: { profileKey, teamId } },
      })
    ) {
      throw new ConflictException(
        "Persistent profile is still used by another session.",
      );
    }

    await this.expireSlots(runtime.id);
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      Date.now() + env().RUNTIME_LEASE_SECONDS * 1_000,
    );
    let session: Awaited<ReturnType<typeof this.allocateSession>> | undefined;
    for (
      let slotNumber = 0;
      slotNumber < runtime.maxConcurrency;
      slotNumber += 1
    ) {
      try {
        session = await this.allocateSession({
          leaseExpiresAt,
          leaseToken,
          profileKey,
          profileMode: "PERSISTENT",
          purpose: "PROFILE_PURGE",
          runtimeId: runtime.id,
          slotNumber,
          teamId,
          ...(authorizedUserProfileId
            ? { userBrowserProfileId: authorizedUserProfileId }
            : {}),
        });
        break;
      } catch (error) {
        if (error instanceof RuntimeCapacityExhaustedError) break;
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2002" || error.code === "P2034")
        ) {
          continue;
        }
        throw error;
      }
    }
    if (!session) {
      throw new ConflictException(
        "Persistent profile purge is waiting for an available Runtime slot.",
      );
    }

    let purged = false;
    try {
      const result = await this.commands.execute({
        commandType: "profile.purge",
        payload: { profileKey },
        sessionId: session.id,
        source: "SYSTEM",
      });
      purged = result?.status === "SUCCEEDED";
      if (!purged) {
        throw new ConflictException(
          result?.error ?? "Browser Runtime failed to purge the profile.",
        );
      }
      return { profileKey, purged: true, runtimeId: runtime.id };
    } finally {
      await this.prisma.$transaction([
        this.prisma.browserRuntimeSession.update({
          data: {
            closedAt: new Date(),
            status: purged ? "CLOSED" : "FAILED",
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
    }
  }

  private ownedRun(teamId: string, runId: string) {
    return this.prisma.verificationRun
      .findFirst({ where: { id: runId, teamId } })
      .then((run) => {
        if (!run) {
          throw new NotFoundException("Verification run was not found.");
        }
        return run;
      });
  }

  private ownedBrowserExecution(teamId: string, executionId: string) {
    return this.prisma.browserExecution
      .findFirst({
        include: { run: true },
        where: { id: executionId, run: { teamId } },
      })
      .then((execution) => {
        if (!execution) {
          throw new NotFoundException("Browser execution was not found.");
        }
        return execution;
      });
  }

  private async selectRuntimes(
    teamId: string,
    request: VerificationRequest,
    affinityRuntimeId?: string,
  ) {
    const [runtimes, rules] = await Promise.all([
      this.prisma.browserRuntime.findMany({
        where: {
          enabled: true,
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
      hostname: verificationTargetHostname(request),
      rules,
    });
    const runtimesById = new Map(
      runtimes.map((runtime) => [runtime.id, runtime] as const),
    );
    const candidates = [];
    for (const runtimeId of plan.candidateIds) {
      if (affinityRuntimeId && runtimeId !== affinityRuntimeId) continue;
      const runtime = runtimesById.get(runtimeId);
      if (!runtime) continue;
      if (!supportsBrowserAgentProtocol(runtime)) continue;
      const capabilities = new Set([
        "browser",
        ...this.capabilities(runtime.capabilities),
      ]);
      if (
        request.execution.requiredCapabilities.every((item) =>
          capabilities.has(item),
        ) &&
        (await this.redis.isRuntimeOnline(runtime.id))
      ) {
        candidates.push(runtime);
      }
    }
    if (plan.routing.source === "POOL" && candidates.length > 1) {
      const now = new Date();
      const [slotCounts, constrainedCounts] = await Promise.all([
        this.prisma.browserRuntimeSlot.groupBy({
          _count: { _all: true },
          by: ["runtimeId"],
          where: {
            expiresAt: { gt: now },
            runtimeId: { in: candidates.map((runtime) => runtime.id) },
          },
        }),
        this.prisma.browserExecution.groupBy({
          _count: { _all: true },
          by: ["targetRuntimeId"],
          where: {
            status: { in: ["REQUESTED", "WAITING_CAPACITY", "ALLOCATING"] },
            targetRuntimeId: {
              in: candidates.map((runtime) => runtime.id),
            },
          },
        }),
      ]);
      const occupied = new Map(
        slotCounts.map((row) => [row.runtimeId, row._count._all]),
      );
      const constrained = new Map(
        constrainedCounts.flatMap((row) =>
          row.targetRuntimeId
            ? [[row.targetRuntimeId, row._count._all] as const]
            : [],
        ),
      );
      candidates.sort((left, right) => {
        const pressure =
          (constrained.get(left.id) ?? 0) - (constrained.get(right.id) ?? 0);
        if (pressure !== 0) return pressure;
        const leftOccupied = occupied.get(left.id) ?? 0;
        const rightOccupied = occupied.get(right.id) ?? 0;
        const utilization =
          leftOccupied / left.maxConcurrency -
          rightOccupied / right.maxConcurrency;
        if (utilization !== 0) return utilization;
        const availability =
          right.maxConcurrency -
          rightOccupied -
          (left.maxConcurrency - leftOccupied);
        return availability !== 0
          ? availability
          : left.id.localeCompare(right.id);
      });
    }
    return {
      ...plan,
      runtimes: candidates,
    };
  }

  private capabilities(value: Prisma.JsonValue): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }

  private allocateSession(input: {
    leaseExpiresAt: Date;
    leaseToken: string;
    profileKey: string;
    profileMode: "PERSISTENT" | "EPHEMERAL";
    purpose?: "EXECUTION" | "PROFILE_PURGE";
    runtimeId: string;
    slotNumber: number;
    teamId: string;
    userBrowserProfileId?: string;
  }) {
    return this.prisma.$transaction(
      async (tx) => {
        const runtime = await tx.browserRuntime.findUniqueOrThrow({
          where: { id: input.runtimeId },
        });
        const occupied = await tx.browserRuntimeSlot.count({
          where: {
            expiresAt: { gt: new Date() },
            runtimeId: input.runtimeId,
          },
        });
        if (occupied >= runtime.maxConcurrency) {
          throw new RuntimeCapacityExhaustedError(
            `Browser Runtime ${runtime.id} has no available slot.`,
          );
        }
        const counter = await tx.browserRuntimeFenceCounter.upsert({
          create: { runtimeId: input.runtimeId, value: 1n },
          update: { value: { increment: 1n } },
          where: { runtimeId: input.runtimeId },
        });
        const session = await tx.browserRuntimeSession.create({
          data: {
            fencingToken: counter.value,
            leaseExpiresAt: input.leaseExpiresAt,
            leaseToken: input.leaseToken,
            profileKey: input.profileKey,
            profileMode: input.profileMode,
            purpose: input.purpose ?? "EXECUTION",
            protocolMajor: RUNTIME_PROTOCOL.major,
            protocolMinor: runtime.protocolMinor ?? RUNTIME_PROTOCOL.minor,
            runtimeId: input.runtimeId,
            slotNumber: input.slotNumber,
            teamId: input.teamId,
            ...(input.userBrowserProfileId
              ? { userBrowserProfileId: input.userBrowserProfileId }
              : {}),
          },
        });
        await tx.browserRuntimeSlot.create({
          data: {
            expiresAt: input.leaseExpiresAt,
            fencingToken: counter.value,
            leaseToken: input.leaseToken,
            runtimeId: input.runtimeId,
            sessionId: session.id,
            slotNumber: input.slotNumber,
          },
        });
        if (input.profileMode === "PERSISTENT") {
          await tx.browserRuntimeProfileLease.create({
            data: {
              expiresAt: input.leaseExpiresAt,
              fencingToken: counter.value,
              leaseToken: input.leaseToken,
              profileKey: input.profileKey,
              runtimeId: input.runtimeId,
              sessionId: session.id,
              teamId: input.teamId,
            },
          });
        }
        return session;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async failOpen(
    sessionId: string,
    error: Prisma.JsonValue | null | undefined,
  ) {
    await this.prisma.$transaction([
      this.prisma.browserRuntimeSession.update({
        data: {
          lastError: error ? json(error) : json({ code: "OPEN_FAILED" }),
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

  private async expireSlots(runtimeId: string) {
    const expired = await this.prisma.browserRuntimeSlot.findMany({
      select: { sessionId: true },
      where: { expiresAt: { lte: new Date() }, runtimeId },
    });
    if (expired.length === 0) return;
    const ids = expired.map((item) => item.sessionId);
    await this.prisma.$transaction([
      this.prisma.browserRuntimeSession.updateMany({
        data: {
          lastError: {
            code: "LEASE_EXPIRED",
            message: "Runtime session lease expired.",
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

  private lease(
    runnerId: string,
    session: {
      fencingToken: bigint;
      id: string;
      leaseExpiresAt: Date;
    },
    routing?: ExecutionRunnerLease["routing"],
  ): ExecutionRunnerLease {
    return {
      expiresAt: session.leaseExpiresAt,
      fencingToken: session.fencingToken.toString(),
      leaseId: session.id,
      runnerId,
      runnerKind: this.kind,
      ...(routing ? { routing } : {}),
    };
  }
}
