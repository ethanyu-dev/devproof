import { taskSourcePresentation } from "./task-source-context.js";
import { isSpecTask } from "@devproof/contracts";
import { Prisma } from "@prisma/client";
import type { SpecAnalysisInputRequest } from "@devproof/agent-runtime-protocol";
import {
  taskExecutionCreateInputSchema,
  type TaskAnalysisInput,
} from "@devproof/contracts";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { specAnalysisInputRequestSchema } from "@devproof/agent-runtime-protocol";
import type { PrismaService } from "../database/prisma.service.js";
import { refreshedTaskDeadline } from "./task-deadline.js";
import { enqueueTaskWaitingNotification } from "./task-waiting-notification.js";

type Source = { kind: string; content: unknown; uri: string };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Missing source types are optional; explicitly requested sources must be read. */
export function assessAnalysisInputs(
  inputSnapshot: unknown,
  sources: Source[],
  manifest?: { pullRequestUrls?: string[] },
) {
  const input = taskExecutionCreateInputSchema.parse(inputSnapshot);
  if (!isSpecTask(input)) throw new Error("Spec task required.");
  const issueSource = sources.findLast(
    (source) => source.kind === "LINEAR_ISSUE",
  );
  const issue = record(issueSource?.content);
  const description = record(issue.issue).description;
  const issueReady =
    typeof description === "string" && Boolean(description.trim());
  const pullRequestUrls = [
    ...new Set<string>(
      [
        ...(input.pullRequestUrls ?? []),
        ...(manifest?.pullRequestUrls ?? []),
        ...(!manifest && Array.isArray(issue.pullRequestUrls)
          ? issue.pullRequestUrls.filter(
              (url): url is string => typeof url === "string",
            )
          : []),
      ].map((url) => url.replace(/\/$/u, "")),
    ),
  ];
  const prs = sources
    .filter((source) => source.kind === "GITHUB_PULL_REQUEST")
    .map((source) => {
      const pr = record(record(source.content).pullRequest);
      return {
        url: source.uri.replace(/\/$/u, ""),
        headSha: pr.headSha,
        title: pr.title,
        deploymentUrl: pr.deploymentUrl,
        deploymentCandidates: pr.deploymentCandidates,
      };
    });
  const missing: SpecAnalysisInputRequest["missing"] = [];
  if (input.issueRef && !issueReady) missing.push("ISSUE");
  if (
    pullRequestUrls.some(
      (url) =>
        !prs.some(
          (pr) =>
            pr.url === url &&
            typeof pr.headSha === "string" &&
            pr.headSha !== "unknown" &&
            pr.headSha.trim() &&
            typeof pr.title === "string" &&
            pr.title.trim(),
        ),
    )
  ) {
    missing.push("PULL_REQUEST");
  }
  const briefReady = sources.some(
    (source) =>
      source.kind === "TASK_BRIEF" &&
      typeof record(source.content).goal === "string" &&
      Boolean(String(record(source.content).goal).trim()),
  );
  if (!input.issueRef && !pullRequestUrls.length && !briefReady)
    missing.push("TEST_INTENT");
  const deploymentCandidates = [
    ...new Set<string>(
      prs.flatMap((pr) => [
        ...(typeof pr.deploymentUrl === "string" ? [pr.deploymentUrl] : []),
        ...(Array.isArray(pr.deploymentCandidates)
          ? pr.deploymentCandidates.filter(
              (url): url is string => typeof url === "string",
            )
          : []),
      ]),
    ),
  ];
  const explicitTarget = input.deployments[0]?.targetUrl ?? input.targetUrl;
  const targetUrl =
    explicitTarget ??
    (deploymentCandidates.length === 1 && !missing.includes("PULL_REQUEST")
      ? deploymentCandidates[0]!
      : null);
  if (!targetUrl) missing.push("DEPLOYMENT_TARGET");
  const descriptions = {
    TEST_INTENT: "请补充本次需要验证的业务目标和可观察的预期结果。",
    ISSUE:
      "指定的 Issue 内容不可用或为空。请修复访问权限、替换链接，或明确移除并提供其他测试依据。",
    PULL_REQUEST:
      "指定的 PR 内容不可用。请修复仓库权限、替换链接，或明确移除并提供其他测试依据。",
    DEPLOYMENT_TARGET:
      "测试环境地址缺失或无法唯一确定，请明确本次需要验证的环境地址。",
  };
  const request: SpecAnalysisInputRequest | null = missing.length
    ? {
        missing,
        message: missing.map((field) => descriptions[field]).join("\n"),
        issueRef: input.issueRef ?? "",
        ...(input.goal ? { goal: input.goal } : {}),
        pullRequestUrls,
        deploymentCandidates: deploymentCandidates.slice(0, 25),
      }
    : null;
  return { request, targetUrl, pullRequestUrls };
}

