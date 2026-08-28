import { Injectable } from "@nestjs/common";

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
      this.prisma.improvementWorkItem.groupBy({
        _count: true,
        by: ["status"],
      }),
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
