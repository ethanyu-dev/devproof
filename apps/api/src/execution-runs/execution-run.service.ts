import { randomBytes, randomUUID } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { runtimeTaskSnapshotSchema } from "@devproof/agent-runtime-protocol";
import type {
  ExecutionRunCreateInput,
  RunInterventionResolveInput,
  RunTrajectoryRecord,
} from "@devproof/contracts";
import {
  runDeadlinePolicySchema,
  runHitlPolicySchema,
} from "@devproof/contracts";

import { PrismaService } from "../database/prisma.service.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import { summarizeValue } from "../observability/observability.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function sameJson(left: unknown, right: unknown) {
  return (
    JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
  );
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

function safeExecutionPolicy(
  value: Prisma.JsonValue,
  browserProfileId: string | null,
) {
  if (
    !browserProfileId ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }
  const policy = value as Record<string, unknown>;
  const browser =
    policy.browser &&
    typeof policy.browser === "object" &&
    !Array.isArray(policy.browser)
      ? (policy.browser as Record<string, unknown>)
      : {};
  return {
    ...policy,
    browser: {
      ...browser,
      profile: { id: browserProfileId, mode: "PERSISTENT" },
    },
  };
}

function safeRunProfile<
  T extends {
    browserProfileId: string | null;
    executionPolicy: Prisma.JsonValue;
  },
>(run: T) {
  return {
    ...run,
    executionPolicy: safeExecutionPolicy(
      run.executionPolicy,
      run.browserProfileId,
    ),
  };
}

@Injectable()
export class ExecutionRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
  ) {}

  list(current: ToolAuthContext) {
    return this.prisma.executionRun.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        createdAt: true,
        currentAttemptNumber: true,
        executionDisposition: true,
        finishedAt: true,
        goal: true,
        id: true,
        lifecycle: true,
        maxAttempts: true,
        sourceId: true,
        sourceKind: true,
        updatedAt: true,
        verdict: true,
      },
      take: 100,
      where: { teamId: current.team.id },
    });
  }

  async create(current: ToolAuthContext, input: ExecutionRunCreateInput) {
    return this.createInternal(current, input, null);
  }

  async createForTask(
    current: ToolAuthContext,
    input: ExecutionRunCreateInput,
    taskExecutionId: string,
    browserProfileId: string | null = null,
  ) {
    return this.createInternal(
      current,
      input,
      taskExecutionId,
      browserProfileId,
    );
  }

  private async createInternal(
    current: ToolAuthContext,
    input: ExecutionRunCreateInput,
    taskExecutionId: string | null,
    browserProfileId: string | null = null,
  ) {
    const deadlinePolicy = runDeadlinePolicySchema.parse(
      input.deadlinePolicy ?? { mode: "FIXED" },
    );
    const existing = await this.prisma.executionRun.findUnique({
      where: {
        teamId_idempotencyKey: {
          idempotencyKey: input.idempotencyKey,
          teamId: current.team.id,
        },
      },
    });
    if (existing) {
      assertCompatibleRunRequest(existing, input, taskExecutionId);
      if (taskExecutionId && !existing.taskExecutionId) {
        await this.prisma.$transaction(async (tx) => {
          await tx.executionRun.updateMany({
            data: { taskExecutionId },
            where: { id: existing.id, taskExecutionId: null },
          });
          await tx.taskExecution.update({
            data: { projectionNeededAt: new Date() },
            where: { id: taskExecutionId },
          });
        });
      }
      return this.detail(current, existing.id);
    }

    const now = new Date();
    const parentTask = taskExecutionId
      ? await this.prisma.taskExecution.findFirst({
          select: { deadlineAt: true },
          where: { id: taskExecutionId, teamId: current.team.id },
        })
      : null;
    const requestedDeadlineAt = new Date(
      now.getTime() + input.deadlineSeconds * 1_000,
    );
    const deadlineAt = new Date(
      Math.min(
        requestedDeadlineAt.getTime(),
        parentTask?.deadlineAt.getTime() ?? Number.POSITIVE_INFINITY,
      ),
    );
    if (deadlineAt <= now) {
      throw new ConflictException("The parent task deadline has elapsed.");
    }
    const hardDeadlineAt = new Date(
      deadlinePolicy.mode === "ADAPTIVE"
        ? Math.min(
            deadlineAt.getTime() + deadlinePolicy.maxExtensionSeconds * 1_000,
            parentTask?.deadlineAt.getTime() ?? Number.POSITIVE_INFINITY,
          )
        : deadlineAt.getTime(),
    );
    const runId = randomUUID();
    const attemptId = randomUUID();
    const taskId = randomUUID();
    const traceId = randomBytes(16).toString("hex");
    const provider = input.model?.provider ?? "CODEX";
    const snapshot = runtimeTaskSnapshotSchema.parse({
      attemptId,
      attemptNumber: 1,
      businessReferences: input.businessReferences,
      criteria: input.criteria,
      deadlineAt: deadlineAt.toISOString(),
      hardDeadlineAt: hardDeadlineAt.toISOString(),
      environment: input.environment,
      executionPolicy: {
        browser: input.browserPolicy,
        deadline: deadlinePolicy,
        hitl: input.hitlPolicy,
        retryPolicy: input.retryPolicy,
      },
      goal: input.goal,
      ...(input.model ? { model: input.model } : {}),
      runId,
      teamId: current.team.id,
      traceId,
    });

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.executionRun.create({
          data: {
            criteriaSnapshot: json(input.criteria),
            browserProfileId,
            currentAttemptNumber: 1,
            deadlineAt,
            deadlineExtensionCount: 0,
            deadlineExtendedMs: 0,
            environmentSnapshot: json(input.environment),
            executionPolicy: json({
              browser: input.browserPolicy,
              businessReferences: input.businessReferences,
              deadline: deadlinePolicy,
              hitl: input.hitlPolicy,
              retryPolicy: input.retryPolicy,
            }),
            goal: input.goal,
            id: runId,
            idempotencyKey: input.idempotencyKey,
            hardDeadlineAt,
            initialDeadlineAt: deadlineAt,
            maxAttempts: input.retryPolicy.maxAttempts,
            sourceId: input.source.id ?? null,
            sourceKind: input.source.kind,
            taskExecutionId,
            teamId: current.team.id,
            traceId,
          },
        });
        await tx.runAttempt.create({
          data: {
            id: attemptId,
            inputSnapshot: json(snapshot),
            number: 1,
            runId,
          },
        });
        await tx.agentRuntimeTask.create({
          data: {
            attemptId,
            capability: "BROWSER_VERIFICATION",
            deadlineAt,
            id: taskId,
            provider,
            runId,
            snapshot: json(snapshot),
          },
        });
        await tx.runEvent.create({
          data: {
            actor: "CONTROL_PLANE",
            attemptId,
            kind: "run.queued",
            payload: json({ attemptNumber: 1, taskId }),
            runId,
            taskId,
            teamId: current.team.id,
          },
        });
      });
      if (taskExecutionId) {
        await this.prisma.taskExecution.update({
          data: { projectionNeededAt: new Date() },
          where: { id: taskExecutionId },
        });
      }
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const collided = await this.prisma.executionRun.findUnique({
          where: {
            teamId_idempotencyKey: {
              idempotencyKey: input.idempotencyKey,
              teamId: current.team.id,
            },
          },
        });
        if (collided) {
          assertCompatibleRunRequest(collided, input, taskExecutionId);
          if (taskExecutionId && !collided.taskExecutionId) {
            await this.prisma.$transaction(async (tx) => {
              await tx.executionRun.updateMany({
                data: { taskExecutionId },
                where: { id: collided.id, taskExecutionId: null },
              });
              await tx.taskExecution.update({
                data: { projectionNeededAt: new Date() },
                where: { id: taskExecutionId },
              });
            });
          }
          return this.detail(current, collided.id);
        }
      }
      throw error;
    }

    return this.detail(current, runId);
  }

  async detail(current: ToolAuthContext, id: string) {
    const run = await this.prisma.executionRun.findFirst({
      include: {
        attempts: { orderBy: { number: "asc" } },
        browserExecutions: { orderBy: { createdAt: "asc" } },
        criterionResults: { orderBy: { criterionId: "asc" } },
        evidences: { orderBy: { createdAt: "asc" } },
        interventions: { orderBy: { requestedAt: "asc" } },
        tasks: {
          orderBy: { createdAt: "asc" },
          select: {
            attemptId: true,
            capability: true,
            createdAt: true,
            deadlineAt: true,
            finishedAt: true,
            id: true,
            lastHeartbeatAt: true,
            provider: true,
            startedAt: true,
            status: true,
          },
        },
      },
      where: { id, teamId: current.team.id },
    });
    if (!run) throw new NotFoundException("Run not found.");
    return safeRunProfile(run);
  }

  async consoleDetail(current: ToolAuthContext, id: string) {
    const run = await this.prisma.executionRun.findFirst({
      include: {
        attempts: { orderBy: { number: "asc" } },
        browserExecutions: {
          include: {
            runtimeSession: {
              include: {
                commands: { orderBy: { createdAt: "asc" }, take: 500 },
                events: { orderBy: { occurredAt: "asc" }, take: 500 },
                runtime: { select: { id: true, name: true, status: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        criterionResults: { orderBy: { criterionId: "asc" } },
        evidences: {
          include: { runtimeArtifact: true },
          orderBy: { createdAt: "asc" },
        },
        interventions: {
          include: {
            notifications: {
              orderBy: { createdAt: "asc" },
              select: {
                attempts: true,
                channel: true,
                deliveredAt: true,
                id: true,
                lastError: true,
                status: true,
              },
            },
          },
          orderBy: { requestedAt: "asc" },
        },
        tasks: {
          orderBy: { createdAt: "asc" },
          select: {
            attemptId: true,
            capability: true,
            createdAt: true,
            deadlineAt: true,
            error: true,
            finishedAt: true,
            id: true,
            lastHeartbeatAt: true,
            provider: true,
            startedAt: true,
            status: true,
          },
        },
      },
      where: { id, teamId: current.team.id },
    });
    if (!run) throw new NotFoundException("Run not found.");

    return {
      ...run,
      executionPolicy: safeExecutionPolicy(
        run.executionPolicy,
        run.browserProfileId,
      ),
      browserExecutions: run.browserExecutions.map((execution) => ({
        ...execution,
        runtimeSession: execution.runtimeSession
          ? {
              closedAt: execution.runtimeSession.closedAt,
              commands: execution.runtimeSession.commands.map((command) => ({
                commandType: command.commandType,
                completedAt: command.completedAt,
                createdAt: command.createdAt,
                deadlineAt: command.deadlineAt,
                dispatchedAt: command.dispatchedAt,
                error: command.error,
                id: command.id,
                inputSummary: summarizeValue(command.payload),
                outputSummary: summarizeValue(command.result),
                source: command.source,
                status: command.status,
              })),
              createdAt: execution.runtimeSession.createdAt,
              events: execution.runtimeSession.events.map((event) => ({
                createdAt: event.createdAt,
                id: event.id,
                kind: event.kind,
                occurredAt: event.occurredAt,
                payload: event.payload,
              })),
              id: execution.runtimeSession.id,
              lastError: execution.runtimeSession.lastError,
              openedAt: execution.runtimeSession.openedAt,
              profileMode: execution.runtimeSession.profileMode,
              protocolMajor: execution.runtimeSession.protocolMajor,
              protocolMinor: execution.runtimeSession.protocolMinor,
              runtime: execution.runtimeSession.runtime,
              status: execution.runtimeSession.status,
            }
          : null,
      })),
      evidences: await Promise.all(
        run.evidences.map(async (evidence) => ({
          ...evidence,
          downloadUrl: evidence.runtimeArtifact
            ? await this.storage.signedDownloadUrl(
                evidence.runtimeArtifact.storageKey,
                evidence.runtimeArtifact.contentType.startsWith("video/")
                  ? 3_600
                  : 900,
              )
            : null,
          runtimeArtifact: evidence.runtimeArtifact
            ? {
                byteSize: evidence.runtimeArtifact.byteSize,
                contentType: evidence.runtimeArtifact.contentType,
                id: evidence.runtimeArtifact.id,
                sha256: evidence.runtimeArtifact.sha256,
              }
            : null,
        })),
      ),
    };
  }

  async readEvidence(
    current: ToolAuthContext,
    runId: string,
    evidenceRef: string,
    input: { cursor: number; maxBytes: number },
  ) {
    const artifactId = evidenceRef.slice("artifact://".length);
    const evidence = await this.prisma.runEvidence.findFirst({
      include: { runtimeArtifact: true },
      where: {
        externalId: evidenceRef,
        runId,
        runtimeArtifactId: artifactId,
        teamId: current.team.id,
      },
    });
    const artifact = evidence?.runtimeArtifact;
    if (!evidence || !artifact) {
      throw new NotFoundException("Run evidence was not found.");
    }
    const allowedTypes = new Set([
      "image/jpeg",
      "image/png",
      "text/html; charset=utf-8",
      "application/json",
    ]);
    if (!allowedTypes.has(artifact.contentType)) {
      throw new ConflictException("Evidence MIME type cannot be read by MCP.");
    }
    const isImage = artifact.contentType.startsWith("image/");
    if (isImage && artifact.byteSize > 1_250 * 1_024) {
      throw new ConflictException(
        "Screenshot exceeds the 1.25 MiB inline MCP image limit; capture a viewport JPEG.",
      );
    }
    if (isImage && input.cursor !== 0) {
      throw new ConflictException("Image evidence does not support cursors.");
    }
    const start = isImage ? 0 : input.cursor;
    if (start >= artifact.byteSize) {
      throw new ConflictException(
        "Evidence cursor is past the end of the file.",
      );
    }
    const length = isImage
      ? artifact.byteSize
      : Math.min(input.maxBytes, artifact.byteSize - start);
    const stored = await this.storage.get(artifact.storageKey, {
      end: start + length - 1,
      start,
    });
    const page = isImage
      ? stored.body
      : trimIncompleteUtf8(
          stored.body,
          start + stored.body.byteLength < artifact.byteSize,
        );
    const nextCursor = start + page.byteLength;
    return {
      body: page,
      contentType: artifact.contentType,
      evidenceRef,
      kind: evidence.kind,
      nextCursor: nextCursor < artifact.byteSize ? nextCursor : null,
      totalBytes: artifact.byteSize,
      truncated: nextCursor < artifact.byteSize,
    };
  }

  async events(current: ToolAuthContext, id: string, after?: bigint) {
    await this.requireRun(current.team.id, id);
    return this.prisma.runEvent.findMany({
      orderBy: { sequence: "asc" },
      take: 500,
      where: {
        runId: id,
        teamId: current.team.id,
        ...(after === undefined ? {} : { sequence: { gt: after } }),
      },
    });
  }

  async trajectory(
    current: ToolAuthContext,
    id: string,
    input: { before?: bigint; limit: number },
  ) {
    await this.requireRun(current.team.id, id);
    const fetched = await this.prisma.runEvent.findMany({
      include: { attempt: { select: { number: true } } },
      orderBy: { sequence: "desc" },
      take: input.limit + 1,
      where: {
        runId: id,
        teamId: current.team.id,
        ...(input.before === undefined
          ? {}
          : { sequence: { lt: input.before } }),
      },
    });
    const hasMore = fetched.length > input.limit;
    const selected = fetched.slice(0, input.limit).reverse();
    return {
      hasMore,
      nextBefore:
        hasMore && selected[0] ? selected[0].sequence.toString() : null,
      records: projectRunTrajectory(selected, input.before === undefined),
    };
  }

  async cancel(current: ToolAuthContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const run = await tx.executionRun.findFirst({
        where: { id, teamId: current.team.id },
      });
      if (!run) throw new NotFoundException("Run not found.");
      if (["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(run.lifecycle)) {
        return;
      }

      const now = new Date();
      const disposition = run.startedAt ? "BLOCKED" : "NOT_RUN";
      await tx.executionRun.update({
        data: {
          cancelRequestedAt: now,
          executionDisposition: disposition,
          finishedAt: now,
          lifecycle: "CANCELLED",
          verdict: null,
        },
        where: { id },
      });
      await tx.agentRuntimeTask.updateMany({
        data: { cancelRequestedAt: now, finishedAt: now, status: "CANCELLED" },
        where: {
          runId: id,
          status: { in: ["PENDING", "RUNNING", "WAITING_HUMAN"] },
        },
      });
      await tx.runAttempt.updateMany({
        data: { finishedAt: now, status: "CANCELLED" },
        where: {
          runId: id,
          status: { in: ["PENDING", "RUNNING", "WAITING_HUMAN"] },
        },
      });
      await tx.humanIntervention.updateMany({
        data: { resolvedAt: now, status: "CANCELLED" },
        where: { runId: id, status: "PENDING" },
      });
      await tx.runEvent.create({
        data: {
          actor: "CONTROL_PLANE",
          kind: "run.cancelled",
          payload: json({ requestedByCredentialId: current.credential.id }),
          runId: id,
          teamId: current.team.id,
        },
      });
    });
    return this.detail(current, id);
  }

  async resolveIntervention(
    current: ToolAuthContext,
    runId: string,
    interventionId: string,
    input: RunInterventionResolveInput,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const intervention = await tx.humanIntervention.findFirst({
        include: { browserControlLease: true, run: true, task: true },
        where: { id: interventionId, runId, teamId: current.team.id },
      });
      if (!intervention) {
        throw new NotFoundException("Human intervention not found.");
      }
      if (intervention.status === "RESOLVED") return;
      if (intervention.status !== "PENDING") {
        throw new ConflictException(
          `Human intervention is already ${intervention.status.toLowerCase()}.`,
        );
      }
      if (intervention.run.lifecycle !== "WAITING_HUMAN") {
        throw new ConflictException("The run is not waiting for human input.");
      }
      if (intervention.expiresAt && intervention.expiresAt <= new Date()) {
        throw new ConflictException("Human intervention has expired.");
      }
      if (
        intervention.browserControlLease &&
        intervention.browserControlLease.expiresAt > new Date()
      ) {
        throw new ConflictException(
          "Release browser human control before resolving the intervention.",
        );
      }

      const now = new Date();
      const snapshot = runtimeTaskSnapshotSchema.parse(
        intervention.task.snapshot,
      );
      const policyValue = isRecord(intervention.run.executionPolicy)
        ? intervention.run.executionPolicy
        : {};
      const deadlinePolicy = runDeadlinePolicySchema.parse(
        policyValue.deadline ?? { mode: "FIXED" },
      );
      const currentDeadlineAt =
        intervention.run.deadlineAt ?? new Date(snapshot.deadlineAt);
      const hardDeadlineAt =
        intervention.run.hardDeadlineAt ?? currentDeadlineAt;
      const refundHumanWait =
        deadlinePolicy.mode === "ADAPTIVE" &&
        deadlinePolicy.refundHumanWait &&
        intervention.pausedExecutionRemainingMs !== null;
      const resumedDeadlineAt = refundHumanWait
        ? new Date(
            Math.min(
              hardDeadlineAt.getTime(),
              now.getTime() + intervention.pausedExecutionRemainingMs!,
            ),
          )
        : currentDeadlineAt;
      const resumedSnapshot = runtimeTaskSnapshotSchema.parse({
        ...snapshot,
        deadlineAt: resumedDeadlineAt.toISOString(),
        hardDeadlineAt: hardDeadlineAt.toISOString(),
        executionPolicy: {
          ...snapshot.executionPolicy,
          resume: {
            interventionId,
            response: input.response,
            resolvedAt: now.toISOString(),
          },
        },
      });
      await tx.humanIntervention.update({
        data: {
          resolvedAt: now,
          resolvedBy: current.credential.id,
          response: json(input.response),
          status: "RESOLVED",
        },
        where: { id: interventionId },
      });
      await tx.agentRuntimeTask.update({
        data: {
          completionId: null,
          error: Prisma.JsonNull,
          deadlineAt: resumedDeadlineAt,
          finishedAt: null,
          result: Prisma.JsonNull,
          snapshot: json(resumedSnapshot),
          status: "PENDING",
        },
        where: { id: intervention.taskId },
      });
      await tx.runAttempt.update({
        data: {
          error: Prisma.JsonNull,
          failureClass: null,
          finishedAt: null,
          result: Prisma.JsonNull,
          status: "PENDING",
        },
        where: { id: intervention.attemptId },
      });
      await tx.executionRun.update({
        data: {
          executionDisposition: null,
          deadlineAt: resumedDeadlineAt,
          finishedAt: null,
          lifecycle: "QUEUED",
          verdict: null,
        },
        where: { id: runId },
      });
      await tx.runEvent.create({
        data: {
          actor: "HUMAN",
          attemptId: intervention.attemptId,
          kind: "human.intervention.resolved",
          payload: json({
            interventionId,
            refundedHumanWait: refundHumanWait,
            resumedDeadlineAt: resumedDeadlineAt.toISOString(),
            resolvedAt: now.toISOString(),
          }),
          runId,
          taskId: intervention.taskId,
          teamId: current.team.id,
        },
      });
      const browserExecution = await tx.browserExecution.findUnique({
        where: { attemptId: intervention.attemptId },
      });
      if (browserExecution?.runtimeSessionId) {
        await tx.browserRuntimeSession.updateMany({
          data: { leaseExpiresAt: resumedDeadlineAt },
          where: {
            id: browserExecution.runtimeSessionId,
            status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL"] },
          },
        });
        await tx.browserRuntimeSlot.updateMany({
          data: { expiresAt: resumedDeadlineAt },
          where: { sessionId: browserExecution.runtimeSessionId },
        });
        await tx.browserRuntimeProfileLease.updateMany({
          data: { expiresAt: resumedDeadlineAt },
          where: { sessionId: browserExecution.runtimeSessionId },
        });
      }
      const hitlPolicy = runHitlPolicySchema.parse(policyValue.hitl ?? {});
      if (hitlPolicy.notificationChannels.includes("AGENT_WEBHOOK")) {
        await tx.notificationOutbox.create({
          data: {
            channel: "AGENT_WEBHOOK",
            dedupeKey: `run:${runId}:intervention:${interventionId}:resolved:agent`,
            eventType: "hitl.resolved",
            executionRunId: runId,
            interventionId,
            payload: json({
              interventionId,
              response: input.response,
              resumeStatus: "QUEUED",
              runId,
              runKind: "EXECUTION_RUN",
            }),
            teamId: current.team.id,
          },
        });
      }
    });
    return this.detail(current, runId);
  }

  private async requireRun(teamId: string, id: string) {
    const run = await this.prisma.executionRun.findFirst({
      select: { id: true },
      where: { id, teamId },
    });
    if (!run) throw new NotFoundException("Run not found.");
    return run;
  }
}

interface TrajectoryEventRow {
  actor: string;
  attempt?: { number: number } | null;
  id: string;
  kind: string;
  occurredAt: Date;
  payload: unknown;
  sequence: bigint;
}

export function projectRunTrajectory(
  rows: TrajectoryEventRow[],
  includeRunningStarts = true,
): RunTrajectoryRecord[] {
  const settled = new Map<string, TrajectoryEventRow>();
  const started = new Set<string>();
  for (const row of rows) {
    const payload = recordValue(row.payload);
    const startKey = trajectoryStartKey(row.kind, payload);
    if (startKey) started.add(startKey);
    const key = trajectorySettlementKey(row.kind, payload);
    if (key) settled.set(key, row);
  }

  return rows.flatMap((row): RunTrajectoryRecord[] => {
    const payload = recordValue(row.payload);
    const startKey = trajectoryStartKey(row.kind, payload);
    if (startKey && row.kind !== "agent.segment.started") {
      if (settled.has(startKey) || !includeRunningStarts) return [];
    }
    if (row.kind === "agent.segment.completed") {
      const key = trajectorySettlementKey(row.kind, payload);
      return key && started.has(key) ? [] : [trajectoryRecord(row, payload)];
    }
    return [trajectoryRecord(row, payload)];
  });
}

function trajectoryRecord(
  row: TrajectoryEventRow,
  payload: Record<string, unknown>,
): RunTrajectoryRecord {
  const durationMs = nonnegativeInteger(payload.durationMs);
  const occurredAt = row.occurredAt.getTime();
  const settled = trajectorySettlementKey(row.kind, payload) !== null;
  const segmentId = stringValue(payload.segmentId);
  const step = positiveInteger(payload.step);
  const callId = stringValue(payload.callId) ?? stringValue(payload.commandId);
  const attemptNumber =
    positiveInteger(payload.attemptNumber) ?? row.attempt?.number ?? null;

  if (row.kind.startsWith("agent.model.")) {
    const provider = stringValue(payload.provider);
    const model = stringValue(payload.model);
    return baseTrajectoryRecord(row, {
      attemptNumber,
      callId: null,
      durationMs,
      input: payload.inputPreview ?? null,
      kind: "MODEL",
      lane: "MODEL",
      metadata: withoutKeys(payload, [
        "attemptNumber",
        "durationMs",
        "errorMessage",
        "inputPreview",
        "model",
        "outputPreview",
        "provider",
        "segmentId",
        "status",
        "step",
      ]),
      output: payload.outputPreview ?? null,
      segmentId,
      settled,
      status: trajectoryStatus(row.kind, payload),
      step,
      title: [provider, model].filter(Boolean).join(" / ") || "Model request",
    });
  }

  if (row.kind.startsWith("agent.tool.")) {
    return baseTrajectoryRecord(row, {
      attemptNumber,
      callId,
      durationMs,
      input: payload.inputPreview ?? null,
      kind: "TOOL",
      lane: "TOOLS",
      metadata: withoutKeys(payload, [
        "attemptNumber",
        "callId",
        "durationMs",
        "errorMessage",
        "inputPreview",
        "name",
        "outputPreview",
        "segmentId",
        "status",
        "step",
      ]),
      output: payload.outputPreview ?? null,
      segmentId,
      settled,
      status: trajectoryStatus(row.kind, payload),
      step,
      title: stringValue(payload.name) ?? "Tool call",
    });
  }

  if (row.kind === "agent.segment.started") {
    return baseTrajectoryRecord(row, {
      attemptNumber,
      callId: null,
      durationMs: 0,
      input: payload.inputPreview ?? null,
      kind: "INPUT",
      lane: "INPUT",
      metadata: withoutKeys(payload, [
        "attemptNumber",
        "inputPreview",
        "segmentId",
      ]),
      output: null,
      segmentId,
      settled: true,
      status: "SUCCEEDED",
      step: null,
      title: `Attempt ${attemptNumber ?? "?"} input`,
    });
  }

  const browserCommand = row.kind.startsWith("browser.command.");
  const lane: RunTrajectoryRecord["lane"] = browserCommand ? "TOOLS" : "INPUT";
  return baseTrajectoryRecord(row, {
    attemptNumber,
    callId,
    durationMs,
    input: null,
    kind: browserCommand ? "RUNTIME" : "INPUT",
    lane,
    metadata: {},
    output: payload,
    segmentId,
    settled,
    status: trajectoryStatus(row.kind, payload),
    step,
    title: browserCommand
      ? `Browser · ${stringValue(payload.commandType) ?? "command"}`
      : row.kind,
  });
}

function baseTrajectoryRecord(
  row: TrajectoryEventRow,
  value: {
    attemptNumber: number | null;
    callId: string | null;
    durationMs: number | null;
    input: unknown;
    kind: RunTrajectoryRecord["kind"];
    lane: RunTrajectoryRecord["lane"];
    metadata: Record<string, unknown>;
    output: unknown;
    segmentId: string | null;
    settled: boolean;
    status: RunTrajectoryRecord["status"];
    step: number | null;
    title: string;
  },
): RunTrajectoryRecord {
  const completedAt = value.settled ? row.occurredAt.toISOString() : null;
  const startTime =
    value.settled && value.durationMs !== null
      ? row.occurredAt.getTime() - value.durationMs
      : row.occurredAt.getTime();
  const payload = recordValue(row.payload);
  return {
    actor: row.actor,
    attemptNumber: value.attemptNumber,
    callId: value.callId,
    completedAt,
    durationMs: value.durationMs,
    error: errorText(payload.errorMessage ?? payload.error),
    id: row.id,
    input: value.input,
    kind: value.kind,
    lane: value.lane,
    metadata: value.metadata,
    output: value.output,
    segmentId: value.segmentId,
    sequence: row.sequence.toString(),
    startedAt: new Date(Math.max(0, startTime)).toISOString(),
    status: value.status,
    step: value.step,
    title: value.title,
  };
}

function trajectoryStartKey(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  if (kind === "agent.segment.started") {
    return keyed("segment", payload.segmentId);
  }
  if (kind === "agent.model.started") {
    return keyed("model", payload.segmentId, payload.step);
  }
  if (kind === "agent.tool.started") {
    return keyed("tool", payload.segmentId, payload.callId);
  }
  if (kind === "browser.command.started") {
    return keyed("browser", payload.commandId);
  }
  return null;
}

function trajectorySettlementKey(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  if (kind === "agent.segment.completed") {
    return keyed("segment", payload.segmentId);
  }
  if (kind === "agent.model.completed" || kind === "agent.model.failed") {
    return keyed("model", payload.segmentId, payload.step);
  }
  if (kind === "agent.tool.completed" || kind === "agent.tool.failed") {
    return keyed("tool", payload.segmentId, payload.callId);
  }
  if (kind === "browser.command.completed") {
    return keyed("browser", payload.commandId);
  }
  return null;
}

function keyed(prefix: string, ...values: unknown[]): string | null {
  if (values.some((value) => value === null || value === undefined))
    return null;
  return `${prefix}:${values.map(String).join(":")}`;
}

function trajectoryStatus(
  kind: string,
  payload: Record<string, unknown>,
): RunTrajectoryRecord["status"] {
  const status = stringValue(payload.status)?.toUpperCase();
  if (status === "WAITING_HUMAN") return "WAITING_HUMAN";
  if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(status ?? "")) {
    return "FAILED";
  }
  if (status === "SUCCEEDED" || status === "COMPLETED") return "SUCCEEDED";
  if (kind.endsWith(".started")) return "RUNNING";
  if (/failed|timed_out|cancelled/iu.test(kind)) return "FAILED";
  if (/waiting_human|intervention\.requested/iu.test(kind)) {
    return "WAITING_HUMAN";
  }
  if (/completed|succeeded|acquired|released|claimed/iu.test(kind)) {
    return "SUCCEEDED";
  }
  return "INFO";
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function withoutKeys(
  value: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.has(key)),
  );
}

