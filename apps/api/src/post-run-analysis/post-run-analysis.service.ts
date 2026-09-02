import { createHash, randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import {
  POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD,
  POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD,
  prepareJsonObjectStream,
  prepareStructuredEvidenceArchiveStream,
  TaskLogBundleService,
} from "./task-log-bundle.service.js";
import {
  postRunAnalysisHardDeadline,
  postRunAnalysisRetryAt,
} from "./post-run-analysis-scheduling.js";
import {
  buildPostRunAnalysisProgress,
  POST_RUN_ANALYSIS_EVENT_CATEGORIES,
  postRunAnalysisEventKinds,
  type PostRunAnalysisEventCategory,
} from "./post-run-analysis-progress.js";

const TERMINAL_TASK_LIFECYCLES = [
  "COMPLETED",
  "CANCELLED",
  "TIMED_OUT",
] as const;
const TERMINAL_BROWSER_STATUSES = [
  "RELEASED",
  "FAILED",
  "LOST",
  "TIMED_OUT",
] as const;
const EVENT_PAGE_SIZE = 200;
const CAPTURE_CLAIM_STALE_MS = 15 * 60 * 1_000;
const POST_RUN_ANALYSIS_DETAIL_SELECT = {
  analyzerVersion: true,
  attemptNumber: true,
  createdAt: true,
  error: true,
  deadlineAt: true,
  events: true,
  findings: {
    include: { workItem: true },
    orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
  },
  finishedAt: true,
  generation: true,
  id: true,
  hardDeadlineAt: true,
  inputByteSize: true,
  inputCompleteness: true,
  inputSha256: true,
  maxAttempts: true,
  nextAttemptAt: true,
  readyAt: true,
  startedAt: true,
  status: true,
  updatedAt: true,
  workItem: true,
} satisfies Prisma.PostRunAnalysisJobSelect;

type PostRunAnalysisDetailRow = Prisma.PostRunAnalysisJobGetPayload<{
  select: typeof POST_RUN_ANALYSIS_DETAIL_SELECT;
}>;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function earliestDate(
  beforeOrAt: Date,
  ...values: Array<Date | null | undefined>
) {
  return values
    .filter(
      (value): value is Date =>
        value instanceof Date && value.getTime() <= beforeOrAt.getTime(),
    )
    .sort((left, right) => left.getTime() - right.getTime())[0];
}

async function enqueueObjectDeletions(
  tx: Prisma.TransactionClient,
  storageKeys: Array<string | null | undefined>,
) {
  const keys = [
    ...new Set(storageKeys.filter((key): key is string => Boolean(key))),
  ];
  if (!keys.length) return;
  await tx.objectStorageDeletionTask.createMany({
    data: keys.map((storageKey) => ({ storageKey })),
    skipDuplicates: true,
  });
}

export async function enqueuePostRunAnalysis(
  tx: Prisma.TransactionClient,
  input: {
    taskExecutionId: string;
  },
) {
  const config = env();
  if (!config.POST_RUN_ANALYSIS_ENABLED) return;
  const task = await tx.taskExecution.findUnique({
    select: { kind: true, postRunAnalysisGeneration: true, teamId: true },
    where: { id: input.taskExecutionId },
  });
  if (!task || task.kind !== "ISSUE_SPEC") return;
  const now = new Date();
  const hardDeadlineAt = postRunAnalysisHardDeadline(now);
  await tx.postRunAnalysisJob.createMany({
    data: [
      {
        analyzerVersion: config.POST_RUN_ANALYSIS_ANALYZER_VERSION,
        generation: task.postRunAnalysisGeneration,
        deadlineAt: hardDeadlineAt,
        hardDeadlineAt,
        maxAttempts: config.POST_RUN_ANALYSIS_MAX_ATTEMPTS,
        taskExecutionId: input.taskExecutionId,
        teamId: task.teamId,
      },
    ],
    skipDuplicates: true,
  });
}

export async function supersedePostRunAnalyses(
  tx: Prisma.TransactionClient,
  input: { taskExecutionId: string; teamId: string },
) {
  const jobs = await tx.postRunAnalysisJob.findMany({
    select: {
      captureEvidenceStorageKey: true,
      captureStorageKey: true,
      id: true,
      status: true,
      updatedAt: true,
    },
    where: {
      status: { in: ["PENDING_CAPTURE", "CAPTURING", "READY", "RUNNING"] },
      taskExecutionId: input.taskExecutionId,
      teamId: input.teamId,
    },
  });
  const now = new Date();
  for (const job of jobs) {
    const changed = await tx.postRunAnalysisJob.updateMany({
      data: {
        analysisCheckpoint: json({}),
        captureEvidenceStorageKey: null,
        captureStorageKey: null,
        error: json({
          code: "POST_RUN_ANALYSIS_SUPERSEDED",
          message: "The task was reopened for another execution generation.",
          phase: "analysis",
        }),
        fencingToken: { increment: 1 },
        finishedAt: now,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
        status: "CANCELLED",
      },
      where: { id: job.id, status: job.status, updatedAt: job.updatedAt },
    });
    if (changed.count !== 1) {
      throw new ConflictException(
        "Post-run analysis changed while the task was reopened. Retry the operation.",
      );
    }
    await enqueueObjectDeletions(tx, [
      job.captureStorageKey,
      job.captureEvidenceStorageKey,
    ]);
    await tx.postRunAnalysisEvent.create({
      data: {
        actor: "CONTROL_PLANE",
        analysisId: job.id,
        kind: "analysis.superseded",
        payload: json({ previousStatus: job.status }),
        teamId: input.teamId,
      },
    });
  }
}

@Injectable()
export class PostRunAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bundles: TaskLogBundleService,
    private readonly storage: ObjectStorageService,
  ) {}

  async reconcile(limit = 20) {
    const config = env();
    if (!config.POST_RUN_ANALYSIS_ENABLED) {
      return {
        attemptsExhausted: 0,
        attemptsTimedOut: 0,
        captured: 0,
        expired: 0,
        recovered: 0,
      };
    }
    const expired = await this.expireOverdueJobs(limit);
    const attemptsTimedOut = await this.requeueExpiredAttempts(limit);
    const attemptsExhausted = await this.failExhaustedAttempts(limit);
    const recovered = await this.recoverMissingJobs(limit);
    const staleCaptureClaim = new Date(Date.now() - CAPTURE_CLAIM_STALE_MS);
    const candidates = await this.prisma.postRunAnalysisJob.findMany({
      include: {
        taskExecution: {
          include: {
            executionRuns: { include: { browserExecutions: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      where: {
        OR: [
          { status: "PENDING_CAPTURE" },
          { status: "CAPTURING", updatedAt: { lte: staleCaptureClaim } },
        ],
      },
    });
    let captured = 0;
    for (const candidate of candidates) {
      if (!(await this.captureReady(candidate))) continue;
      captured += 1;
    }
    return {
      attemptsExhausted,
      attemptsTimedOut,
      captured,
      expired,
      recovered,
    };
  }

  async detail(
    current: ToolAuthContext,
    taskExecutionId: string,
    options: { afterSequence?: string } = {},
  ) {
    const afterSequence = parseEventSequence(
      options.afterSequence,
      "afterSequence",
    );
    const row = await this.prisma.postRunAnalysisJob.findFirst({
      select: {
        ...POST_RUN_ANALYSIS_DETAIL_SELECT,
        events:
          afterSequence !== null
            ? {
                orderBy: { sequence: "asc" },
                take: EVENT_PAGE_SIZE + 1,
                where: { sequence: { gt: afterSequence } },
              }
            : {
                orderBy: { sequence: "desc" },
                take: EVENT_PAGE_SIZE + 1,
              },
      },
      orderBy: [{ generation: "desc" }, { createdAt: "desc" }],
      where: { taskExecutionId, teamId: current.team.id },
    });
    if (!row) return null;
    const progressRows = await this.prisma.postRunAnalysisEvent.findMany({
      orderBy: { sequence: "asc" },
      select: {
        kind: true,
        occurredAt: true,
        payload: true,
        sequence: true,
      },
      where: { analysisId: row.id, teamId: current.team.id },
    });
    return toDetail(row, afterSequence, progressRows);
  }

  async events(
    current: ToolAuthContext,
    taskExecutionId: string,
    options: { beforeSequence?: string; category?: string } = {},
  ) {
    const beforeSequence = parseEventSequence(
      options.beforeSequence,
      "beforeSequence",
    );
    const category = parseEventCategory(options.category);
    const job = await this.prisma.postRunAnalysisJob.findFirst({
      orderBy: [{ generation: "desc" }, { createdAt: "desc" }],
      select: { id: true },
      where: { taskExecutionId, teamId: current.team.id },
    });
    if (!job) {
      throw new NotFoundException("Post-run analysis job was not found.");
    }
    const kinds = postRunAnalysisEventKinds(category);
    const rows = await this.prisma.postRunAnalysisEvent.findMany({
      orderBy: { sequence: "desc" },
      take: EVENT_PAGE_SIZE + 1,
      where: {
        analysisId: job.id,
        teamId: current.team.id,
        ...(beforeSequence === null
          ? {}
          : { sequence: { lt: beforeSequence } }),
        ...(kinds ? { kind: { in: kinds } } : {}),
      },
    });
    const hasMore = rows.length > EVENT_PAGE_SIZE;
    const events = rows.slice(0, EVENT_PAGE_SIZE).reverse();
    return {
      analysisId: job.id,
      category,
      events: events.map(toEvent),
      hasMore,
      nextBeforeSequence: events.at(0)?.sequence.toString() ?? null,
    };
  }

  async retry(current: ToolAuthContext, taskExecutionId: string) {
    if (!env().POST_RUN_ANALYSIS_ENABLED) {
      throw new ConflictException("Post-run analysis is disabled.");
    }
    const job = await this.prisma.postRunAnalysisJob.findFirst({
      select: {
        generation: true,
        id: true,
        taskExecution: {
          select: {
            kind: true,
            lifecycle: true,
            postRunAnalysisGeneration: true,
          },
        },
      },
      where: { taskExecutionId, teamId: current.team.id },
      orderBy: [{ generation: "desc" }, { createdAt: "desc" }],
    });
    if (!job) {
      const task = await this.prisma.taskExecution.findFirst({
        where: { id: taskExecutionId, teamId: current.team.id },
      });
      if (!task) throw new NotFoundException("Task execution was not found.");
      if (
        task.kind !== "ISSUE_SPEC" ||
        !TERMINAL_TASK_LIFECYCLES.includes(
          task.lifecycle as (typeof TERMINAL_TASK_LIFECYCLES)[number],
        )
      ) {
        throw new ConflictException(
          "Only terminal Issue tasks support post-run analysis.",
        );
      }
      await this.prisma.$transaction((tx) =>
        enqueuePostRunAnalysis(tx, {
          taskExecutionId: task.id,
        }),
      );
      return this.detail(current, taskExecutionId);
    }
    if (
      job.taskExecution.kind !== "ISSUE_SPEC" ||
      job.generation !== job.taskExecution.postRunAnalysisGeneration ||
      !TERMINAL_TASK_LIFECYCLES.includes(
        job.taskExecution
          .lifecycle as (typeof TERMINAL_TASK_LIFECYCLES)[number],
      )
    ) {
      throw new ConflictException(
        "Only the current terminal task generation can be analyzed.",
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const currentJob = await tx.postRunAnalysisJob.findFirst({
        select: {
          attemptNumber: true,
          captureEvidenceStorageKey: true,
          captureStorageKey: true,
          id: true,
          inputStorageKey: true,
          maxAttempts: true,
          status: true,
          teamId: true,
        },
        where: { id: job.id, teamId: current.team.id },
      });
      if (!currentJob) {
        throw new NotFoundException("Post-run analysis job was not found.");
      }
      if (!["FAILED", "CANCELLED"].includes(currentJob.status)) {
        throw new ConflictException(
          "Only failed or cancelled post-run analysis jobs can be retried.",
        );
      }
      const hardDeadlineAt = postRunAnalysisHardDeadline(now);
      const ready = Boolean(currentJob.inputStorageKey);
      const updated = await tx.postRunAnalysisJob.updateMany({
        data: {
          captureEvidenceStorageKey: null,
          captureStorageKey: null,
          completionId: null,
          deadlineAt: hardDeadlineAt,
          error: Prisma.JsonNull,
          finishedAt: null,
          hardDeadlineAt,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          maxAttempts: Math.max(
            currentJob.maxAttempts,
            currentJob.attemptNumber + 1,
          ),
          nextAttemptAt: ready ? now : null,
          readyAt: ready ? now : null,
          status: ready ? "READY" : "PENDING_CAPTURE",
          ...(!ready ? { analysisCheckpoint: json({}) } : {}),
        },
        where: {
          attemptNumber: currentJob.attemptNumber,
          captureEvidenceStorageKey: currentJob.captureEvidenceStorageKey,
          captureStorageKey: currentJob.captureStorageKey,
          id: currentJob.id,
          inputStorageKey: currentJob.inputStorageKey,
          maxAttempts: currentJob.maxAttempts,
          status: currentJob.status,
          teamId: currentJob.teamId,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          "Post-run analysis changed while the retry was requested. Refresh and try again.",
        );
      }
      await enqueueObjectDeletions(tx, [
        currentJob.captureStorageKey,
        currentJob.captureEvidenceStorageKey,
      ]);
      await tx.postRunAnalysisEvent.create({
        data: {
          actor: "CONSOLE",
          analysisId: currentJob.id,
          kind: "analysis.retry_requested",
          payload: json({ attemptNumber: currentJob.attemptNumber }),
          teamId: currentJob.teamId,
        },
      });
    });
    return this.detail(current, taskExecutionId);
  }

  private async failExhaustedAttempts(limit: number) {
    const now = new Date();
    const maxAttemptsField = this.prisma.postRunAnalysisJob.fields.maxAttempts;
    const jobs = await this.prisma.postRunAnalysisJob.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        attemptNumber: true,
        deadlineAt: true,
        id: true,
        leaseExpiresAt: true,
        maxAttempts: true,
        status: true,
        teamId: true,
      },
      take: limit,
      where: {
        attemptNumber: { gte: maxAttemptsField },
        hardDeadlineAt: { gt: now },
        OR: [
          { status: "READY" },
          {
            status: "RUNNING",
            OR: [
              { deadlineAt: { lte: now } },
              { leaseExpiresAt: { lte: now } },
            ],
          },
        ],
      },
    });
    let exhausted = 0;
    for (const job of jobs) {
      const changed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.postRunAnalysisJob.updateMany({
          data: {
            error: json({
              code: "POST_RUN_ANALYSIS_ATTEMPTS_EXHAUSTED",
              message: `Post-run analysis exhausted ${job.maxAttempts} attempts.`,
              phase: "analysis",
            }),
            finishedAt: now,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            status: "FAILED",
          },
          where: {
            attemptNumber: job.attemptNumber,
            id: job.id,
            maxAttempts: job.maxAttempts,
            hardDeadlineAt: { gt: now },
            OR: [
              { status: "READY" },
              {
                status: "RUNNING",
                OR: [
                  { deadlineAt: { lte: now } },
                  { leaseExpiresAt: { lte: now } },
                ],
              },
            ],
          },
        });
        if (result.count !== 1) return false;
        await tx.postRunAnalysisEvent.create({
          data: {
            actor: "CONTROL_PLANE",
            analysisId: job.id,
            kind: "analysis.attempts_exhausted",
            payload: json({
              attemptNumber: job.attemptNumber,
              endedAt:
                job.status === "RUNNING"
                  ? earliestDate(
                      now,
                      job.deadlineAt,
                      job.leaseExpiresAt,
                    )?.toISOString()
                  : null,
              maxAttempts: job.maxAttempts,
              previousStatus: job.status,
            }),
            teamId: job.teamId,
          },
        });
        return true;
      });
      if (changed) exhausted += 1;
    }
    return exhausted;
  }

  private async expireOverdueJobs(limit: number) {
    const now = new Date();
    const jobs = await this.prisma.postRunAnalysisJob.findMany({
      orderBy: { hardDeadlineAt: "asc" },
      select: {
        captureEvidenceStorageKey: true,
        captureStorageKey: true,
        deadlineAt: true,
        hardDeadlineAt: true,
        id: true,
        leaseExpiresAt: true,
        status: true,
        teamId: true,
        updatedAt: true,
      },
      take: limit,
      where: {
        hardDeadlineAt: { lte: now },
        status: { in: ["PENDING_CAPTURE", "CAPTURING", "READY", "RUNNING"] },
      },
    });
    let expired = 0;
    for (const job of jobs) {
      const changed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.postRunAnalysisJob.updateMany({
          data: {
            analysisCheckpoint: json({}),
            captureEvidenceStorageKey: null,
            captureStorageKey: null,
            error: json({
              code: "POST_RUN_ANALYSIS_DEADLINE_EXCEEDED",
              message: "Post-run analysis did not finish before its deadline.",
              phase: ["PENDING_CAPTURE", "CAPTURING"].includes(job.status)
                ? "log_capture"
                : "analysis",
            }),
            finishedAt: now,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            status: "FAILED",
          },
          where: {
            hardDeadlineAt: { lte: now },
            id: job.id,
            status: job.status,
            updatedAt: job.updatedAt,
          },
        });
        if (result.count !== 1) return false;
        await enqueueObjectDeletions(tx, [
          job.captureStorageKey,
          job.captureEvidenceStorageKey,
        ]);
        await tx.postRunAnalysisEvent.create({
          data: {
            actor: "CONTROL_PLANE",
            analysisId: job.id,
            kind: "analysis.deadline_exceeded",
            payload: json({
              deadlineType: "hard",
              endedAt: (job.status === "RUNNING"
                ? (earliestDate(
                    now,
                    job.deadlineAt,
                    job.leaseExpiresAt,
                    job.hardDeadlineAt,
                  ) ?? job.hardDeadlineAt)
                : job.hardDeadlineAt
              ).toISOString(),
              previousStatus: job.status,
            }),
            teamId: job.teamId,
          },
        });
        return true;
      });
      if (changed) expired += 1;
    }
    return expired;
  }

  private async requeueExpiredAttempts(limit: number) {
    const now = new Date();
    const maxAttemptsField = this.prisma.postRunAnalysisJob.fields.maxAttempts;
    const jobs = await this.prisma.postRunAnalysisJob.findMany({
      orderBy: { deadlineAt: "asc" },
      select: {
        attemptNumber: true,
        deadlineAt: true,
        hardDeadlineAt: true,
        id: true,
        leaseExpiresAt: true,
        maxAttempts: true,
        teamId: true,
        updatedAt: true,
      },
      take: limit,
      where: {
        attemptNumber: { lt: maxAttemptsField },
        deadlineAt: { lte: now },
        hardDeadlineAt: { gt: now },
        status: "RUNNING",
      },
    });
    let timedOut = 0;
    for (const job of jobs) {
      const nextAttemptAt = postRunAnalysisRetryAt(job.attemptNumber, now);
      const changed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.postRunAnalysisJob.updateMany({
          data: {
            deadlineAt: job.hardDeadlineAt,
            error: json({
              code: "POST_RUN_ANALYSIS_ATTEMPT_DEADLINE_EXCEEDED",
              message:
                "The analysis attempt did not finish before its execution deadline.",
              phase: "analysis",
            }),
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            nextAttemptAt,
            readyAt: now,
            status: "READY",
          },
          where: {
            attemptNumber: job.attemptNumber,
            deadlineAt: job.deadlineAt,
            hardDeadlineAt: job.hardDeadlineAt,
            id: job.id,
            status: "RUNNING",
            updatedAt: job.updatedAt,
          },
        });
        if (result.count !== 1) return false;
        await tx.postRunAnalysisEvent.create({
          data: {
            actor: "CONTROL_PLANE",
            analysisId: job.id,
            kind: "analysis.attempt_deadline_exceeded",
            payload: json({
              attemptNumber: job.attemptNumber,
              endedAt: (
                earliestDate(now, job.deadlineAt, job.leaseExpiresAt) ??
                job.deadlineAt
              ).toISOString(),
              maxAttempts: job.maxAttempts,
              nextAttemptAt: nextAttemptAt.toISOString(),
            }),
            teamId: job.teamId,
          },
        });
        return true;
      });
      if (changed) timedOut += 1;
    }
    return timedOut;
  }

  private async recoverMissingJobs(limit: number) {
    const config = env();
    const finishedAfter = new Date(
      Date.now() -
        config.POST_RUN_ANALYSIS_RECOVERY_LOOKBACK_HOURS * 60 * 60 * 1_000,
    );
    const tasks = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT
        task."id"
      FROM "task_executions" task
      WHERE task."kind" = 'ISSUE_SPEC'
        AND task."lifecycle" IN ('COMPLETED', 'CANCELLED', 'TIMED_OUT')
        AND task."finished_at" >= ${finishedAfter}
        AND NOT EXISTS (
          SELECT 1
          FROM "post_run_analysis_jobs" analysis
          WHERE analysis."task_execution_id" = task."id"
            AND analysis."analyzer_version" = ${config.POST_RUN_ANALYSIS_ANALYZER_VERSION}
            AND analysis."generation" = task."post_run_analysis_generation"
        )
      ORDER BY task."finished_at" ASC
      LIMIT ${limit}
    `;
    for (const task of tasks) {
      await this.prisma.$transaction((tx) =>
        enqueuePostRunAnalysis(tx, {
          taskExecutionId: task.id,
        }),
      );
    }
    return tasks.length;
  }

  private async captureReady(
    job: Prisma.PostRunAnalysisJobGetPayload<{
      include: {
        taskExecution: {
          include: { executionRuns: { include: { browserExecutions: true } } };
        };
      };
    }>,
  ) {
    const task = job.taskExecution;
    if (
      job.generation !== task.postRunAnalysisGeneration ||
      !TERMINAL_TASK_LIFECYCLES.includes(
        task.lifecycle as (typeof TERMINAL_TASK_LIFECYCLES)[number],
      )
    ) {
      return false;
    }
    const finalized = task.executionRuns
      .flatMap((run) => run.browserExecutions)
      .every((execution) =>
        TERMINAL_BROWSER_STATUSES.includes(
          execution.status as (typeof TERMINAL_BROWSER_STATUSES)[number],
        ),
      );
    const graceExpired =
      !task.finishedAt ||
      Date.now() - task.finishedAt.getTime() >=
        env().POST_RUN_ANALYSIS_CAPTURE_GRACE_SECONDS * 1_000;
    if (!finalized && !graceExpired) return false;

    if (job.status !== "PENDING_CAPTURE" && job.status !== "CAPTURING") {
      return false;
    }
    const claimedAt = new Date();
    const captureToken = randomUUID();
    const captureStorageKey = [
      "post-run-analysis",
      job.teamId,
      job.taskExecutionId,
      job.id,
      `${captureToken}.json`,
    ].join("/");
    const captureEvidenceStorageKey = `${captureStorageKey}.evidence.ndjson`;
    const claimed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.postRunAnalysisJob.updateMany({
        data: {
          captureEvidenceStorageKey,
          captureStorageKey,
          status: "CAPTURING",
          updatedAt: claimedAt,
        },
        where: {
          id: job.id,
          status: job.status,
          updatedAt: job.updatedAt,
        },
      });
      if (result.count !== 1) return false;
      await enqueueObjectDeletions(tx, [
        job.captureStorageKey,
        job.captureEvidenceStorageKey,
      ]);
      return true;
    });
    if (!claimed) return false;

    const claimedJob = {
      ...job,
      captureEvidenceStorageKey,
      captureStorageKey,
      status: "CAPTURING" as const,
      updatedAt: claimedAt,
    };
    return this.captureClaimed(claimedJob);
  }

  private async captureClaimed(
    job: Prisma.PostRunAnalysisJobGetPayload<{
      include: {
        taskExecution: {
          include: { executionRuns: { include: { browserExecutions: true } } };
        };
      };
    }>,
  ) {
    const storageKey = job.captureStorageKey;
    const evidenceStorageKey = job.captureEvidenceStorageKey;
    if (!storageKey || !evidenceStorageKey) {
      throw new Error("The capture claim does not have durable storage keys.");
    }
    try {
      const bundle = await this.bundles.buildForCapture(
        job.teamId,
        job.taskExecutionId,
      );
      let preparedBundle: ReturnType<typeof prepareJsonObjectStream> | null =
        prepareJsonObjectStream(bundle.bundle);
      const stored = await this.storage.putStream(
        storageKey,
        "application/json",
        preparedBundle.openStream(),
        preparedBundle.byteSize,
        preparedBundle.sha256,
        {
          analysisId: job.id,
          schemaVersion: bundle.schemaVersion,
          taskExecutionId: job.taskExecutionId,
        },
      );
      preparedBundle = null;
      let evidenceArchive: ReturnType<
        typeof prepareStructuredEvidenceArchiveStream
      > | null = prepareStructuredEvidenceArchiveStream(
        bundle.bundle,
        [...bundle.evidenceRefs].sort(),
      );
      const evidenceArchiveByteSize = evidenceArchive.byteSize;
      await this.storage.putStream(
        evidenceStorageKey,
        "application/x-ndjson",
        evidenceArchive.openStream(),
        evidenceArchive.byteSize,
        evidenceArchive.sha256,
        {
          analysisId: job.id,
          kind: "structured-evidence",
          schemaVersion: bundle.schemaVersion,
          taskExecutionId: job.taskExecutionId,
        },
      );
      const evidenceIndex = evidenceArchive.index;
      evidenceArchive = null;
      bundle.bundle = {};
      const persistedManifest = {
        ...bundle.manifest,
        [POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD]: evidenceIndex,
        [POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD]: evidenceStorageKey,
      };
      const synopsis = bundle.manifest.analysisSynopsis as
        | {
            candidateCount?: number;
            selectedCandidateCount?: number;
            strategy?: string;
          }
        | undefined;
      const manifestByteSize = Buffer.byteLength(
        JSON.stringify(bundle.manifest),
      );
      const now = new Date();
      const hardDeadlineAt = postRunAnalysisHardDeadline(now);
      const updated = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.postRunAnalysisJob.updateMany({
          data: {
            analysisCheckpoint: json({}),
            captureEvidenceStorageKey: null,
            captureStorageKey: null,
            deadlineAt: hardDeadlineAt,
            hardDeadlineAt,
            inputByteSize: stored.byteSize,
            inputCompleteness: json(bundle.completeness),
            inputManifest: json(persistedManifest),
            inputSha256: stored.sha256,
            inputStorageKey: storageKey,
            nextAttemptAt: now,
            readyAt: now,
            status: "READY",
          },
          where: {
            id: job.id,
            captureEvidenceStorageKey: evidenceStorageKey,
            captureStorageKey: storageKey,
            status: "CAPTURING",
            updatedAt: job.updatedAt,
          },
        });
        if (changed.count !== 1) return false;
        await tx.postRunAnalysisEvent.create({
          data: {
            actor: "CONTROL_PLANE",
            analysisId: job.id,
            kind: "analysis.bundle.captured",
            payload: json({
              analysisStrategy: synopsis?.strategy ?? null,
              byteSize: stored.byteSize,
              candidateCount: synopsis?.candidateCount ?? 0,
              completeness: bundle.completeness,
              evidenceArchiveByteSize,
              evidenceRefCount: bundle.evidenceRefs.size,
              manifestByteSize,
              schemaVersion: bundle.schemaVersion,
              selectedCandidateCount: synopsis?.selectedCandidateCount ?? 0,
              sha256: stored.sha256,
            }),
            teamId: job.teamId,
          },
        });
        return true;
      });
      if (!updated) {
        await this.abandonCapture(job);
      }
      return updated;
    } catch (error) {
      let persisted: { inputStorageKey: string | null } | null;
      try {
        persisted = await this.prisma.postRunAnalysisJob.findFirst({
          select: { inputStorageKey: true },
          where: { id: job.id },
        });
      } catch {
        // The transaction outcome cannot be established safely. Preserve the
        // immutable object so a possibly committed row never points at a
        // deleted bundle.
        throw error;
      }
      if (persisted?.inputStorageKey === storageKey) return true;
      await this.abandonCapture(job);
      throw error;
    }
  }

  private async abandonCapture(job: {
    captureEvidenceStorageKey: string | null;
    captureStorageKey: string | null;
    id: string;
    updatedAt: Date;
  }) {
    await this.prisma.$transaction(async (tx) => {
      await tx.postRunAnalysisJob.updateMany({
        data: {
          captureEvidenceStorageKey: null,
          captureStorageKey: null,
          status: "PENDING_CAPTURE",
        },
        where: {
          captureEvidenceStorageKey: job.captureEvidenceStorageKey,
          captureStorageKey: job.captureStorageKey,
          id: job.id,
          status: "CAPTURING",
          updatedAt: job.updatedAt,
        },
      });
      await enqueueObjectDeletions(tx, [
        job.captureStorageKey,
        job.captureEvidenceStorageKey,
      ]);
    });
  }
}

export function findingFingerprint(finding: {
  category: string;
  component: string;
  failureClass?: string;
  phase?: string;
  rootCause: string;
  title: string;
}) {
  return createHash("sha256")
    .update(
      [
        finding.category,
        finding.component,
        finding.failureClass ?? "",
        finding.phase ?? "",
        finding.rootCause,
        finding.title,
      ]
        .map((value) => value.trim().toLocaleLowerCase())
        .join("\n"),
    )
    .digest("hex");
}

function toDetail(
  row: PostRunAnalysisDetailRow,
  afterSequence: bigint | null,
  progressEvents: Parameters<typeof buildPostRunAnalysisProgress>[1],
) {
  const eventsHasMore = row.events.length > EVENT_PAGE_SIZE;
  const events = row.events.slice(0, EVENT_PAGE_SIZE);
  if (afterSequence === null) events.reverse();
  const relatedWorkItem =
    row.workItem ?? row.findings.find((finding) => finding.workItem)?.workItem;
  return {
    analyzerVersion: row.analyzerVersion,
    attemptNumber: row.attemptNumber,
    createdAt: row.createdAt.toISOString(),
    error: row.error,
    eventCursor:
      events.at(-1)?.sequence.toString() ?? afterSequence?.toString() ?? null,
    events: events.map(toEvent),
    eventsHasMore: afterSequence !== null && eventsHasMore,
    eventsTruncated: afterSequence === null && eventsHasMore,
    findings: [...row.findings]
      .sort(
        (left, right) =>
          severityRank(left.severity) - severityRank(right.severity) ||
          left.createdAt.getTime() - right.createdAt.getTime(),
      )
      .map(({ workItem: _workItem, ...finding }) => ({
        ...finding,
        createdAt: finding.createdAt.toISOString(),
      })),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    generation: row.generation,
    id: row.id,
    input: row.inputSha256
      ? {
          byteSize: row.inputByteSize,
          completeness: row.inputCompleteness,
          schemaVersion: "devproof.task-logs.v2",
          sha256: row.inputSha256,
        }
      : null,
    maxAttempts: row.maxAttempts,
    progress: buildPostRunAnalysisProgress(row, progressEvents),
    startedAt: row.startedAt?.toISOString() ?? null,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    workItem: relatedWorkItem
      ? {
          body: relatedWorkItem.body,
          createdAt: relatedWorkItem.createdAt.toISOString(),
          externalRef: relatedWorkItem.externalRef,
          findingCount: relatedWorkItem.findingCount,
          id: relatedWorkItem.id,
          provider: relatedWorkItem.provider,
          status: relatedWorkItem.status,
          title: relatedWorkItem.title,
          updatedAt: relatedWorkItem.updatedAt.toISOString(),
        }
      : null,
  };
}

function toEvent(event: {
  actor: string;
  kind: string;
  occurredAt: Date;
  payload: unknown;
  sequence: bigint;
}) {
  return {
    actor: event.actor,
    kind: event.kind,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
    sequence: event.sequence.toString(),
  };
}

function parseEventSequence(value: string | undefined, field: string) {
  if (value === undefined) return null;
  if (!/^\d+$/u.test(value)) {
    throw new BadRequestException(`${field} must be a non-negative integer.`);
  }
  return BigInt(value);
}

function parseEventCategory(
  value: string | undefined,
): PostRunAnalysisEventCategory {
  const category = value?.toUpperCase() ?? "ALL";
  if (
    !POST_RUN_ANALYSIS_EVENT_CATEGORIES.includes(
      category as PostRunAnalysisEventCategory,
    )
  ) {
    throw new BadRequestException(
      `category must be one of ${POST_RUN_ANALYSIS_EVENT_CATEGORIES.join(", ")}.`,
    );
  }
  return category as PostRunAnalysisEventCategory;
}

function severityRank(severity: string) {
  return ["CRITICAL", "HIGH", "MEDIUM", "LOW"].indexOf(severity);
}
