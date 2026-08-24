import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  VerificationResult,
  VerificationRunStatus,
} from "@devproof/contracts";
import { verificationRequestSchema } from "@devproof/contracts";

import { PrismaService } from "../database/prisma.service.js";
import {
  ObservabilityService,
  redactText,
} from "../observability/observability.service.js";

const transitions: Record<VerificationRunStatus, VerificationRunStatus[]> = {
  CANCELLED: [],
  FAILED: [],
  INCONCLUSIVE: [],
  PASSED: [],
  QUEUED: [
    "WAITING_EXECUTION",
    "RUNNING",
    "FAILED",
    "INCONCLUSIVE",
    "CANCELLED",
    "TIMED_OUT",
  ],
  RUNNING: [
    "QUEUED",
    "WAITING_EXECUTION",
    "WAITING_HUMAN",
    "PASSED",
    "FAILED",
    "INCONCLUSIVE",
    "CANCELLED",
    "TIMED_OUT",
  ],
  TIMED_OUT: [],
  WAITING_EXECUTION: [
    "QUEUED",
    "RUNNING",
    "FAILED",
    "INCONCLUSIVE",
    "CANCELLED",
    "TIMED_OUT",
  ],
  WAITING_HUMAN: [
    "QUEUED",
    "RUNNING",
    "PASSED",
    "FAILED",
    "INCONCLUSIVE",
    "CANCELLED",
    "TIMED_OUT",
  ],
};

const terminalStatuses = new Set<VerificationRunStatus>([
  "PASSED",
  "FAILED",
  "INCONCLUSIVE",
  "CANCELLED",
  "TIMED_OUT",
]);

export function canTransitionVerification(
  from: VerificationRunStatus,
  to: VerificationRunStatus,
): boolean {
  return from === to || transitions[from].includes(to);
}

export function isTerminalVerificationStatus(
  status: VerificationRunStatus,
): boolean {
  return terminalStatuses.has(status);
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export interface VerificationTransitionInput {
  actor: "SYSTEM" | "AGENT" | "RUNNER" | "HUMAN" | "WORKER";
  error?: Record<string, unknown>;
  executionAcquireDeadlineAt?: Date;
  eventKind: string;
  eventPayload?: Record<string, unknown>;
  expected?: VerificationRunStatus[];
  result?: VerificationResult;
  runId: string;
  teamId: string;
  to: VerificationRunStatus;
}

@Injectable()
export class VerificationLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly observability: ObservabilityService,
  ) {}

  async transition(input: VerificationTransitionInput) {
    return this.prisma.$transaction((tx) =>
      this.transitionInTransaction(tx, input),
    );
  }

  async transitionInTransaction(
    tx: Prisma.TransactionClient,
    input: VerificationTransitionInput,
  ) {
    const run = await tx.verificationRun.findFirst({
      where: { id: input.runId, teamId: input.teamId },
    });
    if (!run) {
      throw new NotFoundException("Verification run was not found.");
    }
    const from = run.status as VerificationRunStatus;
    if (input.expected && !input.expected.includes(from)) {
      throw new ConflictException(
        `Verification run changed concurrently; expected ${input.expected.join(
          ", ",
        )}, received ${from}.`,
      );
    }
    if (!canTransitionVerification(from, input.to)) {
      throw new ConflictException(
        `Invalid verification lifecycle transition: ${from} -> ${input.to}.`,
      );
    }

    const now = new Date();
    const update: Prisma.VerificationRunUpdateInput = {
      status: input.to,
      ...(input.error ? { error: json(input.error) } : {}),
      ...(input.result ? { result: json(input.result) } : {}),
    };
    if (input.to === "RUNNING" && !run.startedAt) {
      update.startedAt = now;
    }
    if (input.to === "WAITING_EXECUTION") {
      update.executionWaitStartedAt = run.executionWaitStartedAt ?? now;
      const deadline =
        run.executionAcquireDeadlineAt ?? input.executionAcquireDeadlineAt;
      if (deadline) update.executionAcquireDeadlineAt = deadline;
    } else if (input.to === "RUNNING") {
      update.executionWaitStartedAt = null;
      update.executionAcquireDeadlineAt = null;
    }
    if (input.to === "CANCELLED") {
      update.cancelledAt = now;
    }
    if (isTerminalVerificationStatus(input.to)) {
      update.finishedAt = now;
      const retentionDays = verificationRequestSchema.parse(run.requestSnapshot)
        .evidencePolicy.retentionDays;
      update.retentionUntil = new Date(
        now.getTime() + retentionDays * 86_400_000,
      );
      update.executionWaitStartedAt = null;
      update.executionAcquireDeadlineAt = null;
      update.executionClaimExpiresAt = null;
      update.executionClaimOwner = null;
      update.executionClaimToken = null;
    }

    const claimed = await tx.verificationRun.updateMany({
      data: update,
      where: { id: run.id, status: from },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("Verification run changed concurrently.");
    }
    const updated = await tx.verificationRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    const traceStatus =
      input.to === "RUNNING"
        ? "STARTED"
        : input.to === "PASSED"
          ? "SUCCEEDED"
          : input.to === "FAILED" || input.to === "INCONCLUSIVE"
            ? "FAILED"
            : input.to === "CANCELLED"
              ? "CANCELLED"
              : input.to === "TIMED_OUT"
                ? "TIMED_OUT"
                : "INFO";
    const failure = input.error ?? input.eventPayload;
    const errorCode =
      failure && typeof failure.code === "string"
        ? failure.code
        : failure && typeof failure.reason === "string"
          ? failure.reason
          : undefined;
    const errorMessage =
      failure && typeof failure.message === "string"
        ? redactText(failure.message).slice(0, 4_000)
        : undefined;
    await tx.verificationEvent.create({
      data: {
        actor: input.actor,
        ...(isTerminalVerificationStatus(input.to) && run.startedAt
          ? { durationMs: Math.max(0, now.getTime() - run.startedAt.getTime()) }
          : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        kind: input.eventKind,
        payload: json({
          from,
          to: input.to,
          ...(input.eventPayload ?? {}),
        }),
        status: traceStatus,
        ...this.observability.eventFields(),
        runId: run.id,
        teamId: run.teamId,
        traceId: run.traceId,
      },
    });
    return updated;
  }

  async appendEvent(input: {
    actor: "SYSTEM" | "AGENT" | "RUNNER" | "HUMAN" | "WORKER";
    kind: string;
    occurredAt?: Date;
    durationMs?: number;
    errorCode?: string;
    errorMessage?: string;
    payload: Record<string, unknown>;
    runId: string;
    runtimeCommandId?: string;
    teamId: string;
    status?:
      "INFO" | "STARTED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  }) {
    const run = await this.prisma.verificationRun.findFirst({
      select: { id: true, status: true, traceId: true },
      where: { id: input.runId, teamId: input.teamId },
    });
    if (!run) {
      throw new NotFoundException("Verification run was not found.");
    }
    return this.prisma.verificationEvent.create({
      data: {
        actor: input.actor,
        kind: input.kind,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        ...(input.durationMs === undefined
          ? {}
          : { durationMs: input.durationMs }),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.errorMessage
          ? { errorMessage: redactText(input.errorMessage) }
          : {}),
        ...(input.runtimeCommandId
          ? { runtimeCommandId: input.runtimeCommandId }
          : {}),
        payload: json(input.payload),
        runId: input.runId,
        teamId: input.teamId,
        status: input.status ?? "INFO",
        ...this.observability.eventFields(),
        traceId: run.traceId,
      },
    });
  }
}
