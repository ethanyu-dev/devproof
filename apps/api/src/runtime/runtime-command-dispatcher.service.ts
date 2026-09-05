import { randomUUID } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  RUNTIME_MAX_ARTIFACT_BYTES,
  type RuntimeCommandResult,
  type RuntimeCommandType,
} from "@devproof/runtime-protocol";
import type { z } from "zod";
import {
  runtimeEventSchema,
  runtimeClosureEvidenceSchema,
} from "@devproof/runtime-protocol";

import { env } from "../config/env.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { PrismaService } from "../database/prisma.service.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import { RuntimeConnectionHub } from "./runtime-connection-hub.service.js";
import { MetricsService } from "../observability/metrics.service.js";
import { ObservabilityService } from "../observability/observability.service.js";
import { sessionExecutionPermit } from "./session-permit.js";
import { quarantineSession } from "./session-resource-cleanup.js";
import { SessionClosureService } from "./session-closure.service.js";
import { SessionRecoveryService } from "./session-recovery.service.js";
import type { AuthenticatedRuntimeContext } from "./session-closure.types.js";
import { lockRuntimeAndSession } from "./session-recovery.state.js";

type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

const TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

@Injectable()
export class RuntimeCommandDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hub: RuntimeConnectionHub,
    private readonly storage: ObjectStorageService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly observability?: ObservabilityService,
    @Optional() private readonly closure?: SessionClosureService,
    @Optional() private readonly recovery?: SessionRecoveryService,
  ) {}

  async execute(input: {
    commandType: RuntimeCommandType;
    payload?: Record<string, unknown>;
    sessionId: string;
    signal?: AbortSignal;
    source: "SYSTEM" | "AGENT" | "CONSOLE" | "HUMAN";
    timeoutSeconds?: number;
    commandId?: string;
    owner?: {
      taskId: string;
      fencingToken: string;
      leaseToken: string;
      workerId: string;
      expiresAt: Date;
    };
  }) {
    const session = await this.prisma.browserRuntimeSession.findUnique({
      where: { id: input.sessionId },
    });
    if (!session) {
      throw new NotFoundException("Runtime session was not found.");
    }
    if (
      session.purpose === "PROFILE_PURGE" &&
      !["profile.purge", "session.close"].includes(input.commandType)
    )
      throw new ConflictException(
        "A purge allocation cannot launch or operate a browser.",
      );
    if (
      input.commandType === "session.close" &&
      !env().RUNTIME_SESSION_RECOVERY_ENABLED
    )
      throw new ConflictException({
        code: "SESSION_RECOVERY_DISABLED",
        message: "Verified session recovery is paused for deployment.",
      });
    if (
      ![
        "OPENING",
        "ACTIVE",
        "HUMAN_CONTROL",
        "CLOSING",
        ...(input.commandType === "session.close"
          ? ["LOST", "FAILED", "CLOSED"]
          : []),
      ].includes(session.status)
    ) {
      throw new ConflictException(
        "Runtime session is not able to receive commands.",
      );
    }
    if (
      input.commandType !== "session.close" &&
      session.leaseExpiresAt.getTime() <= Date.now()
    ) {
      throw new ConflictException("Runtime session lease has expired.");
    }

    if (input.owner) await this.requireOwner(input.owner, session);
    const permit =
      input.commandType === "session.close" || session.protocolMinor < 13
        ? null
        : await sessionExecutionPermit(
            this.prisma as unknown as Prisma.TransactionClient,
            session,
            new Date(),
          );
    if (
      session.protocolMinor >= 13 &&
      input.commandType !== "session.close" &&
      !permit
    )
      throw new ConflictException("Runtime execution permission expired.");

    const timeoutSeconds =
      input.timeoutSeconds ?? env().RUNTIME_COMMAND_TIMEOUT_SECONDS;
    let commandId = input.commandId ?? randomUUID();
    let command = input.commandId
      ? await this.prisma.browserRuntimeCommand.findUnique({
          where: { id: commandId },
        })
      : null;
    if (
      command &&
      (command.sessionId !== session.id ||
        command.commandType !== input.commandType ||
        command.leaseToken !== session.leaseToken ||
        command.fencingToken !== session.fencingToken)
    )
      throw new ConflictException(
        "The persisted command belongs to a different session epoch.",
      );
    if (!command) {
      const payload = { ...(input.payload ?? {}) };
      if (input.commandType === "session.close") {
        if (!this.recovery)
          throw new ConflictException("Session recovery is unavailable.");
        const recovery = await this.recovery.prepareClose(
          session.id,
          commandId,
        );
        commandId = recovery.requestId;
        command = await this.prisma.browserRuntimeCommand.findUniqueOrThrow({
          where: { id: commandId },
        });
      }
      if (!command)
        command = await this.prisma.browserRuntimeCommand.create({
          data: {
            id: commandId,
            commandType: input.commandType,
            deadlineAt: new Date(Date.now() + timeoutSeconds * 1000),
            fencingToken: session.fencingToken,
            leaseToken: session.leaseToken,
            payload: asJson(payload),
            sessionId: session.id,
            source: input.source,
            ...(input.owner
              ? {
                  ownerTaskId: input.owner.taskId,
                  ownerFencingToken: BigInt(input.owner.fencingToken),
                  ownerPermitExpiresAt: input.owner.expiresAt,
                }
              : {}),
          },
        });
    }
    if (TERMINAL_STATUSES.has(command.status))
      return this.prisma.browserRuntimeCommand.findUnique({
        where: { id: command.id },
        include: { artifacts: true },
      });
    const deadlineAt = command.deadlineAt;
    if (deadlineAt <= new Date())
      return this.waitForCompletion(command.id, deadlineAt, input.signal);
    const runtime = await this.prisma.browserRuntime.findUnique({
      where: { id: session.runtimeId },
    });
    if (!runtime || !runtime.enabled || runtime.revokedAt)
      throw new ConflictException(
        "Runtime is unavailable or its credential was revoked.",
      );
    if (input.commandType === "session.open") {
      const persistedCommandId = command.id;
      command = await this.prisma.$transaction(async (tx) => {
        await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
        await lockRuntimeAndSession(tx, session.runtimeId, session.id);
        const currentRuntime = await tx.browserRuntime.findUniqueOrThrow({
          where: { id: session.runtimeId },
        });
        const currentSession = await tx.browserRuntimeSession.findUniqueOrThrow(
          { where: { id: session.id } },
        );
        if (
          !currentRuntime.enabled ||
          currentRuntime.revokedAt ||
          currentRuntime.connectionGeneration !==
            runtime.connectionGeneration ||
          currentSession.status !== "OPENING" ||
          currentSession.closureVerifiedAt ||
          currentSession.quarantinedAt ||
          currentSession.leaseExpiresAt <= new Date() ||
          currentSession.leaseToken !== session.leaseToken ||
          currentSession.fencingToken !== session.fencingToken
        )
          throw new ConflictException(
            "Runtime or session ownership changed before browser launch.",
          );
        const persisted = await tx.browserRuntimeCommand.findUniqueOrThrow({
          where: { id: persistedCommandId },
        });
        const payload = record(persisted.payload);
        const canIdentify =
          (currentRuntime.protocolMinor ?? 0) >= 14 &&
          Array.isArray(currentRuntime.capabilities) &&
          currentRuntime.capabilities.includes("closure-evidence-v1") &&
          currentRuntime.hostInstanceId;
        if (canIdentify) {
          if (
            currentSession.launchHostInstanceId &&
            currentSession.launchHostInstanceId !==
              currentRuntime.hostInstanceId
          )
            throw new ConflictException(
              "The registered browser launch belongs to another Runtime host.",
            );
          // Register the exact launch identity before network delivery. An OPEN
          // result can be lost after Chromium starts, including across a crash.
          const identity = record(currentSession.launchIdentity);
          const launchIdentityId =
            typeof identity.id === "string" ? identity.id : randomUUID();
          if (
            payload.launchIdentityId &&
            payload.launchIdentityId !== launchIdentityId
          )
            throw new ConflictException(
              "The command belongs to a different browser launch.",
            );
          payload.launchIdentityId = launchIdentityId;
          await tx.browserRuntimeSession.update({
            where: { id: session.id },
            data: {
              launchIdentity: asJson({
                ...identity,
                version: 1,
                id: launchIdentityId,
              }),
              launchIdentityVersion: 1,
              launchConnectionGeneration:
                currentSession.launchConnectionGeneration ??
                currentRuntime.connectionGeneration,
              launchHostInstanceId:
                currentSession.launchHostInstanceId ??
                currentRuntime.hostInstanceId,
            },
          });
        } else if (payload.launchIdentityId) {
          throw new ConflictException(
            "This Runtime connection cannot recover the registered browser launch.",
          );
        }
        return tx.browserRuntimeCommand.update({
          where: { id: persisted.id },
          data: { payload: asJson(payload) },
        });
      });
    }

    // Recheck immediately before dispatch; expired epochs never gain a fresh permit.
    if (input.owner) await this.requireOwner(input.owner, session);

    await this.hub.send(
      session.runtimeId,
      {
        commandId: command.id,
        commandType: input.commandType,
        deadlineAt: deadlineAt.toISOString(),
        fencingToken: session.fencingToken.toString(),
        leaseToken: session.leaseToken,
        payload: record(command.payload),
        sessionId: session.id,
        type: "command.execute",
        ...(permit ? { permit } : {}),
        ...(input.owner
          ? {
              ownerTaskId: input.owner.taskId,
              ownerFencingToken: input.owner.fencingToken,
            }
          : {}),
      },
      runtime.connectionGeneration,
    );
    await this.prisma.browserRuntimeCommand.updateMany({
      data: { dispatchedAt: new Date(), status: "DISPATCHED" },
      where: { id: command.id, status: "PENDING" },
    });

    return this.waitForCompletion(command.id, deadlineAt, input.signal);
  }

  private async requireOwner(
    owner: {
      taskId: string;
      fencingToken: string;
      leaseToken: string;
      workerId: string;
    },
    session: {
      id: string;
      ownerTaskId: string | null;
      ownerFencingToken: bigint | null;
    },
  ) {
    const task = await this.prisma.agentRuntimeTask.findFirst({
      where: {
        id: owner.taskId,
        fencingToken: BigInt(owner.fencingToken),
        leaseOwner: owner.workerId,
        leaseToken: owner.leaseToken,
        leaseExpiresAt: { gt: new Date() },
        status: "RUNNING",
      },
    });
    if (
      !task ||
      session.ownerTaskId !== owner.taskId ||
      session.ownerFencingToken?.toString() !== owner.fencingToken
    )
      throw new ConflictException({
        code: "RUNTIME_LEASE_LOST",
        message: "The Runtime command executor lease is stale.",
      });
  }

  async cancel(commandId: string, reason: string) {
    const command = await this.prisma.browserRuntimeCommand.findUnique({
      include: { session: true },
      where: { id: commandId },
    });
    if (!command) {
      throw new NotFoundException("Runtime command was not found.");
    }
    if (TERMINAL_STATUSES.has(command.status)) {
      return command;
    }
    const claimed = await this.prisma.browserRuntimeCommand.updateMany({
      data: {
        completedAt: new Date(),
        error: asJson({ code: "CANCELLED", message: reason }),
        status: "CANCELLED",
      },
      where: { id: command.id, status: { in: ["PENDING", "DISPATCHED"] } },
    });
    if (claimed.count === 1) {
      this.metrics?.increment(
        "devproof_runtime_command_results_total",
        "Runtime command results by terminal status.",
        { status: "cancelled" },
      );
    }
    await this.hub.send(command.session.runtimeId, {
      commandId,
      reason,
      sessionId: command.sessionId,
      type: "command.cancel",
    });
    return this.prisma.browserRuntimeCommand.findUniqueOrThrow({
      where: { id: command.id },
    });
  }

  async acceptResult(
    result: RuntimeCommandResult,
    context?: AuthenticatedRuntimeContext,
  ) {
    const command = await this.prisma.browserRuntimeCommand.findUnique({
      include: { session: true },
      where: { id: result.commandId },
    });
    if (!command) {
      this.rejectFrame(
        "command_result",
        !command ? "unknown_command" : "terminal_command",
        { commandId: result.commandId },
      );
      return;
    }
    if (!(await this.isCurrentRuntime(context, command.session.runtimeId))) {
      this.rejectFrame("command_result", "runtime_mismatch", {
        commandId: result.commandId,
      });
      return;
    }
    if (
      command.sessionId !== result.sessionId ||
      command.leaseToken !== result.leaseToken ||
      command.fencingToken.toString() !== result.fencingToken ||
      command.session.leaseToken !== result.leaseToken ||
      command.session.fencingToken.toString() !== result.fencingToken ||
      (command.session.protocolMinor >= 13 &&
        command.ownerTaskId &&
        (command.ownerTaskId !== result.ownerTaskId ||
          command.ownerFencingToken?.toString() !== result.ownerFencingToken))
    ) {
      this.rejectFrame("command_result", "lease_mismatch", {
        commandId: result.commandId,
        sessionId: result.sessionId,
      });
      return;
    }
    // Physical closure is monotonic and remains useful after RPC/Agent timeout.
    // Its evidence is independently bound to the command and session epoch.
    if (command.commandType === "session.close" && result.ok) {
      const proof = runtimeClosureEvidenceSchema.safeParse(
        record(result.result).closureEvidence,
      );
      if (proof.success && this.closure && context)
        await this.closure.acceptRuntimeEvidence(context, proof.data);
    }
    if (TERMINAL_STATUSES.has(command.status)) return;
    if (command.ownerTaskId && command.commandType !== "session.close") {
      const owner = await this.prisma.agentRuntimeTask.findUnique({
        where: { id: command.ownerTaskId },
      });
      if (
        !owner ||
        owner.fencingToken !== command.ownerFencingToken ||
        owner.status !== "RUNNING" ||
        !owner.leaseExpiresAt ||
        owner.leaseExpiresAt <= new Date()
      ) {
        this.rejectFrame("command_result", "executor_lease_mismatch", {
          commandId: command.id,
        });
        return;
      }
    }

    const artifacts: Array<{
      byteSize: number;
      contentType: string;
      kind: "SCREENSHOT" | "DOM" | "CONSOLE" | "NETWORK" | "VIDEO";
      metadata: Prisma.InputJsonValue;
      sha256: string;
      storageKey: string;
    }> = [];
    for (const artifact of result.artifacts) {
      const body = Buffer.from(artifact.dataBase64, "base64");
      if (body.byteLength > RUNTIME_MAX_ARTIFACT_BYTES) {
        this.rejectFrame("artifact", "size_limit", {
          commandId: command.id,
          sizeBytes: body.byteLength,
        });
        throw new Error(
          "Runtime artifact exceeds the protocol size limit for command " +
            command.id,
        );
      }
      const storageKey =
        "runtime/" +
        command.session.teamId +
        "/" +
        command.sessionId +
        "/" +
        command.id +
        "/" +
        artifact.kind.toLowerCase() +
        "-" +
        randomUUID();
      // Persist cleanup intent before the external write, including partial batches
      // and process crashes. Publication must consume an unclaimed intent.
      const uploadSignal = AbortSignal.timeout(60_000);
      await this.prisma.objectStorageDeletionTask.create({
        data: { storageKey, nextAttemptAt: new Date(Date.now() + 3_600_000) },
      });
      const stored = await this.storage.put(
        storageKey,
        artifact.contentType,
        body,
        {
          commandId: command.id,
          kind: artifact.kind,
          sessionId: command.sessionId,
        },
        uploadSignal,
      );
      artifacts.push({
        ...stored,
        contentType: artifact.contentType,
        kind: artifact.kind,
        metadata: asJson(artifact.metadata),
        storageKey,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      await lockRuntimeAndSession(
        tx,
        command.session.runtimeId,
        command.sessionId,
      );
      if (
        !context ||
        !(await tx.browserRuntime.findFirst({
          where: {
            id: context.runtimeId,
            connectionId: context.connectionId,
            connectionGeneration: context.connectionGeneration,
            enabled: true,
            revokedAt: null,
          },
        }))
      )
        return;
      // Check the connection before consuming cleanup intent: a reconnect
      // during upload must leave the unpublished object reclaimable.
      for (const artifact of artifacts) {
        await acquireAdvisoryTransactionLock(tx, artifact.storageKey);
        const intent = await tx.objectStorageDeletionTask.deleteMany({
          where: {
            storageKey: artifact.storageKey,
            attempts: 0,
            leaseToken: null,
            nextAttemptAt: { gt: new Date() },
          },
        });
        if (intent.count !== 1)
          throw new ConflictException(
            "Artifact upload intent expired before publication.",
          );
      }
      const claimed = await tx.browserRuntimeCommand.updateMany({
        data: {
          completedAt: new Date(),
          error: result.error ? asJson(result.error) : Prisma.JsonNull,
          result: result.result ? asJson(result.result) : Prisma.JsonNull,
          status: result.ok ? "SUCCEEDED" : "FAILED",
        },
        where: { id: command.id, status: { in: ["PENDING", "DISPATCHED"] } },
      });
      if (claimed.count !== 1) {
        // Roll back intent consumption so retention can reclaim the uploaded objects.
        if (artifacts.length)
          throw new ConflictException(
            "Command result was superseded during artifact upload.",
          );
        return;
      }
      if (command.commandType === "session.open" && result.ok && context) {
        const output = record(result.result);
        const identity = record(output.launchIdentity);
        if (
          identity.version === 1 &&
          typeof identity.id === "string" &&
          identity.id === record(command.payload).launchIdentityId &&
          identity.hostInstanceId === context.hostInstanceId &&
          identity.daemonInstanceId === context.daemonInstanceId
        ) {
          await tx.browserRuntimeSession.updateMany({
            where: {
              id: command.sessionId,
              leaseToken: command.leaseToken,
              fencingToken: command.fencingToken,
              closureVerifiedAt: null,
            },
            data: {
              launchIdentity: asJson(identity),
              launchIdentityVersion: 1,
              launchHostInstanceId: context.hostInstanceId ?? null,
            },
          });
        }
      }
      if (artifacts.length > 0) {
        await tx.browserRuntimeArtifact.createMany({
          data: artifacts.map((artifact) => ({
            ...artifact,
            commandId: command.id,
            sessionId: command.sessionId,
          })),
        });
      }
    });
    this.metrics?.increment(
      "devproof_runtime_command_results_total",
      "Runtime command results by terminal status.",
      { status: result.ok ? "succeeded" : "failed" },
    );
    this.metrics?.observe(
      "devproof_runtime_command_duration_seconds",
      "Runtime command duration from creation to terminal status in seconds.",
      (Date.now() - command.createdAt.getTime()) / 1_000,
      { command_type: command.commandType },
    );
  }

  async acceptEvent(
    event: RuntimeEvent,
    context?: AuthenticatedRuntimeContext,
  ) {
    const session = await this.prisma.browserRuntimeSession.findUnique({
      where: { id: event.sessionId },
    });
    if (
      !session ||
      session.leaseToken !== event.leaseToken ||
      session.fencingToken.toString() !== event.fencingToken
    ) {
      this.rejectFrame("runtime_event", "lease_mismatch", {
        eventId: event.eventId,
        sessionId: event.sessionId,
      });
      return;
    }
    if (!(await this.isCurrentRuntime(context, session.runtimeId))) {
      this.rejectFrame("runtime_event", "runtime_mismatch", {
        eventId: event.eventId,
        sessionId: event.sessionId,
      });
      return;
    }
    const interruptionEvidence =
      event.kind === "SESSION_INTERRUPTED" &&
      (event.payload.localClosureVerified === true ||
        event.payload.localNetworkClosed === true) &&
      (context?.negotiatedMinor ?? 0) >= 13;
    if (
      !interruptionEvidence &&
      event.kind !== "VIDEO_FINALIZATION_FAILED" &&
      (session.leaseExpiresAt <= new Date() ||
        session.closedAt ||
        session.quarantinedAt)
    ) {
      this.rejectFrame("runtime_event", "lease_expired", {
        eventId: event.eventId,
        sessionId: event.sessionId,
      });
      return;
    }
    const persisted = await this.prisma.browserRuntimeEvent.createMany({
      data: {
        fencingToken: session.fencingToken,
        id: event.eventId,
        kind: event.kind,
        leaseToken: event.leaseToken,
        occurredAt: new Date(event.timestamp),
        payload: asJson(event.payload),
        sessionId: event.sessionId,
      },
      skipDuplicates: true,
    });
    if (
      interruptionEvidence &&
      event.payload.localNetworkClosed === true &&
      event.payload.localClosureVerified !== true
    ) {
      await this.prisma.$transaction((tx) =>
        quarantineSession(tx, session.id, "EXECUTOR_LEASE_EXPIRED"),
      );
    }
    if (event.kind === "SESSION_INTERRUPTED") {
      const proof = runtimeClosureEvidenceSchema.safeParse(
        event.payload.closureEvidence,
      );
      if (proof.success && this.closure && context)
        await this.closure.acceptRuntimeEvidence(context, proof.data);
      else if (env().RUNTIME_SESSION_RECOVERY_ENABLED)
        await this.recovery?.request(session.id, "RUNTIME_INTERRUPTED");
    }
    if (persisted.count !== 1) return;
    this.metrics?.increment(
      "devproof_runtime_events_total",
      "Accepted Browser Runtime events by kind.",
      { kind: event.kind.toLowerCase() },
    );
    if (event.kind === "VIDEO_FINALIZATION_FAILED") {
      const attempts = Array.isArray(event.payload.attempts)
        ? event.payload.attempts.slice(0, 4).map(record)
        : [];
      this.metrics?.increment(
        "devproof_runtime_video_finalization_failures_total",
        "Browser Runtime video finalization failures by terminal error code.",
        { code: String(event.payload.code).toLowerCase() },
      );
      this.metrics?.observe(
        "devproof_runtime_video_finalization_duration_seconds",
        "Failed Browser Runtime video finalization duration in seconds.",
        Number(event.payload.durationMs) / 1_000,
      );
      this.metrics?.observe(
        "devproof_runtime_video_finalization_frames",
        "Step frame count for failed Browser Runtime video finalizations.",
        Number(event.payload.frameCount),
      );
      for (const attempt of attempts) {
        const labels = {
          code: String(attempt.code).toLowerCase(),
          profile: String(attempt.profile).toLowerCase(),
        };
        this.metrics?.increment(
          "devproof_runtime_video_encoding_attempt_failures_total",
          "Failed Browser Runtime video encoding attempts by profile and error code.",
          labels,
        );
        this.metrics?.observe(
          "devproof_runtime_video_encoding_attempt_duration_seconds",
          "Failed Browser Runtime video encoding attempt duration in seconds.",
          Number(attempt.durationMs) / 1_000,
          { profile: labels.profile },
        );
      }
      this.observability?.log("warn", "runtime.video_finalization.failed", {
        attempts: attempts.map((attempt) => ({
          code: attempt.code,
          durationMs: attempt.durationMs,
          profile: attempt.profile,
        })),
        code: event.payload.code,
        commandId: event.payload.commandId,
        durationMs: event.payload.durationMs,
        eventId: event.eventId,
        frameCount: event.payload.frameCount,
        runtimeVersion: event.payload.runtimeVersion,
        sessionId: event.sessionId,
      });
    }
  }

  private async waitForCompletion(
    commandId: string,
    deadlineAt: Date,
    signal?: AbortSignal,
  ) {
    while (Date.now() < deadlineAt.getTime()) {
      const command = await this.prisma.browserRuntimeCommand.findUnique({
        include: { artifacts: true },
        where: { id: commandId },
      });
      if (!command || TERMINAL_STATUSES.has(command.status)) {
        return command;
      }
      if (signal?.aborted) {
        await this.cancel(commandId, "MCP caller cancelled the command.");
        return this.prisma.browserRuntimeCommand.findUnique({
          include: { artifacts: true },
          where: { id: commandId },
        });
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 100);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    const timedOut = await this.prisma.browserRuntimeCommand.updateMany({
      data: {
        completedAt: new Date(),
        error: asJson({
          code: "COMMAND_TIMEOUT",
          message: "Runtime command exceeded its deadline.",
        }),
        status: "TIMED_OUT",
      },
      where: { id: commandId, status: { in: ["PENDING", "DISPATCHED"] } },
    });
    const command = await this.prisma.browserRuntimeCommand.findUnique({
      include: { session: true },
      where: { id: commandId },
    });
    if (command) {
      if (timedOut.count === 1) {
        this.metrics?.increment(
          "devproof_runtime_command_results_total",
          "Runtime command results by terminal status.",
          { status: "timed_out" },
        );
        this.metrics?.observe(
          "devproof_runtime_command_duration_seconds",
          "Runtime command duration from creation to terminal status in seconds.",
          (Date.now() - command.createdAt.getTime()) / 1_000,
          { command_type: command.commandType },
        );
      }
      await this.hub.send(command.session.runtimeId, {
        commandId,
        reason: "Runtime command exceeded its deadline.",
        sessionId: command.sessionId,
        type: "command.cancel",
      });
    }
    return this.prisma.browserRuntimeCommand.findUnique({
      include: { artifacts: true },
      where: { id: commandId },
    });
  }

  private async isCurrentRuntime(
    context: AuthenticatedRuntimeContext | undefined,
    runtimeId: string,
  ) {
    if (!context || context.runtimeId !== runtimeId) return false;
    return Boolean(
      await this.prisma.browserRuntime.findFirst({
        where: {
          id: runtimeId,
          connectionId: context.connectionId,
          connectionGeneration: context.connectionGeneration,
          enabled: true,
          revokedAt: null,
        },
        select: { id: true },
      }),
    );
  }

  private rejectFrame(
    frameType: string,
    reason: string,
    fields: Record<string, unknown>,
  ) {
    this.metrics?.increment(
      "devproof_runtime_frames_rejected_total",
      "Runtime frames rejected by type and reason.",
      { frame_type: frameType, reason },
    );
    this.observability?.log("warn", "runtime.frame.rejected", {
      ...fields,
      frameType,
      reason,
    });
  }
}
