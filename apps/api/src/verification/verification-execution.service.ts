import { randomUUID } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type VerificationRun } from "@prisma/client";
import type {
  RuntimeCommandInput,
  VerificationExecutionAcquireInput,
} from "@devproof/contracts";
import { verificationRequestSchema } from "@devproof/contracts";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { ExecutionRunnerRegistry } from "./execution-runner-registry.service.js";
import { ExecutionRunnerUnavailableError } from "./runtime-adapters.js";
import { VerificationLifecycleService } from "./verification-lifecycle.service.js";

export type ExecutionAcquireResult =
  | {
      deadlineAt: string;
      nextAction: "RETRY_ENSURE_EXECUTION";
      queueCapacity: number;
      queueDepth: number;
      reason: string;
      retryAfterMs: number;
      status: "WAITING_EXECUTION";
    }
  | {
      message: string;
      nextAction: "STOP";
      queueCapacity: number;
      queueDepth: number;
      reason: "EXECUTION_QUEUE_FULL";
      status: "QUEUE_FULL";
    }
  | { nextAction: "STOP"; status: "TIMED_OUT" }
  | {
      expiresAt: Date;
      fencingToken: string;
      leaseId: string;
      nextAction: "RUN_VERIFICATION";
      runnerId: string;
      runnerKind: string;
      status: "ACQUIRED";
    };

