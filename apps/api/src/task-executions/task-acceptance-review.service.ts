import { randomUUID } from "node:crypto";
import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { TaskAcceptanceReport } from "@devproof/contracts";
import {
  acceptanceReviewResultSchema,
  acceptanceReviewOutcomeSchema,
} from "@devproof/agent-runtime-protocol";
import type { z } from "zod";
import { PrismaService } from "../database/prisma.service.js";
import { AgentModelConfigurationService } from "../console/agent-model-configuration.service.js";
import { redactText } from "../observability/observability.service.js";
import {
  acceptanceReportInclude,
  buildTaskAcceptanceReport,
} from "./task-acceptance-report.js";

export function acceptanceReviewContext(report: TaskAcceptanceReport) {
  return JSON.stringify({
    title: report.title,
    scope: report.scope,
    score: report.assessment.score,
    recommendation: report.assessment.recommendation,
    acceptanceVerdict: report.verdict,
    scoringRule:
      "必需验收点等权；有完整证据的通过项计分；未知、失败和待完成项不计分但保留在分母。不得改分、将未知当通过，或把受阻当产品失败。cleanup 是独立的后续收尾提醒，不改变验证判定或上线建议；不要将其描述为验收未完成。",
    assessment: report.assessment,
    requirements: report.requirements,
    cases: report.cases.map((c) => ({
      name: c.name,
      deployment: c.deployment,
      verdict: c.verdict,
      cleanup: c.cleanup,
      issues: c.issues,
      criteria: c.criteria.map((k) => ({
        id: k.id,
        description: k.description,
        required: k.required,
        verdict: k.verdict,
        observed: k.summary,
        evidenceRefs: k.evidence.map((e) => e.ref),
      })),
    })),
    issues: report.issues,
  });
}

export function validateAcceptanceReview(
  report: TaskAcceptanceReport,
  value: unknown,
) {
  const result = acceptanceReviewResultSchema.parse(value);
  if (
    result.score !== report.assessment.score ||
    result.recommendation !== report.assessment.recommendation
  )
    throw new ConflictException(
      "AI review must preserve the evidence score and release gates.",
    );
  const keys = new Set(report.assessment.findings.map((f) => f.key));
  const refs = result.focusAreas.map((f) => f.criterionKey);
  if (refs.some((key) => !keys.has(key)) || new Set(refs).size !== refs.length)
    throw new ConflictException(
      "AI review references unknown or duplicate findings.",
    );
  // The UI always retains every original finding, even when the model prioritizes only some.
  return result;
}

@Injectable()
export class TaskAcceptanceReviewService {
  private readonly logger = new Logger(TaskAcceptanceReviewService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly models: AgentModelConfigurationService,
  ) {}

  async enqueueForTask(teamId: string, taskId: string) {
    const row = await this.prisma.taskExecution.findFirst({
      where: { id: taskId, teamId },
      include: acceptanceReportInclude,
    });
    if (row) await this.attach(teamId, buildTaskAcceptanceReport(row));
  }

