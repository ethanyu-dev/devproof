import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  VerificationCheckpointCreateInput,
  VerificationCheckpointResolveInput,
  VerificationRequest,
  VerificationResult,
} from "@devproof/contracts";
import { verificationRequestSchema } from "@devproof/contracts";

import type { AuthContext } from "../auth/auth.types.js";
import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { ObservabilityService } from "../observability/observability.service.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

@Injectable()
export class HitlCoordinator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HitlCoordinator.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly monitor?: WorkerMonitorService,
    @Optional() private readonly observability?: ObservabilityService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor?.register("hitl-expiry", 10_000);
    this.timer = setInterval(() => this.trigger(), 10_000);
    this.timer.unref();
    this.trigger();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async request(
    teamId: string,
    runId: string,
    input: VerificationCheckpointCreateInput,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.verificationRun.findFirst({
        where: { id: runId, teamId },
      });
      if (!run) throw new NotFoundException("Verification run was not found.");
      if (run.status !== "RUNNING") {
        throw new ConflictException(
          `Verification in ${run.status} state cannot request human input.`,
        );
      }
      const request = verificationRequestSchema.parse(run.requestSnapshot);
      if (!request.hitlPolicy.enabled) {
        throw new ConflictException(
          "HITL is disabled by this verification request.",
        );
      }
      const pending = await tx.verificationCheckpoint.findFirst({
        where: { runId, status: "PENDING" },
      });
      if (pending) return pending;

      const expiresAt = new Date(
        Date.now() +
          (input.timeoutSeconds ?? request.hitlPolicy.timeoutSeconds) * 1000,
      );
      const checkpoint = await tx.verificationCheckpoint.create({
        data: {
          context: json(input.context),
          expiresAt,
          prompt: input.prompt,
          responseSchema: json(input.responseSchema),
          runId,
          teamId,
        },
      });
      await tx.verificationRun.update({
        data: { status: "WAITING_HUMAN" },
        where: { id: runId },
      });
      if (run.runtimeSessionId) {
        await tx.browserRuntimeSession.updateMany({
          data: { leaseExpiresAt: expiresAt },
          where: {
            id: run.runtimeSessionId,
            status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL"] },
          },
        });
        await tx.browserRuntimeSlot.updateMany({
          data: { expiresAt },
          where: { sessionId: run.runtimeSessionId },
        });
        await tx.browserRuntimeProfileLease.updateMany({
          data: { expiresAt },
          where: { sessionId: run.runtimeSessionId },
        });
      }
      await tx.verificationEvent.create({
        data: {
          actor: "AGENT",
          kind: "hitl.requested",
          payload: json({
            checkpointId: checkpoint.id,
            expiresAt,
            prompt: input.prompt,
            runtimeSessionPreserved: Boolean(run.runtimeSessionId),
          }),
          status: "STARTED",
          ...this.eventFields(run.traceId),
          runId,
          teamId,
        },
      });
      if (request.hitlPolicy.notificationChannels.includes("FEISHU")) {
        await tx.notificationOutbox.create({
          data: {
            channel: "FEISHU",
            checkpointId: checkpoint.id,
            dedupeKey: `verification:${runId}:checkpoint:${checkpoint.id}:requested:feishu`,
            eventType: "hitl.requested",
            payload: json({
              checkpointId: checkpoint.id,
              expiresAt: expiresAt.toISOString(),
              goal: run.goal,
              prompt: input.prompt,
              runId,
            }),
            runId,
            teamId,
          },
        });
        await tx.verificationEvent.create({
          data: {
            actor: "SYSTEM",
            kind: "notification.enqueued",
            payload: json({ channel: "FEISHU", checkpointId: checkpoint.id }),
            ...this.eventFields(run.traceId),
            runId,
            teamId,
          },
        });
      }
      return checkpoint;
    });
  }

  async resolve(
    current: AuthContext,
    checkpointId: string,
    input: VerificationCheckpointResolveInput,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const checkpoint = await tx.verificationCheckpoint.findFirst({
        include: {
          run: {
            include: {
              runtimeSession: { select: { id: true, status: true } },
            },
          },
        },
        where: { id: checkpointId, teamId: current.team.id },
      });
      if (!checkpoint)
        throw new NotFoundException("HITL checkpoint was not found.");
      if (checkpoint.status !== "PENDING") {
        if (checkpoint.status === "RESOLVED") return checkpoint;
        throw new ConflictException(
          `Checkpoint is already ${checkpoint.status}.`,
        );
      }
      if (checkpoint.expiresAt.getTime() <= Date.now()) {
        throw new ConflictException("Checkpoint has expired.");
      }
      const resolvedAt = new Date();
      const claimed = await tx.verificationCheckpoint.updateMany({
        data: {
          resolvedAt,
          resolvedByUserId: current.user.id,
          response: json(input.response),
          status: "RESOLVED",
        },
        where: { id: checkpoint.id, status: "PENDING" },
      });
      if (claimed.count !== 1) {
        const currentCheckpoint =
          await tx.verificationCheckpoint.findUniqueOrThrow({
            where: { id: checkpoint.id },
          });
        if (currentCheckpoint.status === "RESOLVED") return currentCheckpoint;
        throw new ConflictException(
          `Checkpoint is already ${currentCheckpoint.status}.`,
        );
      }
      const resolved = await tx.verificationCheckpoint.findUniqueOrThrow({
        where: { id: checkpoint.id },
      });
      let resumeStatus: "RUNNING" | undefined;
      if (checkpoint.run.status === "WAITING_HUMAN") {
        resumeStatus = "RUNNING";
        await tx.verificationRun.update({
          data: { status: "RUNNING" },
          where: { id: checkpoint.runId },
        });
      }
      await tx.verificationEvent.create({
        data: {
          actor: "HUMAN",
          kind: "hitl.resolved",
          payload: json({
            checkpointId,
            response: input.response,
            resumeStatus,
            resolvedByUserId: current.user.id,
          }),
          durationMs: Math.max(
            0,
            resolvedAt.getTime() - checkpoint.requestedAt.getTime(),
          ),
          status: "SUCCEEDED",
          ...this.eventFields(checkpoint.run.traceId),
          runId: checkpoint.runId,
          teamId: checkpoint.teamId,
        },
      });
      const request = verificationRequestSchema.parse(
        checkpoint.run.requestSnapshot,
      );
      if (request.hitlPolicy.notificationChannels.includes("AGENT_WEBHOOK")) {
        const outbox = await tx.notificationOutbox.create({
          data: {
            channel: "AGENT_WEBHOOK",
            checkpointId,
            dedupeKey: `verification:${checkpoint.runId}:checkpoint:${checkpointId}:resolved:agent`,
            eventType: "hitl.resolved",
            payload: json({
              checkpointId,
              externalAgentRunId: checkpoint.run.externalAgentRunId,
              provider: checkpoint.run.agentProvider,
              response: input.response,
              resumeStatus,
              runId: checkpoint.runId,
              runtimeSession: checkpoint.run.runtimeSession
                ? {
                    id: checkpoint.run.runtimeSession.id,
                    status: checkpoint.run.runtimeSession.status,
                  }
                : null,
            }),
            runId: checkpoint.runId,
            teamId: checkpoint.teamId,
          },
        });
        await tx.verificationEvent.create({
          data: {
            actor: "SYSTEM",
            kind: "notification.enqueued",
            payload: json({
              channel: "AGENT_WEBHOOK",
              checkpointId,
              deliveryId: outbox.id,
            }),
            ...this.eventFields(checkpoint.run.traceId),
            runId: checkpoint.runId,
            teamId: checkpoint.teamId,
          },
        });
      }
      return resolved;
    });
  }

  async expire() {
    const checkpoints = await this.prisma.verificationCheckpoint.findMany({
      include: { run: true },
      take: 50,
      where: { expiresAt: { lte: new Date() }, status: "PENDING" },
    });
    let firstError: unknown;
    for (const checkpoint of checkpoints) {
      const request = verificationRequestSchema.parse(
        checkpoint.run.requestSnapshot,
      );
      try {
        await this.expireOne(checkpoint.id, request);
      } catch (error) {
        firstError ??= error;
        this.observability?.log(
          "error",
          "hitl.expiry.failed",
          { checkpointId: checkpoint.id, runId: checkpoint.runId },
          error,
        );
      }
    }
    if (firstError) throw firstError;
  }

  private async expireOne(checkpointId: string, request: VerificationRequest) {
    await this.prisma.$transaction(async (tx) => {
      const checkpoint = await tx.verificationCheckpoint.findUnique({
        include: { run: true },
        where: { id: checkpointId },
      });
      if (!checkpoint || checkpoint.status !== "PENDING") return;
      const claimed = await tx.verificationCheckpoint.updateMany({
        data: { status: "EXPIRED" },
        where: { id: checkpointId, status: "PENDING" },
      });
      if (claimed.count !== 1) return;

      const action = request.hitlPolicy.onTimeout;
      const status =
        action === "CANCEL"
          ? "CANCELLED"
          : action === "FAIL"
            ? "FAILED"
            : "INCONCLUSIVE";
      const result: VerificationResult | undefined =
        status === "CANCELLED"
          ? undefined
          : {
              criteria: request.acceptanceCriteria.map((criterion) => ({
                criterionId: criterion.id,
                evidenceRefs: [],
                status: "INCONCLUSIVE",
                summary:
                  "Human input timed out before this criterion could be verified.",
              })),
              evidenceRefs: [],
              summary:
                "Verification stopped because the HITL checkpoint expired.",
              verdict: status,
            };
      if (checkpoint.run.status === "WAITING_HUMAN") {
        const finishedAt = new Date();
        await tx.verificationRun.update({
          data: {
            ...(status === "CANCELLED" ? { cancelledAt: finishedAt } : {}),
            error: json({
              code: "HITL_TIMEOUT",
              message: "Human input timed out.",
            }),
            finishedAt,
            ...(result ? { result: json(result) } : {}),
            retentionUntil: new Date(
              finishedAt.getTime() +
                request.evidencePolicy.retentionDays * 86_400_000,
            ),
            status,
          },
          where: { id: checkpoint.runId },
        });
      }
      await tx.verificationEvent.create({
        data: {
          actor: "SYSTEM",
          durationMs: Math.max(
            0,
            Date.now() - checkpoint.requestedAt.getTime(),
          ),
          errorCode: "HITL_TIMEOUT",
          errorMessage: "Human input timed out.",
          kind: "hitl.expired",
          payload: json({ action, checkpointId }),
          status: "TIMED_OUT",
          ...this.eventFields(checkpoint.run.traceId),
          runId: checkpoint.runId,
          teamId: checkpoint.teamId,
        },
      });
    });
  }

  private trigger() {
    const operation = () => this.expire();
    const running = this.monitor
      ? this.monitor.run("hitl-expiry", operation)
      : operation();
    void running.catch((error: Error) => {
      if (this.observability) {
        this.observability.log("error", "hitl.expiry.sweep_failed", {}, error);
      } else {
        this.logger.error(`HITL expiry sweep failed: ${error.message}`);
      }
    });
  }

  private eventFields(traceId: string) {
    return { ...(this.observability?.eventFields() ?? {}), traceId };
  }
}