function errorText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assertCompatibleRunRequest(
  existing: {
    criteriaSnapshot: unknown;
    environmentSnapshot: unknown;
    executionPolicy: unknown;
    goal: string;
    taskExecutionId: string | null;
  },
  input: ExecutionRunCreateInput,
  taskExecutionId: string | null,
) {
  if (
    taskExecutionId &&
    existing.taskExecutionId &&
    existing.taskExecutionId !== taskExecutionId
  ) {
    throw new ConflictException(
      "The idempotency key already belongs to another task execution.",
    );
  }
  const expectedPolicy = {
    browser: input.browserPolicy,
    businessReferences: input.businessReferences,
    deadline: runDeadlinePolicySchema.parse(
      input.deadlinePolicy ?? { mode: "FIXED" },
    ),
    hitl: input.hitlPolicy,
    retryPolicy: input.retryPolicy,
  };
  const storedPolicy = isRecord(existing.executionPolicy)
    ? existing.executionPolicy
    : {};
  if (
    existing.goal !== input.goal ||
    !sameJson(existing.criteriaSnapshot, input.criteria) ||
    !sameJson(existing.environmentSnapshot, input.environment) ||
    !sameJson(
      {
        ...storedPolicy,
        businessReferences:
          storedPolicy.businessReferences ?? input.businessReferences,
        deadline:
          storedPolicy.deadline ??
          runDeadlinePolicySchema.parse({ mode: "FIXED" }),
        hitl: storedPolicy.hitl ?? input.hitlPolicy,
      },
      expectedPolicy,
    )
  ) {
    throw new ConflictException(
      "The idempotency key already belongs to a different run request.",
    );
  }
}

function trimIncompleteUtf8(body: Buffer, hasMoreBytes: boolean) {
  const maximumTrim = hasMoreBytes ? Math.min(3, body.byteLength) : 0;
  for (let trim = 0; trim <= maximumTrim; trim += 1) {
    const candidate = body.subarray(0, body.byteLength - trim);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(candidate);
      return candidate;
    } catch {
      // A ranged object read may end inside a multi-byte UTF-8 character.
    }
  }
  throw new ConflictException(
    "Evidence is not valid UTF-8 at this cursor; continue with the returned nextCursor.",
  );
}

function isUniqueConstraint(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
