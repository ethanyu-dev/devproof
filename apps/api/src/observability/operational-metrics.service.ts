import { Injectable } from "@nestjs/common";
import { caseExecutionPhase, readCaseScheduling } from "@devproof/test-domain";

import { PrismaService } from "../database/prisma.service.js";
import { MetricsService } from "./metrics.service.js";

@Injectable()
export class OperationalMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  async collect() {
    const recentCutoff = new Date(Date.now() - 15 * 60_000);
    const [
      runs,
      recentRuns,
      taskExecutions,
      taskStages,
      commands,
      outbox,
      runtimes,
      sessions,
      artifacts,
      invocations,
      recentInvocations,
      oldestInvocation,
      oldestOutbox,
      browserProfiles,
      profileReservations,
      integrationEvents,
      oldestProfileWait,
      postRunAnalyses,
      oldestPostRunAnalysis,
      improvementWorkItems,
    ] = await Promise.all([
      this.prisma.verificationRun.groupBy({ _count: true, by: ["status"] }),
      this.prisma.verificationRun.groupBy({
        _count: true,
        by: ["status"],
        where: { finishedAt: { gte: recentCutoff } },
      }),
      this.prisma.taskExecution.groupBy({ _count: true, by: ["lifecycle"] }),
      this.prisma.taskExecutionStage.groupBy({
        _count: true,
        by: ["status"],
      }),
      this.prisma.browserRuntimeCommand.groupBy({
        _count: true,
        by: ["status"],
      }),
      this.prisma.notificationOutbox.groupBy({
        _count: true,
        by: ["status"],
      }),
      this.prisma.browserRuntime.groupBy({ _count: true, by: ["status"] }),
      this.prisma.browserRuntimeSession.groupBy({
        _count: true,
        by: ["status"],
      }),
      this.prisma.browserRuntimeArtifact.aggregate({
        _count: true,
        _sum: { byteSize: true },
      }),
      this.prisma.toolInvocation.groupBy({ _count: true, by: ["status"] }),
      this.prisma.toolInvocation.groupBy({
        _count: true,
        by: ["status"],
        where: { startedAt: { gte: recentCutoff } },
      }),
      this.prisma.toolInvocation.aggregate({
        _min: { startedAt: true },
        where: { status: "STARTED" },
      }),
      this.prisma.notificationOutbox.aggregate({
        _min: { nextAttemptAt: true },
        where: { status: { in: ["PENDING", "FAILED"] } },
      }),
      this.prisma.userBrowserProfile.groupBy({
        _count: true,
        by: ["status"],
      }),
      this.prisma.browserProfileReservation.groupBy({
        _count: true,
        by: ["status"],
      }),
      this.prisma.inboundIntegrationEvent.groupBy({
        _count: true,
        by: ["status"],
      }),
      this.prisma.taskProfileBinding.aggregate({
        _min: { updatedAt: true },
        where: { status: "WAITING_INPUT" },
      }),
      this.prisma.postRunAnalysisJob.groupBy({
        _count: true,
        by: ["status"],
      }),
      this.prisma.postRunAnalysisJob.aggregate({
        _min: { readyAt: true },
        where: {
          nextAttemptAt: { lte: new Date() },
          status: "READY",
        },
      }),
      this.prisma.improvementWorkItem.groupBy({
        _count: true,
        by: ["status"],
      }),
      this.collectExecutionScheduling(),
    ]);
    this.groupGauge(
      "devproof_verification_runs",
      "Verification runs by current status.",
      runs,
    );
    this.groupGauge(
      "devproof_verification_terminal_runs_15m",
      "Verification runs completed in the last fifteen minutes by status.",
      recentRuns,
    );
    this.groupGauge(
      "devproof_task_executions",
      "User-visible task executions by current lifecycle.",
      taskExecutions.map((row) => ({ ...row, status: row.lifecycle })),
    );
    this.groupGauge(
      "devproof_task_execution_stages",
      "Task execution stages by current status.",
      taskStages,
    );
    this.groupGauge(
      "devproof_runtime_commands",
      "Browser Runtime commands by current status.",
      commands,
    );
    this.groupGauge(
      "devproof_notification_outbox",
      "Notification outbox rows by current status.",
      outbox,
    );
    this.groupGauge(
      "devproof_browser_runtimes",
      "Browser Runtime registrations by current status.",
      runtimes,
    );
    this.groupGauge(
      "devproof_browser_sessions",
      "Browser Runtime sessions by current status.",
      sessions,
    );
    this.groupGauge(
      "devproof_user_browser_profiles",
      "User browser profiles by lifecycle status.",
      browserProfiles,
    );
    this.groupGauge(
      "devproof_browser_profile_reservations",
      "Browser profile reservations by status.",
      profileReservations,
    );
    this.groupGauge(
      "devproof_inbound_integration_events",
      "Inbound integration events by processing status.",
      integrationEvents,
    );
    this.groupGauge(
      "devproof_tool_invocations",
      "Persisted tool invocations by current status.",
      invocations,
    );
    this.groupGauge(
      "devproof_tool_invocations_15m",
      "Tool invocations started in the last fifteen minutes by status.",
      recentInvocations,
    );
    this.groupGauge(
      "devproof_post_run_analysis_jobs",
      "Post-run optimization analysis jobs by current status.",
      postRunAnalyses,
    );
    this.groupGauge(
      "devproof_improvement_work_items",
      "Automatically generated improvement work items by current status.",
      improvementWorkItems,
    );
    this.metrics.setGauge(
      "devproof_post_run_analysis_oldest_ready_age_seconds",
      "Age of the oldest post-run analysis that is ready to be claimed.",
      oldestPostRunAnalysis._min.readyAt
        ? Math.max(
            0,
            (Date.now() - oldestPostRunAnalysis._min.readyAt.getTime()) / 1_000,
          )
        : 0,
    );
    this.metrics.setGauge(
      "devproof_tool_invocation_oldest_started_age_seconds",
      "Age of the oldest tool invocation that has not reached a terminal status.",
      oldestInvocation._min.startedAt
        ? Math.max(
            0,
            (Date.now() - oldestInvocation._min.startedAt.getTime()) / 1_000,
          )
        : 0,
    );
    this.metrics.setGauge(
      "devproof_notification_oldest_due_age_seconds",
      "Age past due of the oldest pending or retrying notification.",
      oldestOutbox._min.nextAttemptAt
        ? Math.max(
            0,
            (Date.now() - oldestOutbox._min.nextAttemptAt.getTime()) / 1_000,
          )
        : 0,
    );
    this.metrics.setGauge(
      "devproof_profile_resolution_oldest_wait_seconds",
      "Age of the oldest task waiting for browser profile input.",
      oldestProfileWait._min.updatedAt
        ? Math.max(
            0,
            (Date.now() - oldestProfileWait._min.updatedAt.getTime()) / 1_000,
          )
        : 0,
    );
    this.metrics.setGauge(
      "devproof_runtime_artifacts",
      "Number of retained Browser Runtime artifacts.",
      artifacts._count,
    );
    this.metrics.setGauge(
      "devproof_runtime_artifact_bytes",
      "Total retained Browser Runtime artifact bytes.",
      artifacts._sum.byteSize ?? 0,
    );
  }

  async collectExecutionScheduling() {
    const now = Date.now();
    const [
      cases,
      directWaits,
      resources,
      resourceSessions,
      recoveries,
      dirtyTasks,
    ] = await Promise.all([
      this.prisma.taskCaseExecution.findMany({
        distinct: ["taskExecutionId", "caseId", "deploymentId"],
        orderBy: { executionOrdinal: "desc" },
        select: {
          dispatchStatus: true,
          dispatchAttempts: true,
          scheduling: true,
          createdAt: true,
          run: {
            select: {
              lifecycle: true,
              executionDisposition: true,
              verdict: true,
            },
          },
        },
        where: {
          taskExecution: {
            lifecycle: {
              in: ["QUEUED", "RUNNING", "WAITING_INPUT", "WAITING_HUMAN"],
            },
          },
        },
      }),
      this.prisma.browserExecution.findMany({
        select: { error: true, waitingSince: true, createdAt: true },
        where: {
          status: { in: ["REQUESTED", "WAITING_CAPACITY", "ALLOCATING"] },
          run: {
            lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
            taskCaseExecution: null,
          },
        },
      }),
      this.prisma.executionResourceLease.aggregate({
        _count: true,
        _min: { createdAt: true },
        where: { quarantined: true },
      }),
      this.prisma.browserRuntimeSession.aggregate({
        _min: { quarantinedAt: true },
        where: { resourceLeases: { some: { quarantined: true } } },
      }),
      this.prisma.agentRuntimeTask.groupBy({
        by: ["recoveryStatus"],
        _count: true,
        where: { recoveryStatus: { not: null } },
      }),
      this.prisma.taskExecution.findMany({
        select: {
          projectedAt: true,
          projectionNeededAt: true,
          createdAt: true,
        },
        where: { projectionNeededAt: { not: null } },
      }),
    ]);
    const waits = new Map<string, { count: number; oldestSeconds: number }>();
    const addWait = (rawReason: unknown, since: Date | string) => {
      const reason = metricWaitReason(rawReason);
      const current = waits.get(reason) ?? { count: 0, oldestSeconds: 0 };
      current.count += 1;
      current.oldestSeconds = Math.max(
        current.oldestSeconds,
        ageSeconds(since, now),
      );
      waits.set(reason, current);
    };
    for (const item of cases) {
      if (!["queued", "recovering"].includes(caseExecutionPhase(item)))
        continue;
      const scheduling = readCaseScheduling(item.scheduling);
      addWait(
        scheduling?.reason ?? "SCHEDULER_PENDING",
        scheduling?.waitingSince ?? item.createdAt,
      );
    }
    for (const item of directWaits) {
      const error =
        item.error &&
        typeof item.error === "object" &&
        !Array.isArray(item.error)
          ? item.error
          : {};
      addWait(
        error.code ?? "BROWSER_ADMISSION",
        item.waitingSince ?? item.createdAt,
      );
    }
    for (const name of [
      "devproof_execution_waiting",
      "devproof_execution_oldest_wait_seconds",
      "devproof_agent_lease_recoveries",
    ])
      this.metrics.clearGauge(name);
    for (const [reason, value] of waits) {
      this.metrics.setGauge(
        "devproof_execution_waiting",
        "Current waiting execution units by scheduling reason.",
        value.count,
        { reason },
      );
      this.metrics.setGauge(
        "devproof_execution_oldest_wait_seconds",
        "Oldest queued execution age by scheduling reason.",
        value.oldestSeconds,
        { reason },
      );
    }
    const recoveryCounts = new Map<string, number>();
    for (const item of recoveries) {
      const status = [
        "PENDING",
        "CLOSING",
        "RETRY_SCHEDULED",
        "EXHAUSTED",
        "WRITE_OUTCOME_UNKNOWN",
      ].includes(item.recoveryStatus ?? "")
        ? item.recoveryStatus!.toLowerCase()
        : "other";
      recoveryCounts.set(
        status,
        (recoveryCounts.get(status) ?? 0) + item._count,
      );
    }
    for (const [status, count] of recoveryCounts)
      this.metrics.setGauge(
        "devproof_agent_lease_recoveries",
        "Retained Agent lease recovery records by recovery status.",
        count,
        { status },
      );
    this.metrics.setGauge(
      "devproof_resource_quarantines",
      "Business resource leases retained pending unknown-write resolution.",
      resources._count,
    );
    this.metrics.setGauge(
      "devproof_resource_quarantine_oldest_seconds",
      "Age of the oldest retained business resource quarantine.",
      ageSeconds(
        resourceSessions._min.quarantinedAt ?? resources._min.createdAt,
        now,
      ),
    );
    this.metrics.setGauge(
      "devproof_task_projection_pending",
      "Tasks with an unapplied projection update.",
      dirtyTasks.length,
    );
    this.metrics.setGauge(
      "devproof_task_projection_oldest_pending_seconds",
      "Oldest outstanding projection request age.",
      dirtyTasks.reduce(
        (oldest, task) =>
          Math.max(oldest, ageSeconds(task.projectionNeededAt, now)),
        0,
      ),
    );
    this.metrics.setGauge(
      "devproof_task_projection_staleness_seconds",
      "Oldest projection age among tasks with pending source changes.",
      dirtyTasks.reduce(
        (oldest, task) =>
          Math.max(oldest, ageSeconds(task.projectedAt ?? task.createdAt, now)),
        0,
      ),
    );
  }

  private groupGauge(
    name: string,
    help: string,
    rows: Array<{ _count: number; status: string }>,
  ) {
    this.metrics.clearGauge(name);
    for (const row of rows) {
      this.metrics.setGauge(name, help, row._count, {
        status: row.status.toLowerCase(),
      });
    }
  }
}

