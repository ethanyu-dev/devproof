import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  ModelCallRegistration,
  ModelCallTelemetry,
} from "@devproof/agent-runtime-protocol";
import type {
  TaskMetrics,
  TaskMetricCall,
  TaskMetricSpan,
  TaskActivity,
  TaskRuntimeKind,
} from "@devproof/contracts";
import { PrismaService } from "../database/prisma.service.js";
import { env } from "../config/env.js";
import { MetricsService } from "../observability/metrics.service.js";
import {
  inferSpanRuntime,
  normalizeUsage,
  projectRuntimeTiming,
  runtimeAttributionFailed,
  summarizeModels,
  usageTotals,
  type InferenceContext,
  type InferenceUsage,
  type RuntimeProjectionInput,
} from "./task-metrics.js";

type Tx = Prisma.TransactionClient;
type Owner = {
  teamId: string;
  taskExecutionId: string;
  ownerId: string;
  stage: string;
  runId?: string;
  attemptNumber?: number;
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const json = (v: unknown) => v as Prisma.InputJsonValue;
const key = (worker: string, token: string) =>
  createHash("sha256")
    .update(JSON.stringify([worker, token]))
    .digest("hex");
const terminal = (state: string) =>
  ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(state);
const storedRuntime = (stage: string) =>
  stage === "SPEC_ANALYSIS"
    ? "SPEC_ANALYSIS"
    : stage === "SPEC_EXECUTION"
      ? "BROWSER"
      : null;

@Injectable()
export class TaskMetricsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private polling = false;
  private readonly logger = new Logger(TaskMetricsService.name);
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly observability?: MetricsService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.timer = setInterval(
      () => void this.poll().catch((e) => this.logger.error(String(e))),
      5000,
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const rows = await this.prisma.taskExecutionMetrics.findMany({
        where: { dirty: true },
        take: 20,
        orderBy: { computedAt: { sort: "asc", nulls: "first" } },
        include: { taskExecution: { select: { teamId: true } } },
      });
      for (const row of rows)
        await this.rebuild(row.taskExecution.teamId, row.taskExecutionId);
    } finally {
      this.polling = false;
    }
  }

  async dirty(tx: Tx, taskId: string) {
    await tx.taskExecutionMetrics.upsert({
      where: { taskExecutionId: taskId },
      create: { taskExecutionId: taskId, revision: 1 },
      update: { revision: { increment: 1 }, dirty: true },
    });
  }

  /** Resumable, bounded historical projection; new events are already captured in their transaction. */
  async backfill(teamId: string, id: string) {
    await this.prisma.taskExecutionMetrics.upsert({
      where: { taskExecutionId: id },
      create: { taskExecutionId: id },
      update: {},
    });
    await this.prisma.$transaction(
      async (tx) => {
        await acquireAdvisoryTransactionLock(tx, `${id}:metrics-backfill`);
        const state = await tx.taskExecutionMetrics.findUniqueOrThrow({
          where: { taskExecutionId: id },
        });
        if (state.historyBackfilled) return;
        const kinds = [
          "agent.model.started",
          "agent.model.completed",
          "agent.model.failed",
          "agent.tool.started",
          "agent.tool.completed",
          "agent.tool.failed",
          "executor.navigation.completed",
          "executor.observation.completed",
        ];
        const analysis = await tx.taskExecutionEvent.findMany({
          where: {
            teamId,
            taskExecutionId: id,
            sequence: { gt: state.analysisCursor },
            kind: { in: kinds },
          },
          orderBy: { sequence: "asc" },
          take: 100,
        });
        const runs = await tx.runEvent.findMany({
          where: {
            teamId,
            run: { taskExecutionId: id },
            sequence: { gt: state.runCursor },
            kind: { in: kinds },
          },
          orderBy: { sequence: "asc" },
          take: 100,
          include: { attempt: { select: { number: true } } },
        });
        for (const event of analysis) {
          const p = object(event.payload);
          await this.ingest(
            tx,
            {
              teamId,
              taskExecutionId: id,
              ownerId: String(p.stageAttemptId ?? id),
              stage: "SPEC_ANALYSIS",
              ...(typeof p.attemptNumber === "number"
                ? { attemptNumber: p.attemptNumber }
                : {}),
            },
            event,
          );
        }
        for (const event of runs)
          await this.ingest(
            tx,
            {
              teamId,
              taskExecutionId: id,
              ownerId: event.taskId ?? event.attemptId ?? event.runId,
              stage: "SPEC_EXECUTION",
              runId: event.runId,
              ...(event.attempt ? { attemptNumber: event.attempt.number } : {}),
            },
            event,
          );
        const complete = analysis.length < 100 && runs.length < 100;
        if (complete) {
          const reviews = await tx.taskAcceptanceReview.findMany({
            where: {
              taskExecutionId: id,
              status: { in: ["COMPLETED", "FAILED"] },
            },
          });
          for (const review of reviews) {
            if (
              await tx.taskModelCallUsage.count({
                where: { taskExecutionId: id, ownerId: review.id },
              })
            )
              continue;
            await tx.taskModelCallUsage.upsert({
              where: { id: `legacy:review:${review.id}` },
              create: {
                id: `legacy:review:${review.id}`,
                teamId,
                taskExecutionId: id,
                ownerId: review.id,
                stage: "ACCEPTANCE_REVIEW",
                scope: "ACCEPTANCE_REVIEW",
                requestedModel: review.model ?? "unknown",
                outcome: review.status === "COMPLETED" ? "SUCCEEDED" : "FAILED",
                issues: [
                  "HISTORICAL_REVIEW_USAGE_UNAVAILABLE",
                  "REQUEST_COUNT_IS_LOWER_BOUND",
                ],
              },
              update: {},
            });
          }
        }
        await tx.taskExecutionMetrics.update({
          where: { taskExecutionId: id },
          data: {
            analysisCursor: analysis.at(-1)?.sequence ?? state.analysisCursor,
            runCursor: runs.at(-1)?.sequence ?? state.runCursor,
            historyBackfilled: complete,
            dirty: true,
          },
        });
      },
      { timeout: 30000 },
    );
  }

  async register(teamId: string, input: ModelCallRegistration) {
    return this.prisma.$transaction(async (tx) => {
      let owner: Owner,
        lease: {
          leaseOwner: string | null;
          leaseToken: string | null;
          leaseExpiresAt: Date | null;
        };
      if (input.ownerKind === "RUN") {
        await tx.$queryRaw`SELECT a.id FROM agent_runtime_tasks a JOIN execution_runs r ON r.id=a.run_id WHERE a.id=${input.ownerId}::uuid AND r.team_id=${teamId}::uuid FOR UPDATE OF a`;
        const row = await tx.agentRuntimeTask.findFirst({
          where: { id: input.ownerId, run: { teamId } },
          include: { run: true, attempt: true },
        });
        if (!row?.run.taskExecutionId || row.status !== "RUNNING")
          throw new ConflictException("Model call owner is not running.");
        lease = row;
        owner = {
          teamId,
          taskExecutionId: row.run.taskExecutionId,
          ownerId: row.id,
          stage: "SPEC_EXECUTION",
          runId: row.runId,
          attemptNumber: row.attempt.number,
        };
      } else if (input.ownerKind === "SPEC_ANALYSIS") {
        await tx.$queryRaw`SELECT a.id FROM task_stage_attempts a JOIN task_execution_stages s ON s.id=a.stage_id JOIN task_executions t ON t.id=s.task_execution_id WHERE a.id=${input.ownerId}::uuid AND t.team_id=${teamId}::uuid FOR UPDATE OF a`;
        const row = await tx.taskStageAttempt.findFirst({
          where: { id: input.ownerId, stage: { taskExecution: { teamId } } },
          include: { stage: true },
        });
        if (!row || row.status !== "RUNNING")
          throw new ConflictException("Model call owner is not running.");
        lease = row;
        owner = {
          teamId,
          taskExecutionId: row.stage.taskExecutionId,
          ownerId: row.id,
          stage: "SPEC_ANALYSIS",
          attemptNumber: row.number,
        };
      } else {
        await tx.$queryRaw`SELECT a.id FROM task_acceptance_reviews a JOIN task_executions t ON t.id=a.task_execution_id WHERE a.id=${input.ownerId}::uuid AND t.team_id=${teamId}::uuid FOR UPDATE OF a`;
        const row = await tx.taskAcceptanceReview.findFirst({
          where: { id: input.ownerId, taskExecution: { teamId } },
        });
        if (!row || row.status !== "RUNNING")
          throw new ConflictException("Model call owner is not running.");
        lease = row;
        owner = {
          teamId,
          taskExecutionId: row.taskExecutionId,
          ownerId: row.id,
          stage: "ACCEPTANCE_REVIEW",
          attemptNumber: row.attempts,
        };
      }
      if (
        lease.leaseOwner !== input.workerId ||
        lease.leaseToken !== input.leaseToken ||
        !lease.leaseExpiresAt ||
        lease.leaseExpiresAt <= new Date()
      )
        throw new ConflictException("Model call lease was lost.");
      const existing = await tx.taskModelCallUsage.findUnique({
        where: { id: input.modelCallId },
      });
      const leaseKey = key(input.workerId, input.leaseToken);
      if (
        existing &&
        (existing.teamId !== teamId ||
          existing.ownerId !== owner.ownerId ||
          existing.requestedModel !== input.requestedModel ||
          (existing.leaseKey &&
            existing.configurationId !== (input.configurationId ?? null)) ||
          (existing.leaseKey && existing.leaseKey !== leaseKey))
      )
        throw new ConflictException("Model call identity conflict.");
      await tx.taskModelCallUsage.upsert({
        where: { id: input.modelCallId },
        create: {
          id: input.modelCallId,
          ...owner,
          scope:
            input.ownerKind === "ACCEPTANCE_REVIEW"
              ? "ACCEPTANCE_REVIEW"
              : "EXECUTION",
          requestedModel: input.requestedModel,
          configurationId: input.configurationId ?? null,
          configurationName: input.configurationName,
          leaseKey,
        },
        update: {
          leaseKey,
          configurationId: input.configurationId ?? null,
          configurationName: input.configurationName,
        },
      });
      await this.dirty(tx, owner.taskExecutionId);
      return { accepted: true, serverTime: new Date().toISOString() };
    });
  }

  async settle(
    teamId: string,
    input: {
      workerId: string;
      leaseToken: string;
      telemetry: ModelCallTelemetry;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM task_model_call_usage WHERE id = ${input.telemetry.modelCallId} AND team_id = ${teamId}::uuid FOR UPDATE`;
      const call = await tx.taskModelCallUsage.findUnique({
        where: { id: input.telemetry.modelCallId },
      });
      if (
        !call ||
        call.teamId !== teamId ||
        call.leaseKey !== key(input.workerId, input.leaseToken)
      )
        throw new NotFoundException("Model call not found.");
      if (Date.now() - call.createdAt.getTime() > 86400000)
        throw new ConflictException("Model telemetry settlement expired.");
      if (
        input.telemetry.requestedModel !== call.requestedModel ||
        (input.telemetry.configurationId ?? null) !== call.configurationId
      )
        throw new ConflictException("Model identity changed.");
      const normalized = normalizeUsage(input.telemetry.usage);
      if (call.outcome !== "RUNNING" && call.normalizationVersion === 2) {
        if (
          call.responseId !== (input.telemetry.responseId ?? null) ||
          call.inputTokens !== normalized.inputTokens ||
          call.outputTokens !== normalized.outputTokens ||
          call.cacheReadTokens !== normalized.cacheReadTokens ||
          call.durationMs !== BigInt(input.telemetry.durationMs) ||
          call.outcome !== input.telemetry.outcome
        )
          throw new ConflictException("Conflicting model settlement.");
        return { accepted: true };
      }
      const start = new Date(input.telemetry.startedAt);
      const alignedStart = new Date(
        start.getTime() + (input.telemetry.clockOffsetMs ?? 0),
      );
      const activity =
        (input.telemetry.clockUncertaintyMs ?? 0) > 1000 ? "UNKNOWN" : "MODEL";
      await tx.taskModelCallUsage.update({
        where: { id: call.id },
        data: {
          ...normalized,
          rawUsage: json(normalized.rawUsage),
          issues: json(normalized.issues),
          responseModel: input.telemetry.responseModel ?? null,
          responseId: input.telemetry.responseId ?? null,
          startedAt: start,
          durationMs: BigInt(input.telemetry.durationMs),
          outcome: input.telemetry.outcome,
          normalizationVersion: 2,
        },
      });
      await tx.taskExecutionSpan.upsert({
        where: { id: `model:${call.id}` },
        create: {
          id: `model:${call.id}`,
          teamId,
          taskExecutionId: call.taskExecutionId,
          lane: call.runId ?? call.ownerId,
          label: input.telemetry.responseModel ?? call.requestedModel,
          activity,
          scope: call.scope,
          runtime: storedRuntime(call.stage),
          startedAt: alignedStart,
          finishedAt: new Date(
            alignedStart.getTime() + input.telemetry.durationMs,
          ),
        },
        update: {
          activity,
          runtime: storedRuntime(call.stage),
          startedAt: alignedStart,
          finishedAt: new Date(
            alignedStart.getTime() + input.telemetry.durationMs,
          ),
        },
      });
      await this.dirty(tx, call.taskExecutionId);
      return { accepted: true };
    });
  }

  /** Called in the event transaction. Legacy completion is never allowed to overwrite precise client telemetry. */
  async ingest(
    tx: Tx,
    owner: Owner,
    event: { id: string; kind: string; occurredAt: Date; payload: unknown },
  ) {
    const p = object(event.payload);
    const clock = object(p.metricsClock);
    const offset =
      typeof clock.offsetMs === "number" &&
      Number.isFinite(clock.offsetMs) &&
      Math.abs(clock.offsetMs) <= 86400000
        ? clock.offsetMs
        : 0;
    event = {
      ...event,
      occurredAt: new Date(event.occurredAt.getTime() + offset),
    };
    if (
      [
        "executor.navigation.completed",
        "executor.observation.completed",
      ].includes(event.kind) &&
      typeof p.durationMs === "number" &&
      Number.isSafeInteger(p.durationMs) &&
      p.durationMs >= 0
    ) {
      await tx.taskExecutionSpan.upsert({
        where: { id: `event:${event.id}` },
        create: {
          id: `event:${event.id}`,
          teamId: owner.teamId,
          taskExecutionId: owner.taskExecutionId,
          lane: owner.runId ?? owner.ownerId,
          label: event.kind.includes("navigation")
            ? "初始导航"
            : "自动页面观察",
          activity: "TOOL",
          runtime: storedRuntime(owner.stage),
          startedAt: new Date(event.occurredAt.getTime() - p.durationMs),
          finishedAt: event.occurredAt,
        },
        update: {},
      });
      await this.dirty(tx, owner.taskExecutionId);
      return;
    }
    if (!/^agent\.(model|tool)\.(started|completed|failed)$/.test(event.kind))
      return;
    const started = event.kind.endsWith("started"),
      model = event.kind.includes(".model.");
    const segment = String(p.segmentId ?? "legacy"),
      step = String(p.step ?? "0");
    const id = model
      ? String(p.modelCallId ?? `legacy:${event.id}`)
      : `tool:${owner.ownerId}:${segment}:${step}:${String(p.callId ?? event.id)}`;
    const duration =
      typeof p.durationMs === "number" &&
      Number.isSafeInteger(p.durationMs) &&
      p.durationMs >= 0
        ? p.durationMs
        : null;
    const start = started
      ? event.occurredAt
      : duration !== null
        ? new Date(event.occurredAt.getTime() - duration)
        : null;
    const finished = started ? null : event.occurredAt;
    if (model) {
      // Legacy starts without IDs cannot safely correlate fallback requests; count terminal events only.
      if (started && !p.modelCallId) return;
      const existing = await tx.taskModelCallUsage.findUnique({
        where: { id },
      });
      if (
        existing &&
        (existing.teamId !== owner.teamId || existing.ownerId !== owner.ownerId)
      )
        throw new ConflictException("Model trace identity conflict.");
      if (
        !existing ||
        (existing.normalizationVersion !== 2 &&
          (!started || existing.outcome === "RUNNING"))
      ) {
        const usage = normalizeUsage(p.usage);
        const data = {
          ...owner,
          requestedModel: String(p.model ?? "unknown"),
          segmentId: segment,
          startedAt: start,
          durationMs: duration === null ? null : BigInt(duration),
          outcome: started
            ? "RUNNING"
            : event.kind.endsWith("failed")
              ? "FAILED"
              : "SUCCEEDED",
          ...usage,
          rawUsage: json(usage.rawUsage),
          issues: json(usage.issues),
        };
        await tx.taskModelCallUsage.upsert({
          where: { id },
          create: { id, ...data },
          update: started ? { segmentId: segment } : data,
        });
      } else return;
    }
    if (start) {
      const spanId = model ? `model:${id}` : id;
      const old = await tx.taskExecutionSpan.findUnique({
        where: { id: spanId },
      });
      if (!old || !started)
        await tx.taskExecutionSpan.upsert({
          where: { id: spanId },
          create: {
            id: spanId,
            teamId: owner.teamId,
            taskExecutionId: owner.taskExecutionId,
            lane: owner.runId ?? owner.ownerId,
            label: String(model ? p.model : p.name).slice(0, 160),
            activity:
              typeof clock.uncertaintyMs === "number" &&
              clock.uncertaintyMs > 1000
                ? "UNKNOWN"
                : model
                  ? "MODEL"
                  : "TOOL",
            runtime: storedRuntime(owner.stage),
            startedAt: start,
            finishedAt: finished,
          },
          update: {
            runtime: storedRuntime(owner.stage),
            finishedAt: finished,
          },
        });
    }
    await this.dirty(tx, owner.taskExecutionId);
  }

  async summary(teamId: string, id: string): Promise<TaskMetrics> {
    const row = await this.prisma.taskExecution.findFirst({
      where: { id, teamId },
      select: { metrics: true, lifecycle: true },
    });
    if (!row) throw new NotFoundException("Task not found.");
    const cached = row.metrics;
    const stored = cached?.summary;
    const revision = cached?.revision ?? 0n;
    // A failed attribution for this revision must not rebuild on every read.
    if (
      cached?.computedAt &&
      !cached.dirty &&
      runtimeAttributionFailed(stored, revision)
    )
      return stored as unknown as TaskMetrics;
    const version =
      stored && typeof stored === "object" && "version" in stored
        ? Number((stored as { version?: unknown }).version)
        : 0;
    if (
      cached?.computedAt &&
      !cached.dirty &&
      version >= 2 &&
      (terminal(row.lifecycle) ||
        Date.now() - cached.computedAt.getTime() <= 5000)
    )
      return stored as unknown as TaskMetrics;
    return this.rebuild(teamId, id);
  }

  async rebuild(teamId: string, id: string): Promise<TaskMetrics> {
    await this.requireTask(teamId, id);
    await this.backfill(teamId, id);
    const row = await this.prisma.taskExecution.findFirst({
      where: { id, teamId },
      include: {
        metrics: true,
        stages: { include: { attempts: true } },
        acceptanceReviews: { orderBy: { createdAt: "desc" } },
        executionRuns: { include: { interventions: true } },
      },
    });
    if (!row) throw new NotFoundException("Task not found.");
    const revision = row.metrics?.revision ?? 0n;
    const asOf = new Date(),
      end = row.finishedAt ?? asOf;
    const [calls, stored] = await Promise.all([
      this.prisma.taskModelCallUsage.findMany({
        where: { taskExecutionId: id, teamId },
      }),
      this.prisma.taskExecutionSpan.findMany({
        where: { taskExecutionId: id, teamId, scope: "EXECUTION" },
      }),
    ]);
    const spans: RuntimeProjectionInput["spans"] = stored.map((span) => ({
      id: span.id,
      lane: span.lane,
      label: span.label,
      activity: span.activity,
      scope: span.scope,
      startedAt: span.startedAt.getTime(),
      finishedAt: span.finishedAt?.getTime() ?? null,
    }));
    // Known historical boundaries are useful without inventing gaps as platform work.
    if (row.startedAt && row.startedAt > row.createdAt)
      spans.push({
        id: "initial",
        lane: id,
        label: "首次启动等待",
        activity: "QUEUE",
        scope: "EXECUTION",
        startedAt: row.createdAt.getTime(),
        finishedAt: row.startedAt.getTime(),
      });
    for (const run of row.executionRuns)
      for (const intervention of run.interventions)
        spans.push({
          id: intervention.id,
          lane: run.id,
          label: "人工等待",
          activity: "HUMAN",
          scope: "EXECUTION",
          intervention: true,
          startedAt: intervention.requestedAt.getTime(),
          finishedAt:
            (
              intervention.resolvedAt ??
              (terminal(run.lifecycle) ? run.finishedAt : null)
            )?.getTime() ?? null,
        });
    const projection = projectRuntimeTiming({
      taskId: id,
      start: row.createdAt.getTime(),
      end: end.getTime(),
      analysisStageStatus:
        row.stages.find((stage) => stage.type === "SPEC_ANALYSIS")?.status ??
        null,
      attempts: row.stages.flatMap((stage) =>
        stage.attempts.map((attempt) => ({
          id: attempt.id,
          stageType: stage.type,
          executor: attempt.executor,
          createdAt: attempt.createdAt.getTime(),
          finishedAt: attempt.finishedAt?.getTime() ?? null,
        })),
      ),
      runs: row.executionRuns.map((run) => ({
        id: run.id,
        createdAt: run.createdAt.getTime(),
        finishedAt: run.finishedAt?.getTime() ?? null,
      })),
      spans,
      usages: calls.map((call) => ({
        id: call.id,
        ownerId: call.ownerId,
        stage: call.stage,
        scope: call.scope,
        runId: call.runId,
      })),
    });
    const buckets = projection.buckets;
    const total = usageTotals(calls);
    const unknown =
      buckets.find((b) => b.activity === "UNKNOWN")?.durationMs ?? 0;
    const summary: TaskMetrics & {
      runtimeAttribution?: "FAILED";
      runtimeAttributionRevision?: string;
    } = {
      taskId: id,
      asOf: asOf.toISOString(),
      computedAt: asOf.toISOString(),
      refreshPending: !row.metrics?.historyBackfilled,
      version: projection.ok ? 2 : 1,
      elapsedMs: projection.elapsedMs,
      activeMs: buckets
        .filter((b) =>
          ["MODEL", "TOOL", "PLATFORM", "RECOVERY", "PARALLEL"].includes(
            b.activity,
          ),
        )
        .reduce((s, b) => s + b.durationMs, 0),
      waitingMs: buckets
        .filter((b) =>
          ["QUEUE", "HUMAN", "DEPENDENCY", "BACKOFF", "MIXED_WAIT"].includes(
            b.activity,
          ),
        )
        .reduce((s, b) => s + b.durationMs, 0),
      timingQuality: !spans.length
        ? "UNAVAILABLE"
        : unknown
          ? "PARTIAL"
          : "ESTIMATED",
      buckets,
      models: summarizeModels(calls, terminal(row.lifecycle)),
      totals: total,
      reviewStatus: row.acceptanceReviews[0]?.status ?? null,
      reviewDurationMs: calls
        .filter((c) => c.scope === "ACCEPTANCE_REVIEW")
        .reduce((s, c) => s + Number(c.durationMs ?? 0n), 0),
      phases: row.stages.map((s) => ({
        phase: s.type,
        startedAt: s.startedAt?.toISOString() ?? null,
        finishedAt: s.finishedAt?.toISOString() ?? null,
        status: s.status,
      })),
    };
    if (projection.ok) {
      summary.runtimes = projection.runtimes;
      summary.unassigned = projection.unassigned;
      summary.overlap = projection.overlap;
    } else {
      summary.runtimeAttribution = "FAILED";
      summary.runtimeAttributionRevision = revision.toString();
      const delta = projection.occupiedMs - (projection.elapsedMs ?? 0);
      this.logger.warn(
        `task metrics runtime invariant failed taskExecutionId=${id} elapsedMs=${projection.elapsedMs} occupiedMs=${projection.occupiedMs} delta=${delta}`,
      );
    }
    await this.prisma.taskExecutionMetrics.upsert({
      where: { taskExecutionId: id },
      create: {
        taskExecutionId: id,
        summary: json(summary),
        computedAt: asOf,
        projectedRevision: revision,
        dirty: false,
      },
      update: {},
    });
    const saved = await this.prisma.taskExecutionMetrics.updateMany({
      where: { taskExecutionId: id, revision },
      data: {
        summary: json(summary),
        computedAt: asOf,
        projectedRevision: revision,
        dirty: false,
      },
    });
    summary.refreshPending = !saved.count || !row.metrics?.historyBackfilled;
    if (!projection.ok) {
      if (
        saved.count &&
        !runtimeAttributionFailed(row.metrics?.summary, revision)
      )
        this.observability?.increment(
          "devproof_task_metrics_runtime_invariant_failures_total",
          "Task metrics runtime attribution invariant failures.",
        );
      return summary;
    }
    const priorOverlap = object(
      object(row.metrics?.summary).overlap,
    ).occupiedMs;
    if (
      (projection.overlap.occupiedMs ?? 0) > 0 &&
      saved.count &&
      !(
        row.metrics?.projectedRevision === revision &&
        typeof priorOverlap === "number" &&
        priorOverlap > 0
      )
    ) {
      this.logger.log(
        `task metrics runtime overlap taskExecutionId=${id} overlapMs=${projection.overlap.occupiedMs}`,
      );
      this.observability?.increment(
        "devproof_task_metrics_runtime_overlap_total",
        "Task metrics projections that contain cross-runtime overlap.",
      );
    }
    if (!row.metrics?.historyBackfilled)
      await this.prisma.taskExecutionMetrics.update({
        where: { taskExecutionId: id },
        data: { dirty: true },
      });
    return summary;
  }

  async calls(teamId: string, id: string, after?: string) {
    await this.requireTask(teamId, id);
    if (
      after &&
      !(await this.prisma.taskModelCallUsage.findFirst({
        where: { id: after, teamId, taskExecutionId: id },
      }))
    )
      throw new NotFoundException("Metrics cursor not found.");
    const rows = await this.prisma.taskModelCallUsage.findMany({
      where: {
        teamId,
        taskExecutionId: id,
      },
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      orderBy: [{ startedAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      take: 51,
    });
    const page = rows.slice(0, 50);
    const ctx = await this.spanInferenceContext(teamId, id, []);
    for (const call of page)
      ctx.usages.set(call.id, {
        stage: call.stage,
        scope: call.scope,
        runId: call.runId,
      });
    const items: TaskMetricCall[] = page.map((c) => ({
      id: c.id,
      runId: c.runId,
      attemptNumber: c.attemptNumber,
      stage: c.stage,
      model: c.responseModel ?? c.requestedModel,
      configurationName: c.configurationName,
      scope: c.scope as TaskMetricCall["scope"],
      startedAt: c.startedAt?.toISOString() ?? null,
      durationMs: c.durationMs === null ? null : Number(c.durationMs),
      outcome: c.outcome,
      inputTokens: c.inputTokens?.toString() ?? null,
      outputTokens: c.outputTokens?.toString() ?? null,
      cacheReadTokens: c.cacheReadTokens?.toString() ?? null,
      issues: Array.isArray(c.issues)
        ? c.issues.filter((v): v is string => typeof v === "string")
        : [],
      runtime: inferSpanRuntime(
        {
          id: `model:${c.id}`,
          lane: c.runId ?? c.ownerId,
          label: c.responseModel ?? c.requestedModel,
          scope: c.scope,
        },
        ctx,
      ),
    }));
    return { items, nextCursor: rows.length > 50 ? items.at(-1)!.id : null };
  }
  async timeline(
    teamId: string,
    id: string,
    after?: string,
    runtime?: TaskRuntimeKind,
  ) {
    await this.requireTask(teamId, id);
    if (
      after &&
      !(await this.prisma.taskExecutionSpan.findFirst({
        where: { id: after, teamId, taskExecutionId: id },
      }))
    )
      throw new NotFoundException("Metrics cursor not found.");
    const take = runtime ? 1000 : 101;
    const rows = await this.prisma.taskExecutionSpan.findMany({
      where: { teamId, taskExecutionId: id },
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      take,
    });
    const ctx = await this.spanInferenceContext(
      teamId,
      id,
      rows
        .filter((span) => span.id.startsWith("model:"))
        .map((span) => span.id.slice("model:".length)),
    );
    const present = (span: (typeof rows)[number]): TaskMetricSpan => ({
      id: span.id,
      lane: span.lane,
      label: span.label,
      activity: span.activity as TaskActivity,
      startedAt: span.startedAt.toISOString(),
      finishedAt: span.finishedAt?.toISOString() ?? null,
      estimated: span.estimated,
      runtime: inferSpanRuntime(span, ctx),
    });
    if (!runtime) {
      const items = rows.slice(0, 100).map(present);
      return {
        items,
        nextCursor: rows.length > 100 ? items.at(-1)!.id : null,
      };
    }
    const items: TaskMetricSpan[] = [];
    let scanned = 0;
    for (const span of rows) {
      scanned++;
      const item = present(span);
      if (item.runtime === runtime) items.push(item);
      if (items.length === 100) break;
    }
    const more =
      items.length === 100
        ? scanned < rows.length || rows.length === 1000
        : rows.length === 1000;
    return {
      items,
      nextCursor: more ? rows[scanned - 1]!.id : null,
    };
  }
  async batch(teamId: string, ids: string[]) {
    const rows = await this.prisma.taskExecution.findMany({
      where: { teamId, id: { in: ids.slice(0, 50) } },
      select: { id: true, createdAt: true, finishedAt: true, metrics: true },
    });
    const missing = rows
      .filter((r) => !r.metrics)
      .map((r) => ({ taskExecutionId: r.id }));
    if (missing.length)
      await this.prisma.taskExecutionMetrics.createMany({
        data: missing,
        skipDuplicates: true,
      });
    const asOf = Date.now();
    return rows.map((r) => ({
      taskId: r.id,
      elapsedMs: (r.finishedAt?.getTime() ?? asOf) - r.createdAt.getTime(),
      totals: object(r.metrics?.summary).totals ?? null,
      refreshPending: !r.metrics?.computedAt || r.metrics.dirty,
    }));
  }
  private async spanInferenceContext(
    teamId: string,
    taskId: string,
    modelIds: string[],
  ): Promise<
    Omit<InferenceContext, "usages"> & { usages: Map<string, InferenceUsage> }
  > {
    const [task, usages] = await Promise.all([
      this.prisma.taskExecution.findFirst({
        where: { id: taskId, teamId },
        select: {
          id: true,
          stages: {
            where: { type: "SPEC_ANALYSIS" },
            select: { attempts: { select: { id: true, executor: true } } },
          },
          executionRuns: { select: { id: true } },
        },
      }),
      modelIds.length
        ? this.prisma.taskModelCallUsage.findMany({
            where: { teamId, taskExecutionId: taskId, id: { in: modelIds } },
            select: { id: true, stage: true, scope: true, runId: true },
          })
        : [],
    ]);
    if (!task) throw new NotFoundException("Task not found.");
    const attempts = task.stages.flatMap((stage) => stage.attempts);
    return {
      taskId: task.id,
      attemptIds: new Set(attempts.map((attempt) => attempt.id)),
      runIds: new Set(task.executionRuns.map((run) => run.id)),
      deterministicAnalysis:
        attempts.length > 0 &&
        attempts.every((attempt) => attempt.executor === "DETERMINISTIC"),
      usages: new Map(
        usages.map((usage) => [
          usage.id,
          { stage: usage.stage, scope: usage.scope, runId: usage.runId },
        ]),
      ),
    };
  }
  private async requireTask(teamId: string, id: string) {
    if (
      !(await this.prisma.taskExecution.findFirst({
        where: { id, teamId },
        select: { id: true },
      }))
    )
      throw new NotFoundException("Task not found.");
  }
}
