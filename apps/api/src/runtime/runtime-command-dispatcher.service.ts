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
import { runtimeEventSchema } from "@devproof/runtime-protocol";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import { RuntimeConnectionHub } from "./runtime-connection-hub.service.js";
import { MetricsService } from "../observability/metrics.service.js";
import { ObservabilityService } from "../observability/observability.service.js";

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

@Injectable()
export class RuntimeCommandDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hub: RuntimeConnectionHub,
    private readonly storage: ObjectStorageService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly observability?: ObservabilityService,
  ) {}

  async execute(input: {
    commandType: RuntimeCommandType;
    payload?: Record<string, unknown>;
    sessionId: string;
    signal?: AbortSignal;
    source: "SYSTEM" | "AGENT" | "CONSOLE" | "HUMAN";
    timeoutSeconds?: number;
    commandId?: string;
  }) {
    const session = await this.prisma.browserRuntimeSession.findUnique({
      where: { id: input.sessionId },
    });
    if (!session) {
      throw new NotFoundException("Runtime session was not found.");
    }
    if (
      !["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"].includes(
        session.status,
      )
    ) {
      throw new ConflictException(
        "Runtime session is not able to receive commands.",
      );
    }
    if (session.leaseExpiresAt.getTime() <= Date.now()) {
      throw new ConflictException("Runtime session lease has expired.");
    }

    const timeoutSeconds =
      input.timeoutSeconds ?? env().RUNTIME_COMMAND_TIMEOUT_SECONDS;
    const deadlineAt = new Date(Date.now() + timeoutSeconds * 1000);
    const command = await this.prisma.browserRuntimeCommand.create({
      data: {
        ...(input.commandId ? { id: input.commandId } : {}),
        commandType: input.commandType,
        deadlineAt,
        fencingToken: session.fencingToken,
        leaseToken: session.leaseToken,
        payload: asJson(input.payload ?? {}),
        sessionId: session.id,
        source: input.source,
      },
    });

    await this.hub.send(session.runtimeId, {
      commandId: command.id,
      commandType: input.commandType,
      deadlineAt: deadlineAt.toISOString(),
      fencingToken: session.fencingToken.toString(),
      leaseToken: session.leaseToken,
      payload: input.payload ?? {},
      sessionId: session.id,
      type: "command.execute",
    });
    await this.prisma.browserRuntimeCommand.updateMany({
      data: { dispatchedAt: new Date(), status: "DISPATCHED" },
      where: { id: command.id, status: "PENDING" },
    });

    return this.waitForCompletion(command.id, deadlineAt, input.signal);
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

  async acceptResult(result: RuntimeCommandResult) {
    const command = await this.prisma.browserRuntimeCommand.findUnique({
      include: { session: true },
      where: { id: result.commandId },
    });
    if (!command || TERMINAL_STATUSES.has(command.status)) {
      this.rejectFrame(
        "command_result",
        !command ? "unknown_command" : "terminal_command",
        { commandId: result.commandId },
      );
      return;
    }
    if (
      command.sessionId !== result.sessionId ||
      command.leaseToken !== result.leaseToken ||
      command.fencingToken.toString() !== result.fencingToken ||
      command.session.leaseToken !== result.leaseToken ||
      command.session.fencingToken.toString() !== result.fencingToken
    ) {
      this.rejectFrame("command_result", "lease_mismatch", {
        commandId: result.commandId,
        sessionId: result.sessionId,
      });
      return;
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
      const stored = await this.storage.put(
        storageKey,
        artifact.contentType,
        body,
        {
          commandId: command.id,
          kind: artifact.kind,
          sessionId: command.sessionId,
        },
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
        return;
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

  async acceptEvent(event: RuntimeEvent) {
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
    await this.prisma.browserRuntimeEvent.upsert({
      create: {
        fencingToken: session.fencingToken,
        id: event.eventId,
        kind: event.kind,
        leaseToken: event.leaseToken,
        occurredAt: new Date(event.timestamp),
        payload: asJson(event.payload),
        sessionId: event.sessionId,
      },
      update: {},
      where: { id: event.eventId },
    });
    this.metrics?.increment(
      "devproof_runtime_events_total",
      "Accepted Browser Runtime events by kind.",
      { kind: event.kind.toLowerCase() },
    );
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