function ageSeconds(value: Date | string | null, now: number) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, (now - time) / 1_000) : 0;
}

function metricWaitReason(value: unknown) {
  const aliases: Record<string, string> = {
    NO_AVAILABLE_SLOT: "RUNTIME_CAPACITY",
    IDENTITY_CAPACITY: "IDENTITY_LIMIT",
    NO_MATCHING_RUNNER: "RUNTIME_OFFLINE",
  };
  const reason =
    typeof value === "string" ? (aliases[value] ?? value) : "OTHER";
  const known = new Set([
    "PROFILE_RESERVED",
    "PROFILE_SESSION_BUSY",
    "PROFILE_INACTIVITY_EXPIRED",
    "PROFILE_AUTHORIZATION_CHANGED",
    "IDENTITY_LIMIT",
    "AUTH_REFRESH",
    "AUTH_REQUIRED",
    "CASE_DEPENDENCY",
    "POLICY_REVIEW",
    "DATA_LOCK",
    "RUNTIME_CAPACITY",
    "RUNTIME_OFFLINE",
    "RUNTIME_INCOMPATIBLE",
    "PROTOCOL_UNSUPPORTED",
    "RETRY_BACKOFF",
    "AGENT_CAPACITY",
    "LEASE_RECOVERY",
    "SCHEDULER_PENDING",
    "BROWSER_ADMISSION",
    "ADMISSION_STALE",
    "ADMISSION_ERROR",
  ]);
  return known.has(reason) ? reason.toLowerCase() : "other";
}