  async attach(
    teamId: string,
    report: TaskAcceptanceReport,
  ): Promise<TaskAcceptanceReport> {
    if (
      !report.final ||
      !report.cases.length ||
      report.cases.some(
        (c) => !["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(c.lifecycle),
      )
    )
      return report;
    try {
      // All callers have a scoped report; recheck ownership for independent service use.
      const owned = await this.prisma.taskExecution.count({
        where: { id: report.taskId, teamId },
      });
      if (!owned) return report;
      const row = await this.prisma.taskAcceptanceReview.upsert({
        where: {
          taskExecutionId_revision: {
            taskExecutionId: report.taskId,
            revision: report.revision,
          },
        },
        create: { taskExecutionId: report.taskId, revision: report.revision },
        update: {},
      });
      const parsed = acceptanceReviewResultSchema.safeParse(row.result);
      const result =
        parsed.success && row.status === "COMPLETED" ? parsed.data : null;
      return {
        ...report,
        review: {
          status: row.status as NonNullable<
            TaskAcceptanceReport["review"]
          >["status"],
          model: row.model,
          generatedAt: result ? row.updatedAt.toISOString() : null,
          summary: result?.summary ?? null,
          releaseReason: result?.releaseReason ?? null,
          focusAreas: result?.focusAreas ?? [],
          error: row.error,
        },
      };
    } catch (error) {
      this.logger.warn(
        `Acceptance review unavailable: ${redactText(String(error))}`,
      );
      return {
        ...report,
        review: {
          status: "FAILED",
          model: null,
          generatedAt: null,
          summary: null,
          releaseReason: null,
          focusAreas: [],
          error: "AI 评述暂时不可用，证据评分和验收结果已保留。",
        },
      };
    }
  }

  async claim(teamId: string, workerId: string) {
    const candidates = await this.models.candidatesForPool(
      teamId,
      "SPEC_ANALYSIS",
    );
    if (!candidates.length) return { task: null };
    const now = new Date();
    const expired = { status: "RUNNING", leaseExpiresAt: { lt: now } };
    await this.prisma.taskAcceptanceReview.updateMany({
      where: { ...expired, attempts: { gte: 2 }, taskExecution: { teamId } },
      data: {
        status: "FAILED",
        error: "AI 评述超过执行时限，已保留证据评分。",
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    const jobs = await this.prisma.taskAcceptanceReview.findMany({
      where: {
        taskExecution: {
          teamId,
          lifecycle: { in: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
        },
        attempts: { lt: 2 },
        OR: [{ status: "QUEUED" }, expired],
      },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    for (const job of jobs) {
      const leaseToken = randomUUID();
      const deadlineAt = new Date(now.getTime() + 8 * 60_000);
      const claimed = await this.prisma.taskAcceptanceReview.updateMany({
        where: {
          id: job.id,
          updatedAt: job.updatedAt,
          taskExecution: { teamId },
        },
        data: {
          status: "RUNNING",
          attempts: { increment: 1 },
          leaseToken,
          leaseOwner: workerId,
          leaseExpiresAt: deadlineAt,
        },
      });
      if (!claimed.count) continue;
      const row = await this.prisma.taskExecution.findFirst({
        where: { id: job.taskExecutionId, teamId },
        include: acceptanceReportInclude,
      });
      const report = row ? buildTaskAcceptanceReport(row) : null;
      const context = report ? acceptanceReviewContext(report) : "";
      if (
        !report?.final ||
        report.revision !== job.revision ||
        context.length > 220000
      ) {
        await this.prisma.taskAcceptanceReview.updateMany({
          where: { id: job.id, leaseToken },
          data: {
            status: "FAILED",
            error:
              context.length > 220000
                ? "报告超过 AI 评述容量，已保留完整证据评分和明细。"
                : "报告版本已变更，本次评述不再适用。",
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        continue;
      }
      return {
        task: {
          id: job.id,
          leaseToken,
          deadlineAt: deadlineAt.toISOString(),
          context,
          modelCandidates: candidates,
        },
      };
    }
    return { task: null };
  }

  async complete(
    teamId: string,
    id: string,
    input: z.infer<typeof acceptanceReviewOutcomeSchema>,
  ) {
    const job = await this.prisma.taskAcceptanceReview.findFirst({
      where: { id, taskExecution: { teamId } },
    });
    if (
      !job ||
      job.leaseToken !== input.leaseToken ||
      job.leaseOwner !== input.workerId
    )
      throw new ConflictException("Review lease was lost.");
    // Retries after an uncertain acknowledgement are idempotent for this lease.
    if (["COMPLETED", "FAILED"].includes(job.status)) return { accepted: true };
    if (!job.leaseExpiresAt || job.leaseExpiresAt <= new Date())
      throw new ConflictException("Review lease expired.");
    const row = await this.prisma.taskExecution.findFirst({
      where: { id: job.taskExecutionId, teamId },
      include: acceptanceReportInclude,
    });
    const report = row ? buildTaskAcceptanceReport(row) : null;
    if (!report?.final || report.revision !== job.revision)
      throw new ConflictException("Report revision changed.");
    const result = input.result
      ? validateAcceptanceReview(report, input.result)
      : null;
    const updated = await this.prisma.taskAcceptanceReview.updateMany({
      where: {
        id,
        status: "RUNNING",
        leaseToken: input.leaseToken,
        leaseOwner: input.workerId,
        leaseExpiresAt: { gt: new Date() },
        taskExecution: { teamId },
      },
      data: {
        status: result ? "COMPLETED" : "FAILED",
        result: result
          ? ({
              ...result,
              summary: redactText(result.summary),
              releaseReason: redactText(result.releaseReason),
              focusAreas: result.focusAreas.map((f) => ({
                ...f,
                impact: redactText(f.impact),
                nextStep: redactText(f.nextStep),
              })),
            } as Prisma.InputJsonValue)
          : Prisma.DbNull,
        model: input.model ?? null,
        error: input.error ? redactText(input.error) : null,
      },
    });
    if (!updated.count) throw new ConflictException("Review lease was lost.");
    return { accepted: true };
  }
}