@Injectable()
export class VerificationExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runners: ExecutionRunnerRegistry,
    private readonly lifecycle: VerificationLifecycleService,
  ) {}

  async listRunners(teamId: string) {
    const groups = await Promise.all(
      this.runners.all().map((runner) => runner.describe(teamId)),
    );
    return groups.flat();
  }

  async acquire(
    teamId: string,
    runId: string,
    overrides?: VerificationExecutionAcquireInput,
  ): Promise<ExecutionAcquireResult> {
    const run = await this.ownedRun(teamId, runId);
    if (
      ["PASSED", "FAILED", "INCONCLUSIVE", "CANCELLED", "TIMED_OUT"].includes(
        run.status,
      )
    ) {
      throw new ConflictException(
        "A completed verification cannot acquire execution.",
      );
    }
    const request = verificationRequestSchema.parse(run.requestSnapshot);
    const profile = overrides
      ? {
          ...(overrides.profileKey ? { key: overrides.profileKey } : {}),
          mode: overrides.profileMode,
        }
      : request.execution.profile;
    const merged = verificationRequestSchema.parse({
      ...request,
      execution: {
        ...request.execution,
        profile,
      },
    });
    const claimToken = randomUUID();
    const claimed = await this.prisma.verificationRun.updateMany({
      data: {
        executionClaimExpiresAt: new Date(Date.now() + 60_000),
        executionClaimOwner: "tool-api",
        executionClaimToken: claimToken,
      },
      where: {
        id: runId,
        teamId,
        OR: [
          { executionClaimExpiresAt: null },
          { executionClaimExpiresAt: { lte: new Date() } },
        ],
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        "Execution acquisition is already in progress.",
      );
    }
    try {
      const lease = await this.runners
        .get(run.runnerKind)
        .acquire(teamId, runId, merged);
      if (["QUEUED", "WAITING_EXECUTION"].includes(run.status)) {
        try {
          await this.lifecycle.transition({
            actor: "AGENT",
            eventKind: "verification.started",
            expected: [run.status],
            eventPayload: {
              waitedForExecution: run.status === "WAITING_EXECUTION",
            },
            runId,
            teamId,
            to: "RUNNING",
          });
        } catch (error) {
          await this.runners
            .get(run.runnerKind)
            .release(teamId, runId)
            .catch(() => undefined);
          throw error;
        }
      }
      if (!run.runtimeSessionId) {
        await this.lifecycle.appendEvent({
          actor: "RUNNER",
          kind: "execution.acquired",
          payload: {
            routing: lease.routing ?? null,
            runnerId: lease.runnerId,
            runnerKind: lease.runnerKind,
            sessionId: lease.leaseId,
          },
          runId,
          teamId,
        });
      }
      return { ...lease, nextAction: "RUN_VERIFICATION", status: "ACQUIRED" };
    } catch (error) {
      if (error instanceof ExecutionRunnerUnavailableError) {
        return await this.handleUnavailable(teamId, run, request, error);
      }
      await this.lifecycle.appendEvent({
        actor: "RUNNER",
        kind: "execution.acquire.failed",
        payload: {
          message: error instanceof Error ? error.message : String(error),
        },
        runId,
        teamId,
      });
      throw error;
    } finally {
      await this.prisma.verificationRun.updateMany({
        data: {
          executionClaimExpiresAt: null,
          executionClaimOwner: null,
          executionClaimToken: null,
        },
        where: { executionClaimToken: claimToken, id: runId },
      });
    }
  }

  private async handleUnavailable(
    teamId: string,
    run: VerificationRun,
    request: ReturnType<typeof verificationRequestSchema.parse>,
    error: ExecutionRunnerUnavailableError,
  ): Promise<ExecutionAcquireResult> {
    const availabilityPolicy =
      error.availabilityPolicyOverride ?? request.execution.availabilityPolicy;
    if (availabilityPolicy === "FAIL_FAST") {
      await this.lifecycle.appendEvent({
        actor: "RUNNER",
        kind: "execution.acquire.failed",
        payload: { message: error.message, reason: error.reason },
        runId: run.id,
        teamId,
      });
      throw new ConflictException(error.message);
    }

    return this.enterWaitQueue(teamId, run, request, error);
  }

  private async enterWaitQueue(
    teamId: string,
    run: VerificationRun,
    request: ReturnType<typeof verificationRequestSchema.parse>,
    error: ExecutionRunnerUnavailableError,
  ): Promise<ExecutionAcquireResult> {
    const queueCapacity = env().EXECUTION_WAIT_QUEUE_CAPACITY;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const current = await tx.verificationRun.findFirst({
              where: { id: run.id, teamId },
            });
            if (!current) {
              throw new NotFoundException("Verification run was not found.");
            }
            const deadline =
              current.executionAcquireDeadlineAt ??
              new Date(
                Date.now() + request.execution.acquireTimeoutSeconds * 1_000,
              );
            if (deadline.getTime() <= Date.now()) {
              await this.lifecycle.transitionInTransaction(tx, {
                actor: "SYSTEM",
                eventKind: "verification.timed_out",
                eventPayload: {
                  message: error.message,
                  reason: "EXECUTION_ACQUIRE_TIMEOUT",
                },
                expected: ["QUEUED", "WAITING_EXECUTION", "RUNNING"],
                runId: current.id,
                teamId,
                to: "TIMED_OUT",
              });
              return { nextAction: "STOP", status: "TIMED_OUT" };
            }

            const queueDepth = await tx.verificationRun.count({
              where: { status: "WAITING_EXECUTION", teamId },
            });
            if (current.status === "WAITING_EXECUTION") {
              return {
                deadlineAt: deadline.toISOString(),
                nextAction: "RETRY_ENSURE_EXECUTION",
                queueCapacity,
                queueDepth,
                reason: error.reason,
                retryAfterMs: 2_000,
                status: "WAITING_EXECUTION",
              };
            }
            if (queueDepth >= queueCapacity) {
              const message = `Execution wait queue is full (${queueDepth}/${queueCapacity}).`;
              await this.lifecycle.transitionInTransaction(tx, {
                actor: "RUNNER",
                error: {
                  code: "EXECUTION_QUEUE_FULL",
                  message,
                  queueCapacity,
                  queueDepth,
                },
                eventKind: "execution.queue.full",
                eventPayload: {
                  message,
                  queueCapacity,
                  queueDepth,
                  reason: "EXECUTION_QUEUE_FULL",
                },
                expected: ["QUEUED", "RUNNING"],
                runId: current.id,
                teamId,
                to: "INCONCLUSIVE",
              });
              return {
                message,
                nextAction: "STOP",
                queueCapacity,
                queueDepth,
                reason: "EXECUTION_QUEUE_FULL",
                status: "QUEUE_FULL",
              };
            }

            await this.lifecycle.transitionInTransaction(tx, {
              actor: "RUNNER",
              eventKind: "execution.waiting",
              eventPayload: { message: error.message, reason: error.reason },
              executionAcquireDeadlineAt: deadline,
              expected: ["QUEUED", "RUNNING"],
              runId: current.id,
              teamId,
              to: "WAITING_EXECUTION",
            });
            return {
              deadlineAt: deadline.toISOString(),
              nextAction: "RETRY_ENSURE_EXECUTION",
              queueCapacity,
              queueDepth: queueDepth + 1,
              reason: error.reason,
              retryAfterMs: 2_000,
              status: "WAITING_EXECUTION",
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (transactionError) {
        if (
          transactionError instanceof Prisma.PrismaClientKnownRequestError &&
          transactionError.code === "P2034" &&
          attempt < 2
        ) {
          continue;
        }
        throw transactionError;
      }
    }
    throw new ConflictException("Execution queue admission conflicted.");
  }

  async execute(
    teamId: string,
    runId: string,
    command: RuntimeCommandInput,
    signal?: AbortSignal,
  ) {
    const run = await this.ownedRun(teamId, runId);
    if (run.status !== "RUNNING") {
      throw new ConflictException(
        `Verification in ${run.status} state cannot execute commands.`,
      );
    }
    return this.runners
      .get(run.runnerKind)
      .execute(teamId, runId, command, signal);
  }

  async release(teamId: string, runId: string) {
    const run = await this.ownedRun(teamId, runId);
    if (run.status === "WAITING_HUMAN" && run.runtimeSessionId) {
      throw new ConflictException(
        "Execution must remain active while browser HITL is waiting. Resolve the checkpoint before releasing it.",
      );
    }
    await this.runners.get(run.runnerKind).release(teamId, runId);
    return { ok: true };
  }

  purgeProfile(teamId: string, profileKey: string) {
    return this.runners.get("BROWSER").purgeProfile(teamId, profileKey);
  }

  private async ownedRun(teamId: string, runId: string) {
    const run = await this.prisma.verificationRun.findFirst({
      where: { id: runId, teamId },
    });
    if (!run) throw new NotFoundException("Verification run was not found.");
    return run;
  }
}
