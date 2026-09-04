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
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import {
  quarantineSession,
  releaseVerifiedSessionResources,
} from "../runtime/session-resource-cleanup.js";
import {
  concurrencyPolicy,
  ExecutionAdmissionBlocked,
  executionTarget,
  resourceClaims,
  resourcesConflict,
} from "./execution-concurrency.js";
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
  hostnameMatchesPattern,
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
  attempts: BrowserVideoFinalizationAttempt[];
  code: string;
  durationMs: number | null;
  message: string;
  runtimeVersion: string | null;
  stepFrameCount: number;
  type: "VIDEO_FINALIZATION";
}

export interface BrowserVideoFinalizationAttempt {
  code: string;
  durationMs: number;
  maxHeight?: number;
  maxWidth?: number;
  message: string;
  profile: "native" | "compatibility";
  videoBitsPerSecond?: number;
}

function nonNegativeInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= maximum &&
    Number.isSafeInteger(value)
    ? value
    : null;
}

function positiveInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const parsed = nonNegativeInteger(value, maximum);
  return parsed !== null && parsed > 0 ? parsed : undefined;
}

function videoFinalizationAttempts(
  videoError: Record<string, unknown>,
): BrowserVideoFinalizationAttempt[] {
  const details = record(videoError.details);
  if (!Array.isArray(details.attempts)) return [];
  return details.attempts.slice(0, 4).flatMap((value) => {
    const attempt = record(value);
    if (
      typeof attempt.code !== "string" ||
      typeof attempt.message !== "string" ||
      !["native", "compatibility"].includes(String(attempt.profile))
    ) {
      return [];
    }
    const durationMs = nonNegativeInteger(attempt.durationMs, 300_000);
    if (durationMs === null) return [];
    const maxHeight = positiveInteger(attempt.maxHeight, 16_384);
    const maxWidth = positiveInteger(attempt.maxWidth, 16_384);
    const videoBitsPerSecond = positiveInteger(
      attempt.videoBitsPerSecond,
      100_000_000,
    );
    return [
      {
        code: attempt.code.slice(0, 80),
        durationMs,
        ...(maxHeight ? { maxHeight } : {}),
        ...(maxWidth ? { maxWidth } : {}),
        message: attempt.message.slice(0, 500),
        profile: attempt.profile as "native" | "compatibility",
        ...(videoBitsPerSecond ? { videoBitsPerSecond } : {}),
      },
    ];
  });
}

export function browserVideoFinalizationFailure(
  command: {
    result: unknown;
    status: string;
  } | null,
): BrowserVideoFinalizationFailure | null {
  if (!command || command.status !== "SUCCEEDED") return null;
  const result = record(command.result);
  const stepFrameCount = positiveInteger(result.stepFrameCount, 120) ?? 0;
  if (result.videoCreated !== false || stepFrameCount === 0) return null;
  const videoError = record(result.videoError);
  return {
    attempts: videoFinalizationAttempts(videoError),
    code:
      typeof videoError.code === "string"
        ? videoError.code.slice(0, 80)
        : "VIDEO_COMPOSITION_FAILED",
    durationMs: nonNegativeInteger(result.videoFinalizationDurationMs, 300_000),
    message:
      typeof videoError.message === "string"
        ? videoError.message.slice(0, 500)
        : "Browser Runtime closed without creating the step video.",
    runtimeVersion:
      typeof result.videoRuntimeVersion === "string"
        ? result.videoRuntimeVersion.slice(0, 64)
        : null,
    stepFrameCount,
    type: "VIDEO_FINALIZATION",
  };
}

class RuntimeCapacityExhaustedError extends Error {}

