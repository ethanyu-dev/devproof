import {
  resolveAccountReplacement,
  accountReplacementState,
} from "./account-replacement.js";
import { env } from "../config/env.js";
import { executionCleanup, executionVerification } from "./execution-cleanup.js";
import { freezeObservationContract } from "@devproof/agent-runtime-protocol/observation-digest";
import { randomBytes, randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  browserExecutionSnapshot,
  businessTestAccountSchema,
  testAccountBindingsSchema,
  testAccountInputSlotsSchema,
  readExecutionState,
  networkAcceptanceError,
  runtimeTaskSnapshotSchema,
} from "@devproof/agent-runtime-protocol";
import type {
  ExecutionRunCreateInput,
  RunInterventionResolveInput,
  RunTrajectoryRecord,
} from "@devproof/contracts";
import {
  DEFAULT_EXECUTION_BUDGET_SECONDS,
  runDeadlinePolicySchema,
  runHitlPolicySchema,
} from "@devproof/contracts";

import { initializeExecutionBudget } from "./execution-budget.js";
import { PrismaService } from "../database/prisma.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import { summarizeValue } from "../observability/observability.service.js";
import { refreshedTaskDeadline } from "../task-executions/task-deadline.js";
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
    for (const criterion of input.criteria) {
      const error = networkAcceptanceError(criterion);
      if (error) throw new BadRequestException(error);
    }
    input = {
      ...input,
      criteria: input.criteria.map((c) =>
        c.observationContract
          ? {
              ...c,
              observationContract: freezeObservationContract(
                c.observationContract,
                c.id,
              ),
            }
          : c,
      ),
    };
    if (
      new Set(input.criteria.map((c) => c.id)).size !== input.criteria.length ||
      input.criteria.reduce(
        (n, c) => n + (c.observationContract?.targets.length ?? 0),
        0,
      ) > 200 ||
      input.criteria.reduce(
        (n, c) => n + (c.observationContract?.comparisons.length ?? 0),
        0,
      ) > 100
    )
      throw new BadRequestException(
        "OBSERVATION_CONTRACT_LIMIT: criterion IDs must be unique, with at most 200 targets and 100 comparisons per execution.",
      );
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
    // Queue waiting has its own deadline; execution time starts on first claim.
    const requestedDeadlineAt =
      parentTask?.deadlineAt ??
      new Date(now.getTime() + Math.max(300, input.deadlineSeconds) * 1_000);
    const deadlineAt = new Date(
      Math.min(
        requestedDeadlineAt.getTime(),
        parentTask?.deadlineAt.getTime() ?? Number.POSITIVE_INFINITY,
      ),
    );
    if (deadlineAt <= now) {
      throw new ConflictException("The parent task deadline has elapsed.");
    }
    const hardDeadlineAt = deadlineAt;
    if (
      !env().BROWSER_OBSERVATION_V2_ENABLED &&
      input.criteria.some((c) => c.observationContract)
    )
      throw new BadRequestException(
        "OBSERVATION_V2_DISABLED: new v2 executions are paused.",
      );
    const observationPolicy = input.observationPolicy ?? {
      combinedObservation: true,
      observationFocus: true,
      observationDelta: false,
      formSequences: false,
    };
    const runId = randomUUID();
    const attemptId = randomUUID();
    const taskId = randomUUID();
    const traceId = randomBytes(16).toString("hex");
    const provider = input.model?.provider ?? "CODEX";
    const snapshot = browserExecutionSnapshot(
      runtimeTaskSnapshotSchema.parse({
        attemptId,
        attemptNumber: 1,
        businessReferences: input.businessReferences,
        criteria: input.criteria,
        deadlineAt: deadlineAt.toISOString(),
        hardDeadlineAt: hardDeadlineAt.toISOString(),
        environment: input.environment,
        executionPolicy: {
          accountRequirements: input.accountRequirements ?? {
            version: 2,
            requirements: [],
          },
          ...observationPolicy,
          testAccounts: input.testAccounts,
          browser: input.browserPolicy,
          concurrency: input.concurrencyPolicy,
          deadline: deadlinePolicy,
          hitl: input.hitlPolicy,
          retryPolicy: input.retryPolicy,
        },
        goal: input.goal,
        ...(input.model ? { model: input.model } : {}),
        runId,
        teamId: current.team.id,
        traceId,
      }),
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.executionRun.create({
          data: {
            criteriaSnapshot: json(input.criteria),
            browserProfileId,
            currentAttemptNumber: 1,
            concurrencyPolicy: input.concurrencyPolicy
              ? json(input.concurrencyPolicy)
              : Prisma.JsonNull,
            deadlineAt,
            queueDeadlineAt: deadlineAt,
            executionBudgetSeconds: input.deadlineSeconds,
            executionMaxExtensionSeconds:
              deadlinePolicy.mode === "ADAPTIVE"
                ? deadlinePolicy.maxExtensionSeconds
                : 0,
            deadlineExtensionCount: 0,
            deadlineExtendedMs: 0,
            environmentSnapshot: json(input.environment),
            executionPolicy: json({
              accountRequirements: input.accountRequirements ?? {
                version: 2,
                requirements: [],
              },
              ...observationPolicy,
              initialTestAccounts: input.testAccounts ?? [],
              testAccounts: input.testAccounts,
              browser: input.browserPolicy,
              concurrency: input.concurrencyPolicy,
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
        await tx.browserExecution.create({
          data: {
            attemptId,
            input: json(browserAdmissionInput(input)),
            runId,
            status: "REQUESTED",
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
        events: {
          where: { kind: "observation.visual.reviewed" },
          select: { id: true, attemptId: true, payload: true },
          orderBy: { occurredAt: "asc" },
          take: 1000,
        },
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

  async downloadEvidence(
    current: ToolAuthContext,
    runId: string,
    evidenceId: string,
    range?: string,
  ) {
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/u.test(range)) {
      throw new BadRequestException("Only one byte range is supported.");
    }
    const evidence = await this.prisma.runEvidence.findFirst({
      where: { id: evidenceId, runId, teamId: current.team.id },
      include: { runtimeArtifact: true },
    });
    if (!evidence?.runtimeArtifact)
      throw new NotFoundException("Evidence not found.");
    try {
      return await this.storage.downloadStream(
        evidence.runtimeArtifact.storageKey,
        range,
      );
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 416
      ) {
        throw new HttpException("Requested range is not satisfiable.", 416);
      }
      throw error;
    }
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
                runtime: {
                  select: { id: true, name: true, status: true, version: true },
                },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        criterionResults: { orderBy: { criterionId: "asc" } },
        observationBindings: { orderBy: { createdAt: "desc" }, take: 1001 },
        events: {
          where: { kind: "observation.visual.reviewed" },
          select: { id: true, attemptId: true, payload: true },
          orderBy: { occurredAt: "desc" },
          take: 1001,
        },
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
            result: true,
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

    const sessionIds = run.browserExecutions.flatMap((execution) =>
      execution.runtimeSessionId ? [execution.runtimeSessionId] : [],
    );
    const recoveries = sessionIds.length
      ? await this.prisma.runtimeSessionRecovery.findMany({
          where: { teamId: current.team.id, sessionId: { in: sessionIds } },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            closureState: true,
            writeOutcomeState: true,
            sessionId: true,
            lastErrorCode: true,
            resolvedAt: true,
          },
        })
      : [];
    return {
      ...run,
      recoveries,
      ...executionVerification(run),
      tasks: run.tasks.map(({ result, ...task }) => ({
        ...task,
        cleanup: executionCleanup(result),
      })),
      observationHistoryTruncated:
        run.observationBindings.length > 1000 || run.events.length > 1000,
      observationBindings: run.observationBindings.slice(0, 1000),
      events: run.events.slice(0, 1000).reverse(),
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
            ? `/console/api/runs/${encodeURIComponent(run.id)}/evidences/${encodeURIComponent(evidence.id)}/download`
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

  async evidenceCatalog(
    current: ToolAuthContext,
    id: string,
    attemptId: string,
    after?: string,
  ) {
    await this.requireRun(current.team.id, id);
    const attempt = await this.prisma.runAttempt.findFirst({
      where: { id: attemptId, runId: id, teamId: current.team.id },
    });
    if (!attempt) throw new NotFoundException("Attempt not found.");
    const result = isRecord(attempt.result) ? attempt.result : {};
    const recoveryVerification =
      isRecord(result.error) &&
      isRecord(result.error.details) &&
      isRecord(result.error.details.verification)
        ? result.error.details.verification
        : {};
    const catalogValue =
      result.evidenceCatalog ?? recoveryVerification.evidenceCatalog;
    const catalog = isRecord(catalogValue) ? catalogValue : null;
    const where = {
      attemptId,
      runId: id,
      teamId: current.team.id,
      ...(typeof catalog?.sealedAt === "string"
        ? { createdAt: { lte: new Date(catalog.sealedAt) } }
        : {}),
    };
    const rows = await this.prisma.runEvidence.findMany({
      where: { ...where, ...(after ? { externalId: { gt: after } } : {}) },
      orderBy: { externalId: "asc" },
      take: 201,
      select: {
        id: true,
        externalId: true,
        kind: true,
        label: true,
        metadata: true,
        createdAt: true,
      },
    });
    return {
      version: 1,
      runId: id,
      attemptId,
      total: await this.prisma.runEvidence.count({ where }),
      digest: catalog?.digest ?? null,
      sealedAt: catalog?.sealedAt ?? null,
      entries: rows.slice(0, 200),
      nextCursor: rows.length > 200 ? rows[199]!.externalId : null,
    };
  }

  async events(current: ToolAuthContext, id: string, after?: bigint) {
    await this.requireRun(current.team.id, id);
    const rows = await this.prisma.runEvent.findMany({
      orderBy: { sequence: "asc" },
      take: 500,
      where: {
        runId: id,
        teamId: current.team.id,
        ...(after === undefined ? {} : { sequence: { gt: after } }),
      },
    });
    return rows.map((row) => ({ ...row, sequence: row.sequence.toString() }));
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
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      const intervention = await tx.humanIntervention.findFirst({
        include: {
          browserControlLease: true,
          run: { include: { taskExecution: true } },
          task: true,
        },
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
      let response = input.response;
      let resumedAccounts:
        ReturnType<typeof testAccountBindingsSchema.parse> | undefined;
      const savedPolicy =
        isRecord(intervention.task.snapshot) &&
        isRecord(intervention.task.snapshot.executionPolicy)
          ? intervention.task.snapshot.executionPolicy
          : {};
      const replacementPolicy = {
        ...savedPolicy,
        ...(isRecord(intervention.run.executionPolicy)
          ? intervention.run.executionPolicy
          : {}),
      };
      const replacement = ["DATA_PRECONDITION", "TEST_ACCOUNT"].includes(
        intervention.kind,
      )
        ? resolveAccountReplacement(
            input.response,
            replacementPolicy,
            intervention.context,
          )
        : undefined;
      if (intervention.kind === "TEST_ACCOUNT" && !replacement) {
        const slots = testAccountInputSlotsSchema.parse(
          isRecord(intervention.context)
            ? (intervention.context.accountSlots ?? [])
            : [],
        );
        const originalPolicy = isRecord(intervention.run.executionPolicy)
          ? intervention.run.executionPolicy
          : {};
        if (slots.length) {
          const previous = testAccountBindingsSchema.parse(
            originalPolicy.testAccounts ?? [],
          );
          if (
            typeof input.response.instructions === "string" &&
            input.response.instructions.trim().length >= 5 &&
            input.response.instructions.trim().length <= 2000 &&
            input.response.accounts === undefined &&
            input.response.account === undefined
          ) {
            response = {
              instructions: input.response.instructions.trim(),
              accounts: Object.fromEntries(
                previous.map((b) => [b.slotId, b.account]),
              ),
            };
          } else {
            const provided = isRecord(input.response.accounts)
              ? input.response.accounts
              : {};
            if (
              input.response.account !== undefined ||
              input.response.instructions !== undefined ||
              Object.keys(provided).some(
                (id) => !slots.some((slot) => slot.slotId === id),
              )
            )
              throw new BadRequestException(
                "请按请求的账号角色填写，处置意见需单独提交。",
              );
            const replacements = slots.map((slot) => {
              const parsed = businessTestAccountSchema.safeParse(
                provided[slot.slotId],
              );
              if (!parsed.success)
                throw new BadRequestException(
                  `请填写「${slot.label}」的有效账号标识。`,
                );
              return { ...slot, account: parsed.data, aliases: [] };
            });
            resumedAccounts = [
              ...previous.filter(
                (binding) =>
                  !slots.some((slot) => slot.slotId === binding.slotId),
              ),
              ...replacements,
            ];
            response = {
              accounts: Object.fromEntries(
                replacements.map((b) => [b.slotId, b.account]),
              ),
            };
          }
        } else {
          const account = businessTestAccountSchema.safeParse(
            input.response.account,
          );
          const instructions =
            typeof input.response.instructions === "string"
              ? input.response.instructions.trim()
              : "";
          if (instructions) {
            if (
              instructions.length < 5 ||
              instructions.length > 2000 ||
              input.response.account !== undefined
            )
              throw new BadRequestException(
                "处置意见需为 5–2000 个字符，请与提供新账号分开提交。",
              );
            const policy =
              isRecord(intervention.task.snapshot) &&
              isRecord(intervention.task.snapshot.executionPolicy)
                ? intervention.task.snapshot.executionPolicy
                : {};
            const previous =
              readExecutionState(policy).account ??
              (isRecord(policy.resume) && isRecord(policy.resume.response)
                ? policy.resume.response.account
                : undefined);
            response = {
              instructions,
              ...(typeof previous === "string" ? { account: previous } : {}),
            };
          } else {
            if (!account.success)
              throw new BadRequestException(
                "请填写手机号、UUID、邮箱或用户 ID；删除或重建说明请通过“处置意见”提交。",
              );
            response = { account: account.data };
          }
        }
      }
      if (replacement) {
        response = replacement.response;
        resumedAccounts = replacement.accounts;
      }
      const legacyAccount =
        replacement?.account ??
        (intervention.kind === "TEST_ACCOUNT" &&
        !resumedAccounts &&
        typeof response.account === "string"
          ? response.account
          : undefined);
      const priorState = readExecutionState(replacementPolicy);
      const accountChanged = resumedAccounts
        ? JSON.stringify(resumedAccounts) !==
          JSON.stringify(replacementPolicy.testAccounts ?? [])
        : legacyAccount !== undefined && legacyAccount !== priorState.account;
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
      const parentTask = intervention.run.taskExecution;
      if (
        parentTask &&
        (parentTask.cancelRequestedAt ||
          ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(
            parentTask.lifecycle,
          ))
      ) {
        throw new ConflictException("The parent task is already terminal.");
      }
      const refreshedParentDeadlineAt = parentTask
        ? refreshedTaskDeadline(parentTask.inputSnapshot, now)
        : null;
      const snapshot = runtimeTaskSnapshotSchema.parse(
        intervention.task.snapshot,
      );
      const policyValue = isRecord(intervention.run.executionPolicy)
        ? intervention.run.executionPolicy
        : {};
      const deadlinePolicy = runDeadlinePolicySchema.parse(
        policyValue.deadline ?? { mode: "FIXED" },
      );
      // Generated cases also pick up the larger default when resuming an older
      // Run. Explicit budgets on standalone Runs remain authoritative.
      const executionBudgetSeconds =
        intervention.run.sourceKind === "TASK_CASE"
          ? Math.max(
              DEFAULT_EXECUTION_BUDGET_SECONDS,
              intervention.run.executionBudgetSeconds ?? 0,
            )
          : (intervention.run.executionBudgetSeconds ??
            DEFAULT_EXECUTION_BUDGET_SECONDS);
      const executionMaxExtensionSeconds =
        deadlinePolicy.mode === "ADAPTIVE"
          ? (intervention.run.executionMaxExtensionSeconds ??
            deadlinePolicy.maxExtensionSeconds)
          : 0;
      const {
        deadlineAt: resumedDeadlineAt,
        hardDeadlineAt: resumedHardDeadlineAt,
      } = initializeExecutionBudget({
        now,
        seconds: executionBudgetSeconds,
        extensionSeconds: executionMaxExtensionSeconds,
        parentDeadlineAt: refreshedParentDeadlineAt,
      });
      const resumedSnapshot = runtimeTaskSnapshotSchema.parse({
        ...snapshot,
        deadlineAt: resumedDeadlineAt.toISOString(),
        hardDeadlineAt: resumedHardDeadlineAt.toISOString(),
        executionPolicy: {
          ...snapshot.executionPolicy,
          ...policyValue,
          ...(accountChanged
            ? {
                ...(resumedAccounts ? { testAccounts: resumedAccounts } : {}),
                accountCoordinationPending: true,
                accountRevisionStartedAt: now.toISOString(),
                executionState: accountReplacementState(
                  snapshot.executionPolicy,
                  resumedAccounts,
                  legacyAccount,
                ),
                verificationCheckpoint: {
                  ...(isRecord(snapshot.executionPolicy.verificationCheckpoint)
                    ? snapshot.executionPolicy.verificationCheckpoint
                    : {}),
                  criteria: [],
                  observations: [],
                },
              }
            : {}),
          resume: {
            interventionId,
            kind: intervention.kind,
            context: intervention.context,
            response,
            resolvedAt: now.toISOString(),
          },
          humanResolutions: [
            ...(Array.isArray(policyValue.humanResolutions)
              ? policyValue.humanResolutions
              : []),
            {
              interventionId,
              kind: intervention.kind,
              context: intervention.context,
              response,
              resolvedAt: now.toISOString(),
            },
          ].slice(-20),
        },
      });
      if (parentTask && refreshedParentDeadlineAt) {
        const parentClaim = await tx.taskExecution.updateMany({
          data: {
            deadlineAt: refreshedParentDeadlineAt,
            projectionNeededAt: now,
          },
          where: {
            cancelRequestedAt: null,
            id: parentTask.id,
            lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
          },
        });
        if (parentClaim.count !== 1) {
          throw new ConflictException("The parent task is already terminal.");
        }
      }
      const runClaim = await tx.executionRun.updateMany({
        data: {
          ...(accountChanged
            ? {
                executionPolicy: json({
                  ...policyValue,
                  ...resumedSnapshot.executionPolicy,
                }),
              }
            : {}),
          executionDisposition: null,
          deadlineAt: resumedDeadlineAt,
          initialDeadlineAt: resumedDeadlineAt,
          executionBudgetStartedAt: now,
          executionBudgetSeconds,
          executionMaxExtensionSeconds,
          deadlineExtensionCount: 0,
          deadlineExtendedMs: 0,
          finishedAt: null,
          hardDeadlineAt: resumedHardDeadlineAt,
          lifecycle: "QUEUED",
          verdict: null,
        },
        where: {
          cancelRequestedAt: null,
          id: runId,
          lifecycle: "WAITING_HUMAN",
          teamId: current.team.id,
        },
      });
      if (runClaim.count !== 1) {
        throw new ConflictException(
          "The run can no longer accept human input.",
        );
      }
      const interventionClaim = await tx.humanIntervention.updateMany({
        data: {
          resolvedAt: now,
          resolvedBy: current.credential.id,
          response: json(response),
          status: "RESOLVED",
        },
        where: {
          id: interventionId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          runId,
          status: "PENDING",
          teamId: current.team.id,
        },
      });
      if (interventionClaim.count !== 1) {
        throw new ConflictException(
          "The human intervention can no longer be resolved.",
        );
      }
      if (accountChanged) {
        const oldProgress = isRecord(
          snapshot.executionPolicy.verificationCheckpoint,
        )
          ? snapshot.executionPolicy.verificationCheckpoint
          : {};
        if (Array.isArray(oldProgress.criteria) && oldProgress.criteria.length)
          await tx.runCriterionResult.updateMany({
            where: { attemptId: intervention.attemptId, runId },
            data: {
              status: "INCONCLUSIVE",
              summary:
                "人工已更换当前账号，需在新账号上重新核对；原结果保留在换号事件与历史上下文。",
            },
          });
      }
      await tx.agentRuntimeTask.update({
        data: {
          completionId: null,
          error: Prisma.JsonNull,
          deadlineAt: resumedDeadlineAt,
          finishedAt: null,
          result: Prisma.JsonNull,
          snapshot: json(resumedSnapshot),
          lastDeadlineExtensionOperationKey: null,
          lastDeadlineExtensionProgressKey: null,
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
      await tx.runEvent.create({
        data: {
          actor: "HUMAN",
          attemptId: intervention.attemptId,
          kind: "human.intervention.resolved",
          payload: json({
            interventionId,
            ...(accountChanged
              ? {
                  accountRevision: readExecutionState(
                    resumedSnapshot.executionPolicy,
                  ).accountRevision,
                  resolution: response.resolution ?? {
                    kind: "REPLACE_ACCOUNT",
                    accounts: response.accounts,
                    account: response.account,
                  },
                  supersededCheckpoint:
                    snapshot.executionPolicy.verificationCheckpoint ?? null,
                }
              : {}),
            ...(refreshedParentDeadlineAt
              ? {
                  parentTaskDeadlineAt: refreshedParentDeadlineAt.toISOString(),
                }
              : {}),
            refundedHumanWait: true,
            executionBudgetRefreshed: true,
            executionBudgetSeconds,
            resumedDeadlineAt: resumedDeadlineAt.toISOString(),
            resumedHardDeadlineAt: resumedHardDeadlineAt.toISOString(),
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
        const renewed = await tx.browserRuntimeSession.updateMany({
          data: {
            leaseExpiresAt: resumedDeadlineAt,
            executionPermitExpiresAt: new Date(
              Math.min(resumedDeadlineAt.getTime(), now.getTime() + 120_000),
            ),
          },
          where: {
            id: browserExecution.runtimeSessionId,
            status: "ACTIVE",
            ownerTaskId: intervention.taskId,
            ownerFencingToken: intervention.task.fencingToken,
            leaseExpiresAt: { gt: now },
            quarantinedAt: null,
            closureVerifiedAt: null,
            closedAt: null,
          },
        });
        if (renewed.count === 1) {
          await tx.browserRuntimeSlot.updateMany({
            data: { expiresAt: resumedDeadlineAt },
            where: { sessionId: browserExecution.runtimeSessionId },
          });
          await tx.browserRuntimeProfileLease.updateMany({
            data: { expiresAt: resumedDeadlineAt },
            where: { sessionId: browserExecution.runtimeSessionId },
          });
        }
        // A lost/closed session cannot be made claimable by renewing its lease.
        // The recovery worker fences the old task and schedules a new Attempt
        // only after verified closure and a settled business-write assessment.
        await tx.taskCaseExecution.updateMany({
          where: { runId },
          data: {
            scheduling: {
              state: renewed.count === 1 ? "READY" : "RECOVERING",
              reason: renewed.count === 1 ? null : "LEASE_RECOVERY",
              waitingSince: now.toISOString(),
              evaluatedAt: now.toISOString(),
              blockedBy:
                renewed.count === 1
                  ? null
                  : {
                      resourceType: "SESSION",
                      sessionId: browserExecution.runtimeSessionId,
                    },
              queue: null,
              nextRetryAt: now.toISOString(),
            },
          },
        });
      }
      const hitlPolicy = runHitlPolicySchema.parse(policyValue.hitl ?? {});
      if (hitlPolicy.notificationChannels.includes("FEISHU")) {
        await tx.notificationOutbox.create({
          data: {
            channel: "FEISHU",
            dedupeKey: `run:${runId}:intervention:${interventionId}:resolved:feishu`,
            eventType: "hitl.resolved",
            executionRunId: runId,
            interventionId,
            payload: json({
              interventionId,
              notificationKind: "HITL_RESOLVED",
              resolvedAt: now.toISOString(),
              resumeStatus: "QUEUED",
              runId,
              runKind: "EXECUTION_RUN",
            }),
            teamId: current.team.id,
          },
        });
      }
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

function browserAdmissionInput(input: ExecutionRunCreateInput) {
  const targetUrl =
    typeof input.environment.targetUrl === "string"
      ? input.environment.targetUrl
      : undefined;
  return {
    availabilityPolicy: input.browserPolicy.availabilityPolicy,
    profile: input.browserPolicy.profile,
    requiredCapabilities: input.browserPolicy.requiredCapabilities,
    ...(targetUrl ? { targetUrl } : {}),
  };
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
  const pending = new Map<string, TrajectoryEventRow>();
  const pairs = new Map<string, TrajectoryEventRow>();
  const pairedStarts = new Set<string>();
  const segmentEnds = new Map<string, TrajectoryEventRow>();
  // Match in event order. A settled candidate must not consume a later fallback
  // start, including legacy runtimes that reuse the same model in one step.
  for (const row of [...rows].sort((a, b) =>
    a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0,
  )) {
    const payload = recordValue(row.payload);
    const startKey = trajectoryStartKey(row.kind, payload);
    if (startKey) pending.set(startKey, row);
    const key = trajectorySettlementKey(row.kind, payload);
    const start = key ? pending.get(key) : undefined;
    if (start && key) {
      pairs.set(row.id, start);
      pairedStarts.add(start.id);
      pending.delete(key);
    }
    if (
      row.kind === "agent.segment.completed" &&
      typeof payload.segmentId === "string"
    ) {
      segmentEnds.set(payload.segmentId, row);
    }
  }

  return rows.flatMap((row): RunTrajectoryRecord[] => {
    const payload = recordValue(row.payload);
    const startKey = trajectoryStartKey(row.kind, payload);
    if (startKey && row.kind !== "agent.segment.started") {
      if (pairedStarts.has(row.id) || !includeRunningStarts) return [];
    }
    const projected = trajectoryRecord(row, payload);
    const start = pairs.get(row.id);
    // Stable IDs replace the in-flight row when polling, even if the start has
    // fallen outside the current event page. Preserve legacy start IDs too.
    if (row.kind.startsWith("agent.model.")) {
      projected.id = stringValue(payload.modelCallId) ?? start?.id ?? row.id;
    } else if (start && row.kind !== "agent.segment.completed") {
      projected.id = start.id;
    }
    if (start) projected.startedAt = start.occurredAt.toISOString();
    if (projected.status === "RUNNING" && projected.segmentId) {
      const end = segmentEnds.get(projected.segmentId);
      if (end && end.sequence > row.sequence) {
        const endPayload = recordValue(end.payload);
        projected.status = "FAILED";
        projected.completedAt = end.occurredAt.toISOString();
        projected.durationMs = Math.max(
          0,
          end.occurredAt.getTime() - row.occurredAt.getTime(),
        );
        projected.error =
          errorText(endPayload.errorMessage) ??
          "Execution segment ended before this operation completed.";
      }
    }
    return [projected];
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
  const segmentCompleted = row.kind === "agent.segment.completed";
  const lane: RunTrajectoryRecord["lane"] = browserCommand ? "TOOLS" : "INPUT";
  return baseTrajectoryRecord(row, {
    attemptNumber,
    callId,
    durationMs,
    input: null,
    kind: browserCommand || segmentCompleted ? "RUNTIME" : "INPUT",
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
    return stringValue(payload.modelCallId)
      ? keyed("model-call", payload.modelCallId)
      : keyed(
          "model",
          payload.segmentId,
          payload.step,
          payload.provider ?? "",
          payload.model ?? "",
        );
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
    return stringValue(payload.modelCallId)
      ? keyed("model-call", payload.modelCallId)
      : keyed(
          "model",
          payload.segmentId,
          payload.step,
          payload.provider ?? "",
          payload.model ?? "",
        );
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
    accountRequirements: input.accountRequirements ?? {
      version: 2,
      requirements: [],
    },
    initialTestAccounts: input.testAccounts ?? [],
    concurrency: input.concurrencyPolicy,
    ...(input.observationPolicy ?? {
      combinedObservation: true,
      observationFocus: true,
      observationDelta: false,
      formSequences: false,
    }),
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
        browser: storedPolicy.browser,
        retryPolicy: storedPolicy.retryPolicy,
        concurrency: storedPolicy.concurrency,
        accountRequirements: storedPolicy.accountRequirements ?? {
          version: 2,
          requirements: [],
        },
        initialTestAccounts:
          storedPolicy.initialTestAccounts ?? storedPolicy.testAccounts ?? [],
        combinedObservation: storedPolicy.combinedObservation ?? true,
        observationFocus: storedPolicy.observationFocus ?? true,
        observationDelta: storedPolicy.observationDelta ?? false,
        formSequences: storedPolicy.formSequences ?? false,
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