/** Parent and attempt must already be locked and their active lease checked. */
export async function pauseAnalysisForInput(
  tx: Prisma.TransactionClient,
  attempt: {
    id: string;
    number: number;
    stageId: string;
    stage: {
      taskExecution: {
        id: string;
        teamId: string;
        title: string;
        inputSnapshot: Prisma.JsonValue;
        environmentSnapshot: Prisma.JsonValue;
        notificationContext: Prisma.JsonValue;
      };
    };
  },
  request: SpecAnalysisInputRequest,
  now: Date,
  completionId?: string,
) {
  const task = attempt.stage.taskExecution;
  const result = {
    attemptNumber: attempt.number,
    completionId,
    nextAttemptScheduled: false,
    stageStatus: "WAITING_INPUT" as const,
    inputRequest: request,
  };
  await tx.taskStageAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "SUCCEEDED",
      finishedAt: now,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      result: json(result),
    },
  });
  await tx.taskExecutionStage.update({
    where: { id: attempt.stageId },
    data: {
      status: "WAITING_INPUT",
      finishedAt: null,
      waitingReason: "ANALYSIS_INPUT_REQUIRED",
      lastError: Prisma.JsonNull,
    },
  });
  await tx.taskExecution.update({
    where: { id: task.id },
    data: {
      lifecycle: "WAITING_INPUT",
      currentStage: "SPEC_ANALYSIS",
      waitingReason: "ANALYSIS_INPUT_REQUIRED",
      projectionNeededAt: null,
      environmentSnapshot: json({
        ...record(task.environmentSnapshot),
        analysisInputRequest: { ...request, attemptId: attempt.id },
      }),
    },
  });
  await tx.taskExecutionEvent.create({
    data: {
      taskExecutionId: task.id,
      teamId: task.teamId,
      actor: "CONTROL_PLANE",
      kind: "task.input.required",
      payload: json({ stage: "SPEC_ANALYSIS", ...request }),
    },
  });
  const input = taskExecutionCreateInputSchema.parse(task.inputSnapshot);
  if (
    isSpecTask(input) &&
    input.hitlPolicy.notificationChannels.includes("FEISHU")
  ) {
    await enqueueTaskWaitingNotification(tx, {
      generation: attempt.number,
      input: "ANALYSIS_CONTEXT",
      message: request.message,
      notificationContext: task.notificationContext,
      reason: "ANALYSIS_INPUT_REQUIRED",
      taskExecutionId: task.id,
      teamId: task.teamId,
      title: task.title,
    });
  }
  return { accepted: true, ...result };
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function resumeAnalysisWithInput(
  prisma: PrismaService,
  teamId: string,
  id: string,
  input: TaskAnalysisInput,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM task_executions WHERE id = ${id}::uuid AND team_id = ${teamId}::uuid FOR UPDATE`;
    const task = await tx.taskExecution.findFirst({
      where: { id, teamId },
      include: { stages: true, executionRuns: { select: { id: true } } },
    });
    if (!task) throw new NotFoundException("Task was not found.");
    const stage = task.stages.find((item) => item.type === "SPEC_ANALYSIS");
    const environment = record(task.environmentSnapshot);
    const pending = record(environment.analysisInputRequest);
    if (
      !isSpecTask(task) ||
      task.cancelRequestedAt ||
      task.lifecycle !== "WAITING_INPUT" ||
      stage?.status !== "WAITING_INPUT" ||
      task.waitingReason !== "ANALYSIS_INPUT_REQUIRED" ||
      task.executionRuns.length ||
      pending.attemptId !== input.expectedAttemptId
    )
      throw new ConflictException("任务已变化，请刷新后再补充分析信息。");
    const request = specAnalysisInputRequestSchema.parse(pending);
    if (
      request.missing.includes("DEPLOYMENT_TARGET") &&
      !input.deployments?.length
    )
      throw new BadRequestException("请补充明确的测试环境地址。");
    if (request.missing.includes("TEST_INTENT") && !input.goal?.trim())
      throw new BadRequestException("请补充具体测试目标和预期结果。");
    if (request.missing.includes("ISSUE") && input.issueRef === undefined)
      throw new BadRequestException("请修正 Issue，或明确移除该来源。");
    if (
      request.missing.includes("PULL_REQUEST") &&
      input.pullRequestUrls === undefined
    )
      throw new BadRequestException("请修正 PR，或明确移除该来源。");
    const previous = record(task.inputSnapshot);
    const nextInput = taskExecutionCreateInputSchema.parse({
      ...previous,
      // A legacy Issue task may explicitly replace its Issue with another input.
      ...(input.issueRef === null
        ? { kind: "SPEC_TASK", issueRef: undefined }
        : {}),
      ...(input.issueRef ? { issueRef: input.issueRef } : {}),
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.pullRequestUrls !== undefined
        ? { pullRequestUrls: input.pullRequestUrls }
        : {}),
      ...(input.deployments?.length
        ? {
            deployments: input.deployments,
            targetUrl: input.deployments[0]!.targetUrl,
          }
        : {}),
    });
    const now = new Date();
    const nextNumber = stage.currentAttemptNumber + 1;
    const { analysisInputRequest: _request, ...previousEnvironment } =
      environment;
    await tx.taskExecution.update({
      where: { id },
      data: {
        inputSnapshot: json(nextInput),
        kind: nextInput.kind,
        ...(isSpecTask(nextInput) ? taskSourcePresentation(nextInput) : {}),
        environmentSnapshot: json(previousEnvironment),
        lifecycle: "QUEUED",
        currentStage: "SPEC_ANALYSIS",
        waitingReason: null,
        deadlineAt: refreshedTaskDeadline(nextInput, now),
        projectionNeededAt: now,
        executionGeneration: { increment: 1 },
        finishedAt: null,
        verdict: null,
        executionDisposition: null,
      },
    });
    if (input.deployments?.length) {
      await tx.taskDeployment.deleteMany({ where: { taskExecutionId: id } });
      await tx.taskDeployment.createMany({
        data: input.deployments.map((deployment) => ({
          taskExecutionId: id,
          key: deployment.key,
          name: deployment.name,
          targetUrl: deployment.targetUrl,
          environmentSnapshot: json(deployment.environment),
        })),
      });
    }
    await tx.taskExecutionStage.update({
      where: { id: stage.id },
      data: {
        currentAttemptNumber: nextNumber,
        maxAttempts: stage.maxAttempts + 1,
        status: "PENDING",
        waitingReason: null,
        lastError: Prisma.JsonNull,
        finishedAt: null,
      },
    });
    await tx.taskStageAttempt.create({
      data: {
        stageId: stage.id,
        number: nextNumber,
        inputSnapshot: json(nextInput),
      },
    });
    await tx.taskExecutionEvent.create({
      data: {
        taskExecutionId: id,
        teamId,
        actor: "HUMAN",
        kind: "task.input.provided",
        payload: json({
          input: "ANALYSIS_CONTEXT",
          stage: "SPEC_ANALYSIS",
          attemptNumber: nextNumber,
          missing: request.missing,
        }),
      },
    });
  });
}