export interface BrowserExecutionOwner {
  taskId: string;
  fencingToken: string;
  leaseToken: string;
  workerId: string;
  expiresAt: Date;
}

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
            targetUrl: request.execution.targetUrl,
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
    expectedAllocationToken?: string,
  ): Promise<ExecutionRunnerLease> {
    let execution = await this.ownedBrowserExecution(
      teamId,
      browserExecutionId,
    );
    if (
      expectedAllocationToken &&
      execution.allocationToken !== expectedAllocationToken
    )
      throw new ExecutionAdmissionBlocked(
        "ADMISSION_STALE",
        "A newer admission worker owns this allocation.",
      );
    if (execution.runtimeSessionId) {
      const session = await this.prisma.browserRuntimeSession.findUnique({
        where: { id: execution.runtimeSessionId },
      });
      if (
        session &&
        ["ACTIVE", "HUMAN_CONTROL"].includes(session.status) &&
        session.leaseExpiresAt > new Date() &&
        session.executionPermitExpiresAt &&
        session.executionPermitExpiresAt > new Date() &&
        !session.quarantinedAt &&
        !session.closureVerifiedAt
      )
        return this.lease(session.runtimeId, session);
      if (
        session &&
        session.status === "OPENING" &&
        session.leaseExpiresAt > new Date()
      )
        throw new ExecutionAdmissionBlocked(
          "ADMISSION_STALE",
          "This Attempt's browser is still opening.",
        );
      if (session && !session.closureVerifiedAt)
        throw new ExecutionAdmissionBlocked(
          "LEASE_RECOVERY",
          "The previous browser must be confirmed closed before allocation.",
        );
      if (session?.ownerTaskId)
        throw new ExecutionAdmissionBlocked(
          "LEASE_RECOVERY",
          "An execution that has started must recover through a new Attempt after its browser closes.",
        );
      // A failed startup may reopen only once. Runtime/Agent recovery after a
      // claim must create a new Attempt, never replay the started Attempt here.
      await this.prisma.$transaction(async (tx) => {
        const task = await tx.agentRuntimeTask.findUnique({
          where: { attemptId: execution.attemptId },
        });
        if (task) {
          const unstarted = await tx.agentRuntimeTask.updateMany({
            where: {
              id: task.id,
              status: "PENDING",
              startedAt: null,
              fencingToken: 0n,
              OR: [
                { recoveryStatus: null },
                { recoveryStatus: { not: "STARTUP_CLOSING" } },
              ],
            },
            data: { recoveryStatus: task.recoveryStatus },
          });
          if (unstarted.count !== 1)
            throw new ExecutionAdmissionBlocked(
              "LEASE_RECOVERY",
              "A started Attempt cannot reopen its browser.",
            );
        }
        const current = await tx.browserExecution.findUniqueOrThrow({
          where: { id: execution.id },
        });
        if (current.startupRecoveryCount >= 1)
          throw new ExecutionRunnerUnavailableError(
            "SESSION_OPEN_FAILED",
            "Browser startup recovery was exhausted.",
            "FAIL_FAST",
          );
        const cleared = await tx.browserExecution.updateMany({
          where: {
            id: execution.id,
            runtimeSessionId: execution.runtimeSessionId,
            startupRecoveryCount: 0,
            ...(expectedAllocationToken
              ? { allocationToken: expectedAllocationToken }
              : {}),
            runtimeSession: {
              is: { ownerTaskId: null, closureVerifiedAt: { not: null } },
            },
          },
          data: {
            runtimeSessionId: null,
            startupRecoveryCount: { increment: 1 },
          },
        });
        if (cleared.count !== 1)
          throw new ExecutionAdmissionBlocked(
            "ADMISSION_STALE",
            "A newer worker changed startup recovery.",
          );
      });
      execution = await this.ownedBrowserExecution(teamId, browserExecutionId);
    }

    let profileMode = request.execution.profile.mode;
    const requestedProfileKey = request.execution.profile.key;
    let profileKey =
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
    const isolated = userProfile?.executionMode === "ISOLATED_AUTH";
    if (isolated && process.env.BROWSER_ISOLATED_AUTH_ENABLED !== "true")
      throw new ExecutionAdmissionBlocked(
        "AUTH_REQUIRED",
        "Isolated authenticated execution is disabled for this deployment.",
      );
    if (isolated && !userProfile.authSnapshotGeneration)
      throw new ExecutionAdmissionBlocked(
        "AUTH_REQUIRED",
        "Prepare and verify a compatible authentication snapshot first.",
      );
    const authSnapshot =
      isolated && userProfile.authSnapshotGeneration
        ? {
            profileKey: userProfile.runtimeProfileKey,
            generation: userProfile.authSnapshotGeneration,
          }
        : undefined;
    if (isolated) {
      profileMode = "EPHEMERAL";
      profileKey = `execution-${execution.attemptId.replaceAll("-", "")}`;
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
      if (userProfile && (runtime.protocolMinor ?? 0) < (isolated ? 13 : 9))
        continue;
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
            browserExecutionId,
            allocationToken: execution.allocationToken,
            targetUrl: request.execution.targetUrl,
            ...(authSnapshot
              ? { authSnapshotGeneration: authSnapshot.generation }
              : {}),
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
          ...(authSnapshot ? { authSnapshot } : {}),
          ...(userProfile && !isolated
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
      await this.prisma.$transaction(async (tx) => {
        const activated = await tx.browserRuntimeSession.updateMany({
          data: { openedAt: now, status: "ACTIVE" },
          where: {
            id: session.id,
            status: "OPENING",
            leaseExpiresAt: { gt: now },
          },
        });
        if (activated.count !== 1)
          throw new ExecutionAdmissionBlocked(
            "LEASE_RECOVERY",
            "The browser open acknowledgment arrived after its session was revoked.",
          );
        const bound = await tx.browserExecution.updateMany({
          data: {
            error: Prisma.JsonNull,
            runtimeSessionId: session.id,
            startedAt: execution.startedAt ?? now,
            status: "ACTIVE",
          },
          where: {
            id: browserExecutionId,
            runtimeSessionId: session.id,
            allocationToken: execution.allocationToken,
            status: { in: ["REQUESTED", "WAITING_CAPACITY", "ALLOCATING"] },
            run: {
              cancelRequestedAt: null,
              deadlineAt: { gt: now },
              lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
            },
          },
        });
        if (bound.count !== 1)
          throw new ExecutionAdmissionBlocked(
            "ADMISSION_STALE",
            "This allocation was superseded before its open acknowledgment arrived.",
          );
        await tx.runEvent.create({
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
        });
        await tx.taskCaseExecution.updateMany({
          where: { runId: execution.runId },
          data: {
            scheduling: json({
              state: "ADMITTED",
              reason: "AGENT_CAPACITY",
              waitingSince: (
                execution.waitingSince ?? execution.createdAt
              ).toISOString(),
              evaluatedAt: now.toISOString(),
              blockedBy: null,
              queue: null,
              nextRetryAt: null,
            }),
          },
        });
        if (execution.run.taskExecutionId)
          await tx.taskExecution.updateMany({
            where: { id: execution.run.taskExecutionId },
            data: { projectionNeededAt: now },
          });
        if (userProfile)
          await tx.userBrowserProfile.update({
            data: {
              assignedRuntimeId: runtime.id,
              inactivityExpiresAt: new Date(
                now.getTime() + 30 * 24 * 60 * 60 * 1_000,
              ),
              lastUsedAt: now,
            },
            where: { id: userProfile.id },
          });
      });
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
      const changed = await tx.browserExecution.updateMany({
        data: {
          error: json({
            code: unavailableReason,
            message: messages[unavailableReason],
          }),
          status: "WAITING_CAPACITY",
        },
        where: {
          id: browserExecutionId,
          allocationToken: execution.allocationToken,
          status: { in: ["REQUESTED", "ALLOCATING", "WAITING_CAPACITY"] },
          run: {
            cancelRequestedAt: null,
            lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
          },
        },
      });
      if (changed.count !== 1) return;
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
    owner?: BrowserExecutionOwner,
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
    if (
      owner &&
      (session.ownerTaskId !== owner.taskId ||
        session.ownerFencingToken?.toString() !== owner.fencingToken ||
        !session.executionPermitExpiresAt ||
        session.executionPermitExpiresAt <= new Date())
    )
      throw new ConflictException({
        code: "LEASE_LOST",
        message: "Browser execution ownership is stale.",
      });
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
      ...(owner ? { owner } : {}),
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
      ownerFencingToken: command.ownerFencingToken?.toString() ?? null,
    };
  }

  async releaseForExecutionRun(
    teamId: string,
    browserExecutionId: string,
    owner?: BrowserExecutionOwner,
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
    if (!session || session.status === "CLOSED" || session.closureVerifiedAt) {
      await this.prisma.$transaction(async (tx) => {
        if (session) await releaseVerifiedSessionResources(tx, session.id);
        await tx.browserExecution.update({
          data: { finishedAt: new Date(), status: "RELEASED" },
          where: { id: execution.id },
        });
      });
      return;
    }
    if (
      owner &&
      (session.ownerTaskId !== owner.taskId ||
        session.ownerFencingToken?.toString() !== owner.fencingToken ||
        !session.executionPermitExpiresAt ||
        session.executionPermitExpiresAt <= new Date())
    )
      throw new ConflictException({
        code: "LEASE_LOST",
        message: "A stale Agent cannot release this browser.",
      });
    const claimed = await this.prisma.browserRuntimeSession.updateMany({
      data: { status: "CLOSING" },
      where: {
        id: session.id,
        status: {
          in: [
            "OPENING",
            "ACTIVE",
            "HUMAN_CONTROL",
            "LOST",
            "FAILED",
            "CLOSING",
          ],
        },
        ...(owner
          ? {
              ownerTaskId: owner.taskId,
              ownerFencingToken: BigInt(owner.fencingToken),
            }
          : {}),
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
      ...(owner ? { owner } : {}),
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
          closedAt: released ? now : null,
          closureVerifiedAt: released ? now : null,
          quarantinedAt: released ? null : now,
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
      this.prisma.browserExecution.update({
        data: {
          error: released
            ? Prisma.JsonNull
            : json(closed?.error ?? { code: "CLOSE_FAILED" }),
          finishedAt: now,
          // Retain a retryable state until all verified resources are cleaned up.
          status: released ? "RELEASING" : "LOST",
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
    if (released)
      await this.prisma.$transaction(async (tx) => {
        await releaseVerifiedSessionResources(tx, session.id);
        await tx.browserExecution.update({
          data: { finishedAt: now, status: "RELEASED" },
          where: { id: execution.id },
        });
      });
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
      ownerFencingToken: command.ownerFencingToken?.toString() ?? null,
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
    if (
      !session ||
      session.status === "CLOSED" ||
      !!session.closureVerifiedAt
    ) {
      return;
    }
    const claimed = await this.prisma.browserRuntimeSession.updateMany({
      data: { status: "CLOSING" },
      where: {
        id: session.id,
        status: {
          in: [
            "OPENING",
            "ACTIVE",
            "HUMAN_CONTROL",
            "LOST",
            "CLOSING",
            "FAILED",
          ],
        },
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
          closedAt: released ? new Date() : null,
          closureVerifiedAt: released ? new Date() : null,
          quarantinedAt: released ? null : new Date(),
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
    ]);
    if (released)
      await this.prisma.$transaction((tx) =>
        releaseVerifiedSessionResources(tx, session.id),
      );
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
      await this.prisma.$transaction(async (tx) => {
        if (!purged) {
          await quarantineSession(tx, session.id, "PURGE_UNCONFIRMED");
          return;
        }
        await tx.browserRuntimeSession.update({
          data: {
            closedAt: new Date(),
            closureVerifiedAt: new Date(),
            status: "CLOSED",
          },
          where: { id: session.id },
        });
        await releaseVerifiedSessionResources(tx, session.id);
      });
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
    browserExecutionId?: string;
    allocationToken?: string | null;
    authSnapshotGeneration?: number;
    targetUrl?: string | undefined;
  }) {
    return this.prisma.$transaction(
      async (tx) => {
        // One brief coordinator protects hierarchical roots, including UNKNOWN
        // work without a target. No browser/network operation runs under it.
        await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
        if (input.userBrowserProfileId)
          await acquireAdvisoryTransactionLock(
            tx,
            `browser-profile:${input.userBrowserProfileId}`,
          );
        await acquireAdvisoryTransactionLock(
          tx,
          `browser-runtime:${input.runtimeId}`,
        );
        const execution = input.browserExecutionId
          ? await tx.browserExecution.findUniqueOrThrow({
              where: { id: input.browserExecutionId },
              include: {
                run: {
                  include: {
                    taskCaseExecution: true,
                    taskExecution: { include: { profileBinding: true } },
                  },
                },
              },
            })
          : null;
        if (
          execution &&
          (execution.runtimeSessionId ||
            execution.allocationToken !== (input.allocationToken ?? null) ||
            !["REQUESTED", "WAITING_CAPACITY", "ALLOCATING"].includes(
              execution.status,
            ) ||
            execution.run.cancelRequestedAt ||
            execution.run.deadlineAt <= new Date() ||
            !["QUEUED", "PREPARING", "RUNNING"].includes(
              execution.run.lifecycle,
            ))
        ) {
          throw new ExecutionAdmissionBlocked(
            "ADMISSION_STALE",
            "This Attempt has already been allocated or is no longer runnable.",
          );
        }
        const policy = concurrencyPolicy(execution?.run.concurrencyPolicy);
        const dependencies = policy.dependsOnCaseIds ?? [];
        if (dependencies.length) {
          const current = execution?.run.taskCaseExecution;
          if (!current)
            throw new ExecutionAdmissionBlocked(
              "CASE_DEPENDENCY",
              "Case dependencies require a Task execution unit.",
            );
          const predecessors = await tx.taskCaseExecution.findMany({
            where: {
              taskExecutionId: current.taskExecutionId,
              deploymentId: current.deploymentId,
              caseId: { in: dependencies },
            },
            orderBy: { executionOrdinal: "desc" },
            include: { run: { select: { lifecycle: true, verdict: true } } },
          });
          const latest = new Map<string, (typeof predecessors)[number]>();
          for (const predecessor of predecessors)
            if (!latest.has(predecessor.caseId))
              latest.set(predecessor.caseId, predecessor);
          if (
            dependencies.some(
              (id) =>
                latest.get(id)?.run?.lifecycle !== "COMPLETED" ||
                latest.get(id)?.run?.verdict !== "PASSED",
            )
          )
            throw new ExecutionAdmissionBlocked(
              "CASE_DEPENDENCY",
              "Required Cases have not completed successfully.",
            );
        }
        let identityPermit: number | undefined;
        if (input.userBrowserProfileId) {
          const profile = await tx.userBrowserProfile.findUniqueOrThrow({
            where: { id: input.userBrowserProfileId },
            include: {
              grants: { where: { revokedAt: null } },
              owner: { include: { memberships: true } },
            },
          });
          const source =
            execution?.run.taskExecution?.profileBinding?.triggerSource;
          const target = input.targetUrl
            ? new URL(input.targetUrl).hostname
            : null;
          if (
            input.purpose !== "PROFILE_PURGE" &&
            (profile.teamId !== input.teamId ||
              profile.status !== "READY" ||
              !profile.inactivityExpiresAt ||
              profile.inactivityExpiresAt <= new Date() ||
              profile.owner.status !== "ACTIVE" ||
              !profile.owner.memberships.some(
                (member) => member.teamId === input.teamId,
              ) ||
              !source ||
              !target ||
              !profile.grants.some(
                (grant) =>
                  grant.triggerSource === source &&
                  hostnameMatchesPattern(target, grant.hostnamePattern),
              ))
          ) {
            throw new ExecutionAdmissionBlocked(
              "AUTH_REQUIRED",
              "Browser identity authorization changed before admission.",
            );
          }
          if (input.purpose === "PROFILE_PURGE") {
            if (
              profile.teamId !== input.teamId ||
              (await tx.browserRuntimeSession.count({
                where: {
                  userBrowserProfileId: profile.id,
                  closureVerifiedAt: null,
                  status: { not: "CLOSED" },
                },
              }))
            )
              throw new ExecutionAdmissionBlocked(
                "AUTH_REFRESH",
                "All sessions for this login identity must be verified closed before purge.",
              );
          }
          if (input.authSnapshotGeneration !== undefined) {
            if (
              profile.executionMode !== "ISOLATED_AUTH" ||
              profile.authSnapshotGeneration !== input.authSnapshotGeneration ||
              profile.assignedRuntimeId !== input.runtimeId
            )
              throw new ExecutionAdmissionBlocked(
                "AUTH_REFRESH",
                "The authentication snapshot changed before admission.",
              );
            const holders = await tx.browserRuntimeSession.findMany({
              where: {
                userBrowserProfileId: profile.id,
                OR: [
                  { identityPermit: { not: null } },
                  { closureVerifiedAt: null, status: { not: "CLOSED" } },
                ],
              },
              select: { identityPermit: true, purpose: true },
            });
            if (holders.some((holder) => holder.purpose !== "EXECUTION"))
              throw new ExecutionAdmissionBlocked(
                "AUTH_REFRESH",
                "Browser identity maintenance is in progress.",
              );
            const used = new Set(
              holders.map((holder) => holder.identityPermit),
            );
            for (
              let permit = 0;
              permit < profile.executionConcurrency;
              permit++
            )
              if (!used.has(permit)) {
                identityPermit = permit;
                break;
              }
            if (
              identityPermit === undefined ||
              holders.length >= profile.executionConcurrency
            )
              throw new ExecutionAdmissionBlocked(
                "IDENTITY_CAPACITY",
                "All concurrency permits for this login identity are occupied.",
              );
          }
        }
        const claims =
          input.purpose === "PROFILE_PURGE"
            ? []
            : resourceClaims(input.targetUrl, execution?.run.concurrencyPolicy);
        const existingLeases = claims.length
          ? await tx.executionResourceLease.findMany({
              where: claims.some((claim) => claim.rootKey === "*")
                ? {}
                : {
                    rootKey: {
                      in: [...claims.map((claim) => claim.rootKey), "*"],
                    },
                  },
              include: {
                session: {
                  select: {
                    id: true,
                    teamId: true,
                    browserExecutions: {
                      select: {
                        runId: true,
                        run: { select: { taskExecutionId: true } },
                      },
                      take: 1,
                    },
                  },
                },
              },
            })
          : [];
        const blocker = existingLeases.find((lease) =>
          claims.some((claim) =>
            resourcesConflict(claim, {
              ...lease,
              mode: lease.quarantined
                ? "WRITE"
                : (lease.mode as "READ" | "WRITE"),
            }),
          ),
        );
        if (blocker) {
          const owner = blocker.session.browserExecutions[0];
          throw new ExecutionAdmissionBlocked(
            blocker.quarantined ? "LEASE_RECOVERY" : "DATA_LOCK",
            blocker.quarantined
              ? "A previous write has an unknown outcome and requires review."
              : "Another execution holds a conflicting business-data lock.",
            {
              resourceType: "DATA",
              ...(blocker.session.teamId === input.teamId
                ? {
                    sessionId: blocker.sessionId,
                    ...(owner
                      ? {
                          runId: owner.runId,
                          ...(owner.run.taskExecutionId
                            ? { taskId: owner.run.taskExecutionId }
                            : {}),
                        }
                      : {}),
                  }
                : {}),
            },
          );
        }
        // Pre-upgrade/direct sessions without data leases cannot bypass new
        // readers. Unknown destinations conservatively conflict with all roots.
        if (claims.length) {
          const legacy = await tx.browserRuntimeSession.findMany({
            where: {
              purpose: "EXECUTION",
              closureVerifiedAt: null,
              status: { not: "CLOSED" },
              resourceLeases: { none: {} },
            },
            include: {
              browserExecutions: {
                include: { run: { select: { environmentSnapshot: true } } },
                take: 1,
              },
              verificationRuns: { select: { requestSnapshot: true }, take: 1 },
            },
          });
          for (const holder of legacy) {
            const bound = holder.browserExecutions[0];
            const oldRequest = record(
              holder.verificationRuns[0]?.requestSnapshot ?? null,
            );
            const target = bound
              ? executionTarget(bound.input, bound.run.environmentSnapshot)
              : executionTarget(oldRequest.execution);
            if (
              resourceClaims(target, null).some((lease) =>
                claims.some((claim) => resourcesConflict(claim, lease)),
              )
            )
              throw new ExecutionAdmissionBlocked(
                "DATA_LOCK",
                "A legacy execution must drain before this business environment can run concurrently.",
                {
                  resourceType: "DATA",
                  ...(holder.teamId === input.teamId
                    ? { sessionId: holder.id }
                    : {}),
                },
              );
          }
        }
        // Only recently evaluated data waiters receive writer preference.
        // Authentication, dependency or offline-runtime waits must not block
        // compatible work on another identity/runtime in the same environment.
        if (execution && claims.length) {
          const ahead = await tx.browserExecution.findMany({
            where: {
              id: { not: execution.id },
              createdAt: { lte: execution.createdAt },
              runtimeSessionId: null,
              status: { in: ["WAITING_CAPACITY", "ALLOCATING"] },
              error: { path: ["code"], equals: "DATA_LOCK" },
              updatedAt: { gte: new Date(Date.now() - 10_000) },
              run: {
                cancelRequestedAt: null,
                deadlineAt: { gt: new Date() },
                lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING"] },
              },
            },
            include: {
              run: {
                select: {
                  concurrencyPolicy: true,
                  environmentSnapshot: true,
                  teamId: true,
                },
              },
            },
          });
          const earlierWriter = ahead.find(
            (item) =>
              (item.createdAt < execution.createdAt ||
                item.id < execution.id) &&
              resourceClaims(
                executionTarget(item.input, item.run.environmentSnapshot),
                item.run.concurrencyPolicy,
              ).some(
                (claim) =>
                  claim.mode === "WRITE" &&
                  claims.some((requested) =>
                    resourcesConflict(requested, claim),
                  ),
              ),
          );
          if (earlierWriter)
            throw new ExecutionAdmissionBlocked(
              "DATA_LOCK",
              "An earlier conflicting writer is waiting for admission.",
              {
                resourceType: "DATA",
                ...(earlierWriter.run.teamId === input.teamId
                  ? { runId: earlierWriter.runId }
                  : {}),
              },
            );
        }
        const runtime = await tx.browserRuntime.findUniqueOrThrow({
          where: { id: input.runtimeId },
        });
        const occupied = await tx.browserRuntimeSlot.count({
          where: {
            runtimeId: input.runtimeId,
          },
        });
        if (!runtime.enabled || runtime.revokedAt)
          throw new ExecutionAdmissionBlocked(
            "NO_MATCHING_RUNNER",
            "The selected Browser Runtime was disabled before admission.",
          );
        if (
          occupied >= runtime.maxConcurrency ||
          input.slotNumber >= runtime.maxConcurrency
        ) {
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
            ...(input.authSnapshotGeneration === undefined
              ? {}
              : {
                  authSnapshotGeneration: input.authSnapshotGeneration,
                  identityPermit: identityPermit ?? null,
                }),
            executionPermitExpiresAt: new Date(
              Math.min(input.leaseExpiresAt.getTime(), Date.now() + 120_000),
            ),
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
        if (claims.length)
          await tx.executionResourceLease.createMany({
            data: claims.map((claim) => ({ ...claim, sessionId: session.id })),
          });
        if (execution) {
          const linked = await tx.browserExecution.updateMany({
            where: {
              id: execution.id,
              runtimeSessionId: null,
              allocationToken: input.allocationToken ?? null,
            },
            data: { runtimeSessionId: session.id },
          });
          if (linked.count !== 1)
            throw new ExecutionAdmissionBlocked(
              "ADMISSION_STALE",
              "This allocation was superseded before it could be bound.",
            );
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
    await this.prisma.$transaction((tx) =>
      quarantineSession(tx, sessionId, "OPEN_UNCONFIRMED"),
    );
    const closed = await this.commands
      .execute({
        commandType: "session.close",
        sessionId,
        source: "SYSTEM",
        timeoutSeconds: 15,
      })
      .catch(() => null);
    if (closed?.status !== "SUCCEEDED") return;
    await this.prisma.$transaction(async (tx) => {
      await tx.browserRuntimeSession.updateMany({
        where: {
          id: sessionId,
          status: { in: ["LOST", "OPENING", "CLOSING"] },
        },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          closureVerifiedAt: new Date(),
          lastError: error ?? { code: "OPEN_FAILED" },
        },
      });
      await releaseVerifiedSessionResources(tx, sessionId);
    });
  }

  private async expireSlots(runtimeId: string) {
    const expired = await this.prisma.browserRuntimeSlot.findMany({
      select: { sessionId: true },
      where: { expiresAt: { lte: new Date() }, runtimeId },
    });
    for (const item of expired)
      await this.prisma.$transaction(async (tx) => {
        if (!(await releaseVerifiedSessionResources(tx, item.sessionId)))
          await quarantineSession(tx, item.sessionId, "LEASE_EXPIRED");
      });
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
