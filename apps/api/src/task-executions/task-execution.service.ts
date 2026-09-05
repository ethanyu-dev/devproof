import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { runtimeGeneratedSpecCaseSchema } from "@devproof/agent-runtime-protocol";
import {
  generatedTestCaseDefinitionSchema,
  executionConcurrencyPolicySchema,
  type ExecutionConcurrencyPolicy,
  taskExecutionCreateInputSchema,
  taskExecutionStageTypeSchema,
  testGenerationContextSchema,
  type ExecutionRunCreateInput,
  type TaskDeployment,
  type TaskDeploymentsInput,
  type TaskExecutionCreateInput,
  type TaskStageRetryInput,
} from "@devproof/contracts";
import {
  generateBusinessTestSpec,
  countCaseExecutions,
  summarizeCaseScheduling,
  readCaseScheduling,
  caseExecutionPhase,
  type CaseSchedulingDecision,
  type CaseExecutionProgress,
  projectTaskExecution,
  selectPrimaryPullRequest,
  SPECIFICATION_GENERATOR,
  specificationDefinitionHash,
  testGenerationContextHash,
} from "@devproof/test-domain";

import { env } from "../config/env.js";
import { GithubAccessService } from "../console/github-access.service.js";
import { PrismaService } from "../database/prisma.service.js";
import { ExecutionRunService } from "../execution-runs/execution-run.service.js";
import { redactText } from "../observability/observability.service.js";
import { TaskLogBundleService } from "../post-run-analysis/task-log-bundle.service.js";
import {
  enqueuePostRunAnalysis,
  supersedePostRunAnalyses,
} from "../post-run-analysis/post-run-analysis.service.js";
import { parsePullRequestUrl } from "../specifications/github-pull-request.client.js";
import { IssueContextResolverService } from "../specifications/issue-context-resolver.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { TaskProfileResolverService } from "./task-profile-resolver.service.js";
import { taskDeploymentMatrix } from "./task-deployment-matrix.js";
import {
  enqueueTaskCompletionNotifications,
  taskNotificationContext,
  type TaskNotificationContext,
} from "./task-waiting-notification.js";
import { ProfileReservationService } from "./profile-reservation.service.js";
import { refreshedTaskDeadline } from "./task-deadline.js";

const ANALYSIS_WORKER = `task-analysis:${process.pid}`;
const CASE_DISPATCH_MAX_ATTEMPTS = 3;
const DISPATCH_RETRY_DELAY_MS = 5_000;
const MINIMUM_CHILD_RUN_WINDOW_MS = 30_000;
const currentAgentTaskInclude = {
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { recoveryStatus: true, leaseLostAt: true },
};

export function taskDeadlineElapsed(input: {
  deadlineAt: Date;
  lifecycle: string;
  now: Date;
  waitingForHuman: boolean;
  completedWithinDeadline?: boolean;
}) {
  return (
    input.lifecycle === "TIMED_OUT" ||
    (!input.waitingForHuman &&
      !input.completedWithinDeadline &&
      input.deadlineAt <= input.now &&
      !["COMPLETED", "CANCELLED"].includes(input.lifecycle))
  );
}

const taskDetailInclude = {
  analysisSources: { orderBy: { createdAt: "asc" as const } },
  caseExecutions: {
    include: {
      run: {
        include: {
          _count: { select: { evidences: true, interventions: true } },
          tasks: currentAgentTaskInclude,
        },
      },
      deployment: true,
      testCase: true,
    },
    orderBy: [
      { testCase: { position: "asc" as const } },
      { executionOrdinal: "asc" as const },
    ],
  },
  executionRuns: {
    include: {
      _count: { select: { evidences: true, interventions: true } },
      tasks: currentAgentTaskInclude,
    },
    orderBy: { createdAt: "asc" as const },
  },
  deployments: { orderBy: { createdAt: "asc" as const } },
  profileBinding: {
    include: {
      requestedProfile: {
        select: {
          displayName: true,
          id: true,
          owner: { select: { id: true, name: true } },
          status: true,
        },
      },
      resolvedProfile: {
        select: {
          authRole: true,
          displayName: true,
          environmentKey: true,
          id: true,
          owner: { select: { id: true, name: true } },
          status: true,
        },
      },
    },
  },
  specificationSnapshots: {
    include: {
      cases: { orderBy: { position: "asc" as const } },
    },
    orderBy: { generatedAt: "desc" as const },
  },
  stages: {
    include: { attempts: { orderBy: { number: "asc" as const } } },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.TaskExecutionInclude;

const taskListInclude = {
  caseExecutions: {
    include: {
      run: {
        select: {
          executionDisposition: true,
          lifecycle: true,
          verdict: true,
          tasks: currentAgentTaskInclude,
        },
      },
    },
  },
  executionRuns: {
    select: {
      executionDisposition: true,
      lifecycle: true,
      verdict: true,
      tasks: currentAgentTaskInclude,
    },
  },
  deployments: { select: { id: true, enabled: true } },
  specificationSnapshots: {
    orderBy: { generatedAt: "desc" as const },
    select: {
      _count: { select: { cases: true } },
      cases: { select: { id: true } },
    },
    take: 1,
  },
} satisfies Prisma.TaskExecutionInclude;

const dispatchCandidateInclude = {
  deployment: true,
  taskExecution: {
    include: { analysisSources: true, profileBinding: true, team: true },
  },
  testCase: { include: { snapshot: true } },
} satisfies Prisma.TaskCaseExecutionInclude;

type TaskDetailRow = Prisma.TaskExecutionGetPayload<{
  include: typeof taskDetailInclude;
}>;

export interface TaskRequestActor {
  kind: "USER" | "CREDENTIAL" | "INTEGRATION_EVENT" | "SYSTEM";
  notificationContext?: TaskNotificationContext;
  triggerSource?: "CONSOLE" | "FEISHU" | "ISSUE_ASSIGNEE";
  userId?: string;
}

export interface TaskListFilters {
  createdAfter?: Date;
  kind?: "ISSUE_SPEC" | "DIRECT_RUN" | "LEGACY_RUN";
  query?: string;
  status?:
    | "ACTIVE"
    | "WAITING_HUMAN"
    | "PASSED"
    | "FAILED"
    | "VERIFICATION_FAILED"
    | "EXECUTION_FAILED"
    | "COMPLETED"
    | "CANCELLED"
    | "TIMED_OUT";
}

function taskStatusWhere(
  status: TaskListFilters["status"],
): Prisma.TaskExecutionWhereInput {
  if (!status) return {};
  if (status === "ACTIVE") {
    return { lifecycle: { in: ["QUEUED", "RUNNING", "WAITING_INPUT"] } };
  }
  if (status === "WAITING_HUMAN") return { lifecycle: "WAITING_HUMAN" };
  if (status === "PASSED") return { verdict: status };
  if (status === "FAILED" || status === "VERIFICATION_FAILED") {
    return { verdict: "FAILED" };
  }
  if (status === "EXECUTION_FAILED") {
    return {
      OR: [
        { lifecycle: "TIMED_OUT" },
        {
          executionDisposition: {
            in: [
              "NOT_RUN",
              "BLOCKED",
              "AGENT_ERROR",
              "PROVIDER_ERROR",
              "BROWSER_UNAVAILABLE",
              "RUNTIME_LOST",
            ],
          },
          lifecycle: "COMPLETED",
        },
      ],
      verdict: null,
    };
  }
  return { lifecycle: status };
}

@Injectable()
export class TaskExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: IssueContextResolverService,
    private readonly runs: ExecutionRunService,
    private readonly profileResolver: TaskProfileResolverService,
    private readonly reservations: ProfileReservationService,
    private readonly githubAccess: GithubAccessService,
    private readonly logBundles?: TaskLogBundleService,
  ) {}

  async create(
    current: ToolAuthContext,
    rawInput: unknown,
    actor: TaskRequestActor = { kind: "CREDENTIAL", triggerSource: "CONSOLE" },
  ) {
    const input = taskExecutionCreateInputSchema.parse(rawInput);
    return this.createParsed(current, input, false, actor);
  }

  private async createParsed(
    current: ToolAuthContext,
    input: TaskExecutionCreateInput,
    preserveDirectRunIdempotency = false,
    actor: TaskRequestActor = { kind: "CREDENTIAL", triggerSource: "CONSOLE" },
  ) {
    const existing = await this.prisma.taskExecution.findUnique({
      where: {
        teamId_idempotencyKey: {
          idempotencyKey: input.idempotencyKey,
          teamId: current.team.id,
        },
      },
    });
    if (existing) return this.idempotentDetail(current, existing, input);
    return input.kind === "ISSUE_SPEC"
      ? this.createIssueTask(current, input, actor)
      : this.createDirectTask(
          current,
          input,
          preserveDirectRunIdempotency,
          actor,
        );
  }

  async createCompatibilityRun(
    current: ToolAuthContext,
    input: ExecutionRunCreateInput,
  ) {
    const idempotencyKey = `compat-run:${createHash("sha256")
      .update(input.idempotencyKey)
      .digest("hex")}`;
    const existingRun = await this.prisma.executionRun.findUnique({
      where: {
        teamId_idempotencyKey: {
          idempotencyKey: input.idempotencyKey,
          teamId: current.team.id,
        },
      },
    });
    if (existingRun) {
      const detail = await this.runs.create(current, input);
      if (!existingRun.taskExecutionId) {
        await this.adoptCompatibilityRun(
          current,
          input,
          idempotencyKey,
          existingRun,
        );
      }
      return detail;
    }
    const taskInput = taskExecutionCreateInputSchema.parse({
      idempotencyKey,
      kind: "DIRECT_RUN",
      run: input,
    });
    if (taskInput.kind !== "DIRECT_RUN") {
      throw new ConflictException("Compatibility Run input is invalid.");
    }
    let task = await this.createParsed(current, taskInput, true);
    if (!task.runs.length) {
      await this.dispatchOrphanDirectTask(task.id);
      task = await this.detail(current, task.id);
    }
    const run = task.runs[0];
    if (!run) {
      throw new ServiceUnavailableException(
        `Run dispatch is queued under task ${task.id}; retry with the same idempotency key.`,
      );
    }
    return this.runs.detail(current, run.runId);
  }

  private async adoptCompatibilityRun(
    current: ToolAuthContext,
    input: ExecutionRunCreateInput,
    idempotencyKey: string,
    run: Prisma.ExecutionRunGetPayload<Record<string, never>>,
  ) {
    const now = new Date();
    const lifecycle = compatibilityTaskLifecycle(run.lifecycle);
    const terminal = ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(
      lifecycle,
    );
    const executionStatus = terminal
      ? run.executionDisposition === "EXECUTED"
        ? "SUCCEEDED"
        : "FAILED"
      : "RUNNING";
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.taskExecution.create({
          data: {
            cancelRequestedAt: run.cancelRequestedAt,
            currentStage: "SPEC_EXECUTION",
            deadlineAt: run.deadlineAt,
            environmentSnapshot:
              run.environmentSnapshot as Prisma.InputJsonValue,
            executionDisposition: run.executionDisposition,
            finishedAt: run.finishedAt,
            id: run.id,
            idempotencyKey,
            inputSnapshot: json({
              idempotencyKey,
              kind: "DIRECT_RUN",
              run: input,
            }),
            kind: "DIRECT_RUN",
            lifecycle,
            migrationSource: "COMPATIBILITY_RUN_ADOPTION",
            projectionNeededAt: terminal ? null : now,
            queuedAt: run.queuedAt,
            sourceKind: run.sourceKind,
            sourceRef: run.sourceId,
            startedAt: run.startedAt,
            teamId: current.team.id,
            title: run.goal.slice(0, 500),
            traceId: run.traceId,
            verdict: run.verdict,
          },
        });
        await tx.taskExecutionStage.createMany({
          data: [
            {
              currentAttemptNumber: 0,
              finishedAt: run.createdAt,
              maxAttempts: 1,
              startedAt: run.createdAt,
              status: "SKIPPED",
              taskExecutionId: run.id,
              type: "SPEC_ANALYSIS",
            },
            {
              currentAttemptNumber: run.currentAttemptNumber,
              finishedAt: terminal ? run.finishedAt : null,
              maxAttempts: run.maxAttempts,
              startedAt: run.startedAt,
              status: executionStatus,
              taskExecutionId: run.id,
              type: "SPEC_EXECUTION",
            },
          ],
        });
        await tx.executionRun.update({
          data: { taskExecutionId: run.id },
          where: { id: run.id },
        });
        await tx.taskExecutionEvent.create({
          data: event(
            current.team.id,
            run.id,
            "CONTROL_PLANE",
            "task.compatibility_run_adopted",
            { runId: run.id },
          ),
        });
      });
    } catch (error) {
      if (!uniqueConstraint(error)) throw error;
      const task = await this.prisma.taskExecution.findFirst({
        where: { id: run.id, teamId: current.team.id },
      });
      if (!task) throw error;
      await this.prisma.executionRun.updateMany({
        data: { taskExecutionId: task.id },
        where: { id: run.id, taskExecutionId: null },
      });
    }
  }

  async list(current: ToolAuthContext) {
    const rows = await this.prisma.taskExecution.findMany({
      include: taskListInclude,
      orderBy: { createdAt: "desc" },
      take: 100,
      where: { teamId: current.team.id },
    });
    return rows.map(toTaskSummary);
  }

  async listPage(
    current: ToolAuthContext,
    page: number,
    pageSize: number,
    filters: TaskListFilters = {},
  ) {
    const where: Prisma.TaskExecutionWhereInput = {
      teamId: current.team.id,
      ...(filters.createdAfter
        ? { createdAt: { gte: filters.createdAfter } }
        : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.query
        ? {
            OR: [
              { title: { contains: filters.query, mode: "insensitive" } },
              { sourceRef: { contains: filters.query, mode: "insensitive" } },
              { sourceKind: { contains: filters.query, mode: "insensitive" } },
            ],
          }
        : {}),
      ...taskStatusWhere(filters.status),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.taskExecution.findMany({
        include: taskListInclude,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        where,
      }),
      this.prisma.taskExecution.count({ where }),
    ]);
    return {
      items: rows.map(toTaskSummary),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async detail(current: ToolAuthContext, id: string) {
    const row = await this.prisma.taskExecution.findFirst({
      include: taskDetailInclude,
      where: { id, teamId: current.team.id },
    });
    if (!row)
      throw new NotFoundException(`Task execution ${id} was not found.`);
    return toTaskDetail(row);
  }

  async setCaseExecutionPolicy(
    current: ToolAuthContext,
    taskId: string,
    executionId: string,
    input: ExecutionConcurrencyPolicy,
  ) {
    const policy = executionConcurrencyPolicySchema.parse(input);
    await this.prisma.$transaction(
      async (tx) => {
        const candidate = await tx.taskCaseExecution.findFirst({
          include: { taskExecution: true, testCase: true },
          where: {
            id: executionId,
            taskExecutionId: taskId,
            taskExecution: { teamId: current.team.id },
          },
        });
        if (!candidate)
          throw new NotFoundException("Case execution was not found.");
        if (
          candidate.runId ||
          !["PENDING", "FAILED"].includes(candidate.dispatchStatus) ||
          candidate.dispatchAttempts >= CASE_DISPATCH_MAX_ATTEMPTS ||
          candidate.taskExecution.cancelRequestedAt ||
          !["RUNNING", "QUEUED", "WAITING_INPUT"].includes(
            candidate.taskExecution.lifecycle,
          )
        ) {
          throw new ConflictException(
            "Only an unstarted Case can change its execution policy.",
          );
        }
        const executions = await tx.taskCaseExecution.findMany({
          where: {
            taskExecutionId: taskId,
            deploymentId: candidate.deploymentId,
            testCase: { snapshotId: candidate.testCase.snapshotId },
          },
        });
        if (
          !latestCaseExecutions(executions).some(
            (peer) => peer.id === candidate.id,
          )
        )
          throw new ConflictException(
            "Only the latest execution can change its policy.",
          );
        validateCaseDependencyGraph(
          executions
            .filter(
              (peer) => peer.executionOrdinal === candidate.executionOrdinal,
            )
            .map((peer) => ({
              caseId: peer.caseId,
              executionPolicy:
                peer.id === candidate.id ? policy : peer.executionPolicy,
            })),
        );
        const changed = await tx.taskCaseExecution.updateMany({
          data: {
            executionPolicy: json({
              ...policy,
              provenance: "CONSOLE_REVIEWED",
              version: 1,
            }),
            scheduling: Prisma.JsonNull,
          },
          where: {
            id: executionId,
            runId: null,
            updatedAt: candidate.updatedAt,
            dispatchStatus: candidate.dispatchStatus,
          },
        });
        if (changed.count !== 1)
          throw new ConflictException(
            "Case dispatch already started; refresh its status.",
          );
        await tx.taskExecution.update({
          where: { id: taskId },
          data: { projectionNeededAt: new Date() },
        });
        await tx.taskExecutionEvent.create({
          data: event(
            current.team.id,
            taskId,
            "HUMAN",
            "task.case.policy_updated",
            {
              caseId: candidate.caseId,
              caseExecutionId: executionId,
              policy,
            },
          ),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return this.detail(current, taskId);
  }

  async events(current: ToolAuthContext, id: string, after?: bigint) {
    await this.requireTask(current.team.id, id);
    const rows = await this.prisma.taskExecutionEvent.findMany({
      orderBy: { sequence: "asc" },
      where: {
        taskExecutionId: id,
        teamId: current.team.id,
        ...(after === undefined ? {} : { sequence: { gt: after } }),
      },
    });
    return rows.map((row) => ({ ...row, sequence: row.sequence.toString() }));
  }

  async exportLogs(current: ToolAuthContext, id: string) {
    if (!this.logBundles) {
      throw new ServiceUnavailableException(
        "Task log bundle service is unavailable.",
      );
    }
    return (await this.logBundles.build(current.team.id, id)).bundle;
  }

  async setDeploymentTarget(
    current: ToolAuthContext,
    id: string,
    rawUrl: string,
  ) {
    const url = normalizeTargetUrl(rawUrl);
    return this.setDeployments(current, id, {
      deployments: [
        { environment: {}, key: "default", name: "Default", targetUrl: url },
      ],
    });
  }

  async setDeployments(
    current: ToolAuthContext,
    id: string,
    input: TaskDeploymentsInput,
  ) {
    const deployments = normalizeTaskDeployments(input.deployments);
    const task = await this.prisma.taskExecution.findFirst({
      include: {
        executionRuns: { select: { id: true } },
        specificationSnapshots: {
          include: { cases: true },
          orderBy: { generatedAt: "desc" },
          take: 1,
        },
        stages: true,
      },
      where: { id, teamId: current.team.id },
    });
    if (!task)
      throw new NotFoundException(`Task execution ${id} was not found.`);
    if (task.kind !== "ISSUE_SPEC") {
      throw new ConflictException(
        "Deployment targets can only be provided to Issue tasks.",
      );
    }
    if (task.executionRuns.length) {
      throw new ConflictException(
        "The deployment target is immutable after Case execution starts.",
      );
    }
    const environment = record(task.environmentSnapshot);
    const primary = deployments[0]!;
    const target = new URL(primary.targetUrl);
    const analysisStage = task.stages.find(
      (stage) => stage.type === "SPEC_ANALYSIS",
    );
    if (
      analysisStage?.status !== "SUCCEEDED" ||
      task.lifecycle !== "WAITING_INPUT"
    ) {
      throw new ConflictException(
        "A deployment target can be provided only after Spec analysis requests it.",
      );
    }
    const now = new Date();
    const refreshedDeadlineAt = refreshedTaskDeadline(task.inputSnapshot, now);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.taskExecution.updateMany({
        data: {
          currentStage: "PROFILE_RESOLUTION",
          deadlineAt: refreshedDeadlineAt,
          environmentSnapshot: json({
            ...environment,
            allowedHosts: [target.hostname],
            targetProvidedAt: now.toISOString(),
            targetProvidedBy: current.credential.id,
            targetSource: "MANUAL",
            targetUrl: primary.targetUrl,
          }),
          lifecycle: "RUNNING",
          projectionNeededAt: null,
          waitingReason: null,
        },
        where: {
          cancelRequestedAt: null,
          id,
          lifecycle: "WAITING_INPUT",
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException("The task can no longer accept input.");
      }
      await tx.taskCaseExecution.deleteMany({
        where: { runId: null, taskExecutionId: id },
      });
      await tx.taskDeployment.deleteMany({ where: { taskExecutionId: id } });
      const createdDeployments = await Promise.all(
        deployments.map((deployment) =>
          tx.taskDeployment.create({
            data: {
              environmentSnapshot: json(deployment.environment),
              key: deployment.key,
              name: deployment.name,
              targetUrl: deployment.targetUrl,
              taskExecutionId: id,
            },
          }),
        ),
      );
      const cases = task.specificationSnapshots[0]?.cases ?? [];
      if (cases.length) {
        await tx.taskCaseExecution.createMany({
          data: caseExecutionMatrix(
            id,
            cases,
            createdDeployments,
            task.inputSnapshot,
          ),
        });
      }
      await tx.taskExecutionStage.updateMany({
        data: {
          finishedAt: null,
          status: "PENDING",
          waitingReason: null,
          startedAt: now,
        },
        where: { taskExecutionId: id, type: "PROFILE_RESOLUTION" },
      });
      await tx.taskExecutionEvent.create({
        data: event(current.team.id, id, "HUMAN", "task.input.provided", {
          deadlineAt: refreshedDeadlineAt.toISOString(),
          input: "DEPLOYMENT_TARGET",
          deployments: deployments.map((deployment) => ({
            key: deployment.key,
            targetUrl: deployment.targetUrl,
          })),
        }),
      });
    });
    const profile = await this.profileResolver.resolve(id);
    if (profile?.status === "RESOLVED") {
      await this.dispatchPendingForTask(id);
    }
    return this.detail(current, id);
  }

  async selectProfile(
    current: ToolAuthContext,
    userId: string,
    id: string,
    input: import("@devproof/contracts").TaskProfileSelectionInput,
  ) {
    await this.profileResolver.select(current.team.id, userId, id, input);
    await this.dispatchPendingForTask(id);
    return this.detail(current, id);
  }

  async retryStage(
    current: ToolAuthContext,
    id: string,
    rawStage: string,
    input: TaskStageRetryInput,
  ) {
    const stageType = taskExecutionStageTypeSchema.parse(rawStage);
    const task = await this.prisma.taskExecution.findFirst({
      include: {
        caseExecutions: {
          include: {
            run: { select: { executionDisposition: true, lifecycle: true } },
            testCase: true,
          },
        },
        stages: true,
      },
      where: { id, teamId: current.team.id },
    });
    if (!task)
      throw new NotFoundException(`Task execution ${id} was not found.`);
    if (task.kind === "LEGACY_RUN") {
      throw new ConflictException("Historical task stages cannot be retried.");
    }
    if (task.cancelRequestedAt) {
      throw new ConflictException("A cancelled task cannot be retried.");
    }
    if (task.deadlineAt <= new Date()) {
      throw new ConflictException(
        "The task deadline has passed; create a new task instead.",
      );
    }
    const stage = task.stages.find((item) => item.type === stageType);
    if (!stage)
      throw new NotFoundException(`Task stage ${stageType} was not found.`);
    if (stageType === "PROFILE_RESOLUTION") {
      throw new ConflictException(
        "Update the task profile selection instead of retrying profile resolution.",
      );
    }
    const now = new Date();
    if (stageType === "SPEC_ANALYSIS") {
      if (task.kind !== "ISSUE_SPEC") {
        throw new ConflictException("Only Issue tasks have an analysis stage.");
      }
      if (stage.status !== "FAILED") {
        throw new ConflictException(
          stage.status === "SUCCEEDED"
            ? "Create a new task to refresh an already generated specification."
            : "Only a failed analysis stage can retry.",
        );
      }
      const nextNumber = stage.currentAttemptNumber + 1;
      await this.prisma.$transaction(async (tx) => {
        await supersedePostRunAnalyses(tx, {
          taskExecutionId: id,
          teamId: current.team.id,
        });
        await tx.taskStageAttempt.create({
          data: {
            inputSnapshot: task.inputSnapshot as Prisma.InputJsonValue,
            number: nextNumber,
            stageId: stage.id,
          },
        });
        await tx.taskExecutionStage.update({
          data: {
            currentAttemptNumber: nextNumber,
            lastError: Prisma.JsonNull,
            maxAttempts: Math.max(stage.maxAttempts, nextNumber),
            status: "PENDING",
          },
          where: { id: stage.id },
        });
        const updated = await tx.taskExecution.updateMany({
          data: {
            currentStage: "SPEC_ANALYSIS",
            executionDisposition: null,
            finishedAt: null,
            lifecycle: "QUEUED",
            postRunAnalysisGeneration: { increment: 1 },
            projectionNeededAt: now,
            verdict: null,
            waitingReason: null,
          },
          where: { cancelRequestedAt: null, id },
        });
        if (updated.count !== 1) {
          throw new ConflictException("The task can no longer be retried.");
        }
        await tx.taskExecutionEvent.create({
          data: event(current.team.id, id, "HUMAN", "task.stage.retry_queued", {
            attemptNumber: nextNumber,
            reason: input.reason,
            stage: stageType,
          }),
        });
      });
    } else {
      if (task.kind !== "ISSUE_SPEC") {
        throw new ConflictException(
          "Only Issue task Case executions can be retried in place.",
        );
      }
      if (stage.status !== "FAILED") {
        throw new ConflictException("Only a failed execution stage can retry.");
      }
      const retryCases = latestCaseExecutions(task.caseExecutions).filter(
        (item) => item.run?.executionDisposition !== "EXECUTED",
      );
      if (!retryCases.length) {
        throw new ConflictException(
          "No failed Case executions can be retried.",
        );
      }
      const nextNumber = stage.currentAttemptNumber + 1;
      await this.prisma.$transaction(async (tx) => {
        await supersedePostRunAnalyses(tx, {
          taskExecutionId: id,
          teamId: current.team.id,
        });
        await tx.taskCaseExecution.updateMany({
          data: { dispatchStatus: "CANCELLED" },
          where: {
            id: {
              in: retryCases.filter((item) => !item.run).map((item) => item.id),
            },
          },
        });
        for (const item of retryCases) {
          const policy = executionConcurrencyPolicySchema.safeParse(
            item.executionPolicy,
          );
          const dependencies = policy.success
            ? (policy.data.dependsOnCaseIds ?? [])
            : [];
          if (
            dependencies.some(
              (caseId) =>
                !retryCases.some(
                  (peer) =>
                    peer.caseId === caseId &&
                    peer.deploymentId === item.deploymentId &&
                    peer.executionOrdinal === item.executionOrdinal &&
                    peer.testCase.snapshotId === item.testCase.snapshotId,
                ) &&
                !task.caseExecutions.some(
                  (peer) =>
                    peer.caseId === caseId &&
                    peer.deploymentId === item.deploymentId &&
                    peer.executionOrdinal === item.executionOrdinal + 1 &&
                    peer.testCase.snapshotId === item.testCase.snapshotId,
                ),
            )
          ) {
            throw new ConflictException(
              "Retrying this stage requires all Case dependencies in the same execution round; create a new task or rerun the prerequisites first.",
            );
          }
        }
        await tx.taskCaseExecution.createMany({
          data: retryCases.map((item) => ({
            caseId: item.caseId,
            deploymentId: item.deploymentId,
            executionOrdinal: item.executionOrdinal + 1,
            dispatchOrder: item.dispatchOrder ?? item.testCase.position,
            executionPolicy: item.executionPolicy ?? Prisma.JsonNull,
            taskExecutionId: id,
          })),
        });
        await tx.taskExecutionStage.update({
          data: {
            currentAttemptNumber: nextNumber,
            lastError: Prisma.JsonNull,
            maxAttempts: Math.max(stage.maxAttempts, nextNumber),
            status: "RUNNING",
          },
          where: { id: stage.id },
        });
        const updated = await tx.taskExecution.updateMany({
          data: {
            currentStage: "SPEC_EXECUTION",
            executionDisposition: null,
            finishedAt: null,
            lifecycle: "RUNNING",
            postRunAnalysisGeneration: { increment: 1 },
            projectionNeededAt: now,
            verdict: null,
          },
          where: { cancelRequestedAt: null, id },
        });
        if (updated.count !== 1) {
          throw new ConflictException("The task can no longer be retried.");
        }
        await tx.taskExecutionEvent.create({
          data: event(current.team.id, id, "HUMAN", "task.stage.retry_queued", {
            attemptNumber: nextNumber,
            caseCount: retryCases.length,
            reason: input.reason,
            stage: stageType,
          }),
        });
      });
      await this.dispatchPendingForTask(id);
    }
    return this.detail(current, id);
  }

  async rerunCase(
    current: ToolAuthContext,
    id: string,
    caseId: string,
    deploymentId?: string,
  ) {
    const now = new Date();
    const dispatchDeadline = new Date(
      now.getTime() + MINIMUM_CHILD_RUN_WINDOW_MS,
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        const task = await tx.taskExecution.findFirst({
          include: {
            caseExecutions: {
              include: { run: { select: { lifecycle: true } }, testCase: true },
              orderBy: { executionOrdinal: "desc" },
              where: { caseId, ...(deploymentId ? { deploymentId } : {}) },
            },
            stages: true,
          },
          where: { id, teamId: current.team.id },
        });
        if (!task) {
          throw new NotFoundException(`Task execution ${id} was not found.`);
        }
        if (task.kind !== "ISSUE_SPEC") {
          throw new ConflictException(
            "Only Spec Runtime executions can be rerun in place.",
          );
        }
        if (task.cancelRequestedAt) {
          throw new ConflictException(
            "A Runtime from a cancelled task cannot be rerun.",
          );
        }
        if (task.deadlineAt <= dispatchDeadline) {
          throw new ConflictException(
            "The task deadline cannot accommodate another Runtime; create a new task instead.",
          );
        }
        const latestExecutions = latestCaseExecutions(task.caseExecutions);
        if (!latestExecutions.length) {
          throw new NotFoundException(`Spec Case ${caseId} was not found.`);
        }
        if (latestExecutions.some((execution) => !execution.run)) {
          throw new ConflictException(
            "At least one latest Spec Runtime has not been created yet.",
          );
        }
        if (
          latestExecutions.some(
            (execution) =>
              !["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(
                execution.run!.lifecycle,
              ),
          )
        ) {
          throw new ConflictException(
            "Only terminal Spec Runtimes can be rerun.",
          );
        }
        const executionStage = task.stages.find(
          (stage) => stage.type === "SPEC_EXECUTION",
        );
        if (!executionStage) {
          throw new NotFoundException(
            "The task does not have a Spec execution stage.",
          );
        }
        for (const latest of latestExecutions) {
          const policy = executionConcurrencyPolicySchema.safeParse(
            latest.executionPolicy,
          );
          const dependencies = policy.success
            ? (policy.data.dependsOnCaseIds ?? [])
            : [];
          if (dependencies.length) {
            const peers = await tx.taskCaseExecution.findMany({
              select: { caseId: true },
              where: {
                taskExecutionId: task.id,
                deploymentId: latest.deploymentId,
                executionOrdinal: latest.executionOrdinal + 1,
                testCase: { snapshotId: latest.testCase.snapshotId },
                caseId: { in: dependencies },
              },
            });
            if (
              dependencies.some(
                (dependency) =>
                  !peers.some((peer) => peer.caseId === dependency),
              )
            ) {
              throw new ConflictException(
                "Rerun the prerequisite Cases in the same execution round before rerunning this Case.",
              );
            }
          }
        }
        const nextExecutions = await Promise.all(
          latestExecutions.map((latest) =>
            tx.taskCaseExecution.create({
              data: {
                caseId,
                deploymentId: latest.deploymentId,
                executionOrdinal: latest.executionOrdinal + 1,
                dispatchOrder: latest.dispatchOrder ?? latest.testCase.position,
                executionPolicy: latest.executionPolicy ?? Prisma.JsonNull,
                taskExecutionId: task.id,
              },
              select: {
                deploymentId: true,
                executionOrdinal: true,
                id: true,
              },
            }),
          ),
        );
        await tx.taskExecutionStage.update({
          data: {
            finishedAt: null,
            lastError: Prisma.JsonNull,
            status: "RUNNING",
            waitingReason: null,
          },
          where: { id: executionStage.id },
        });
        await supersedePostRunAnalyses(tx, {
          taskExecutionId: task.id,
          teamId: current.team.id,
        });
        const reopened = await tx.taskExecution.updateMany({
          data: {
            currentStage: "SPEC_EXECUTION",
            executionDisposition: null,
            finishedAt: null,
            lifecycle: "RUNNING",
            postRunAnalysisGeneration: { increment: 1 },
            projectionNeededAt: now,
            verdict: null,
            waitingReason: null,
          },
          where: {
            cancelRequestedAt: null,
            deadlineAt: { gt: dispatchDeadline },
            id: task.id,
            teamId: current.team.id,
          },
        });
        if (reopened.count !== 1) {
          throw new ConflictException(
            "The task can no longer accept a Runtime rerun.",
          );
        }
        await Promise.all(
          nextExecutions.map((nextExecution) => {
            const previous = latestExecutions.find(
              (execution) =>
                execution.deploymentId === nextExecution.deploymentId,
            )!;
            return tx.taskExecutionEvent.create({
              data: event(
                current.team.id,
                task.id,
                "HUMAN",
                "task.case.rerun_queued",
                {
                  caseExecutionId: nextExecution.id,
                  caseId,
                  deploymentId: nextExecution.deploymentId,
                  executionOrdinal: nextExecution.executionOrdinal,
                  previousCaseExecutionId: previous.id,
                  requestedByCredentialId: current.credential.id,
                },
              ),
            });
          }),
        );
        return nextExecutions;
      });
    } catch (error) {
      if (uniqueConstraint(error)) {
        throw new ConflictException(
          "This Spec Runtime has already been queued for rerun.",
        );
      }
      throw error;
    }
    await this.dispatchPendingForTask(id);
    return this.detail(current, id);
  }

  async cancel(current: ToolAuthContext, id: string) {
    const task = await this.prisma.taskExecution.findFirst({
      include: { executionRuns: { select: { id: true, lifecycle: true } } },
      where: { id, teamId: current.team.id },
    });
    if (!task)
      throw new NotFoundException(`Task execution ${id} was not found.`);
    if (["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(task.lifecycle)) {
      await this.profileResolver.releasePendingRequests(id);
      return this.detail(current, id);
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.taskExecution.update({
        data: {
          cancelRequestedAt: now,
          executionDisposition: null,
          finishedAt: now,
          lifecycle: "CANCELLED",
          projectionNeededAt: null,
          verdict: null,
          waitingReason: null,
        },
        where: { id },
      });
      await tx.taskExecutionStage.updateMany({
        data: { finishedAt: now, status: "CANCELLED", waitingReason: null },
        where: {
          status: { in: ["PENDING", "RUNNING", "WAITING_INPUT"] },
          taskExecutionId: id,
        },
      });
      await tx.taskStageAttempt.updateMany({
        data: {
          finishedAt: now,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          status: "CANCELLED",
        },
        where: {
          stage: { taskExecutionId: id },
          status: { in: ["PENDING", "RUNNING"] },
        },
      });
      await tx.taskCaseExecution.updateMany({
        data: { dispatchStatus: "CANCELLED" },
        where: {
          dispatchStatus: { in: ["PENDING", "DISPATCHING", "FAILED"] },
          runId: null,
          taskExecutionId: id,
        },
      });
      await tx.taskExecutionEvent.create({
        data: event(current.team.id, id, "HUMAN", "task.cancel_requested", {
          requestedByCredentialId: current.credential.id,
        }),
      });
      await this.profileResolver.releasePendingRequests(id, tx);
      await enqueuePostRunAnalysis(tx, {
        taskExecutionId: task.id,
      });
    });
    for (const run of task.executionRuns) {
      if (!["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(run.lifecycle)) {
        await this.runs.cancel(current, run.id).catch(() => undefined);
      }
    }
    await this.reservations.releaseTask(id);
    return this.detail(current, id);
  }

  async rerun(
    current: ToolAuthContext,
    id: string,
    actor: TaskRequestActor = {
      kind: "CREDENTIAL",
      triggerSource: "CONSOLE",
    },
  ) {
    const task = await this.prisma.taskExecution.findFirst({
      select: {
        id: true,
        inputSnapshot: true,
        kind: true,
        notificationContext: true,
      },
      where: { id, teamId: current.team.id },
    });
    if (!task)
      throw new NotFoundException(`Task execution ${id} was not found.`);
    if (task.kind === "LEGACY_RUN") {
      throw new ConflictException("Historical tasks cannot be rerun.");
    }
    const input = taskExecutionCreateInputSchema.parse(task.inputSnapshot);
    const rerunInput = taskExecutionCreateInputSchema.parse({
      ...input,
      idempotencyKey: `rerun:${id}:${randomUUID()}`,
    });
    const originalFeishuContext = taskNotificationContext(
      task.notificationContext,
    ).feishu;
    const rerun = await this.createParsed(current, rerunInput, false, {
      ...actor,
      notificationContext:
        actor.notificationContext ??
        (originalFeishuContext?.replyToMessageId
          ? {
              feishu: {
                replyToMessageId: originalFeishuContext.replyToMessageId,
              },
            }
          : {}),
    });
    await this.prisma.taskExecutionEvent.createMany({
      data: [
        event(current.team.id, id, "HUMAN", "task.rerun.created", {
          rerunTaskId: rerun.id,
        }),
        event(current.team.id, rerun.id, "CONTROL_PLANE", "task.rerun.linked", {
          sourceTaskId: id,
        }),
      ],
    });
    return this.detail(current, rerun.id);
  }

  /** Called by the durable worker; one poll is safe across multiple API replicas. */
  async reconcile(limit = 25) {
    let analyzed = 0;
    if (env().SPEC_ANALYSIS_MODE === "DETERMINISTIC") {
      for (let index = 0; index < limit; index += 1) {
        const claimed = await this.claimAnalysisAttempt();
        if (!claimed) break;
        analyzed += 1;
        try {
          await this.executeAnalysis(claimed.id, claimed.leaseToken!);
        } catch (error) {
          await this.failAnalysis(claimed.id, claimed.leaseToken!, error);
        }
      }
    }
    const exhaustedDispatches = await this.expireExhaustedDispatches(limit * 4);
    const cancelledRuns = await this.reconcileCancelledRuns(limit * 4);
    const profilesResolved = await this.profileResolver.reconcile(limit);
    const profileReservations = await this.reservations.reconcile(limit * 4);
    const directDispatched = await this.dispatchOrphanDirectTasks(limit);
    const dispatched = await this.dispatchPending(limit * 4);
    const projected = await this.projectPending(limit * 4);
    return {
      analyzed,
      cancelledRuns,
      directDispatched,
      dispatched,
      exhaustedDispatches,
      profilesResolved,
      profileReservations,
      projected,
    };
  }

  async projectTask(taskExecutionId: string) {
    const task = await this.prisma.taskExecution.findUnique({
      include: {
        caseExecutions: {
          include: { run: { include: { tasks: currentAgentTaskInclude } } },
        },
        deployments: { select: { id: true }, where: { enabled: true } },
        executionRuns: { include: { tasks: currentAgentTaskInclude } },
        profileBinding: true,
        specificationSnapshots: {
          orderBy: { generatedAt: "desc" },
          select: {
            primaryPullRequestUrl: true,
            summary: true,
            cases: { select: { id: true } },
          },
          take: 1,
        },
        stages: true,
        team: true,
      },
      where: { id: taskExecutionId },
    });
    if (!task) return null;
    const analysis = task.stages.find(
      (stage) => stage.type === "SPEC_ANALYSIS",
    );
    const execution = task.stages.find(
      (stage) => stage.type === "SPEC_EXECUTION",
    );
    if (!analysis || !execution) return null;
    const environment = record(task.environmentSnapshot);
    const currentCases = task.specificationSnapshots[0]?.cases;
    const latestIssueExecutions = latestCaseExecutions(
      task.caseExecutions.filter(
        (item) =>
          !currentCases ||
          currentCases.some((testCase) => testCase.id === item.caseId),
      ),
    );
    const issueCases = latestIssueExecutions.map((item) => ({
      scheduling: item.scheduling,
      dispatchAttempts: item.dispatchAttempts,
      dispatchMaxAttempts: CASE_DISPATCH_MAX_ATTEMPTS,
      dispatchStatus: item.dispatchStatus,
      run: item.run
        ? {
            executionDisposition: item.run.executionDisposition,
            lifecycle: item.run.lifecycle,
            verdict: item.run.verdict,
            tasks: item.run.tasks,
          }
        : null,
    }));
    const directCases = task.executionRuns.map((run) => ({
      dispatchAttempts: 1,
      dispatchMaxAttempts: 1,
      dispatchStatus: "LINKED" as const,
      run: {
        executionDisposition: run.executionDisposition,
        lifecycle: run.lifecycle,
        verdict: run.verdict,
        tasks: run.tasks,
      },
    }));
    const waitingForHuman = [...issueCases, ...directCases].some(
      (item) => item.run?.lifecycle === "WAITING_HUMAN",
    );
    const direct = task.kind === "DIRECT_RUN" || task.kind === "LEGACY_RUN";
    const matrix = taskDeploymentMatrix(
      task.id,
      currentCases ?? [],
      task.deployments,
    );
    const allPlannedCasesLinked = direct
      ? task.executionRuns.length > 0
      : matrix.length > 0 &&
        matrix.every((planned) =>
          latestIssueExecutions.some(
            (item) =>
              item.caseId === planned.caseId &&
              item.deploymentId === planned.deploymentId &&
              item.dispatchStatus === "LINKED" &&
              item.run,
          ),
        );
    const terminalRuns = direct
      ? task.executionRuns
      : latestIssueExecutions.flatMap((item) => (item.run ? [item.run] : []));
    const completedWithinDeadline =
      allPlannedCasesLinked &&
      terminalRuns.every(
        (run) =>
          run.lifecycle === "COMPLETED" &&
          run.finishedAt !== null &&
          run.finishedAt <= task.deadlineAt,
      );
    const timedOut = taskDeadlineElapsed({
      deadlineAt: task.deadlineAt,
      lifecycle: task.lifecycle,
      now: new Date(),
      waitingForHuman,
      completedWithinDeadline,
    });
    // Profile resolution owns its active wait, but cannot block completion of
    // a failed/cancelled Spec or the parent deadline before a profile exists.
    if (
      task.kind === "ISSUE_SPEC" &&
      analysis.status === "SUCCEEDED" &&
      task.profileBinding &&
      task.profileBinding.status !== "RESOLVED" &&
      !task.cancelRequestedAt &&
      !timedOut
    ) {
      return null;
    }
    const projection = projectTaskExecution({
      analysisStatus: analysis.status,
      cancelRequested: Boolean(task.cancelRequestedAt),
      caseExecutions:
        task.kind === "DIRECT_RUN" || task.kind === "LEGACY_RUN"
          ? directCases
          : issueCases,
      executionStatus: execution.status,
      targetAvailable:
        task.kind === "DIRECT_RUN" ||
        task.kind === "LEGACY_RUN" ||
        task.deployments.length > 0 ||
        typeof environment.targetUrl === "string",
      timedOut,
    });
    const now = new Date();
    const terminal = ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(
      projection.lifecycle,
    );
    const becameTerminal =
      terminal &&
      !["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(task.lifecycle);
    const completionRuns =
      task.kind === "DIRECT_RUN" || task.kind === "LEGACY_RUN"
        ? task.executionRuns
        : latestIssueExecutions.flatMap((item) => (item.run ? [item.run] : []));
    const completionCounts = {
      failed: completionRuns.filter((run) => run.verdict === "FAILED").length,
      inconclusive: completionRuns.filter(
        (run) => run.verdict === "INCONCLUSIVE" || run.verdict === null,
      ).length,
      passed: completionRuns.filter((run) => run.verdict === "PASSED").length,
      total:
        task.kind === "DIRECT_RUN" || task.kind === "LEGACY_RUN"
          ? completionRuns.length
          : issueCases.length,
    };
    const completionSpecification = task.specificationSnapshots[0] ?? null;
    const enableGithub =
      becameTerminal &&
      (await this.githubWritebackEnabled(
        task.teamId,
        completionSpecification?.primaryPullRequestUrl ?? null,
      ));
    const projectionApplied = await this.prisma.$transaction(async (tx) => {
      const applied = await tx.taskExecution.updateMany({
        data: {
          currentStage: projection.currentStage,
          executionDisposition: projection.executionDisposition,
          finishedAt: terminal ? (task.finishedAt ?? now) : null,
          lifecycle: projection.lifecycle,
          projectedAt: now,
          projectionNeededAt: null,
          startedAt:
            projection.lifecycle === "QUEUED"
              ? task.startedAt
              : (task.startedAt ?? now),
          verdict: projection.verdict,
          waitingReason: projection.waitingReason,
        },
        where: { id: task.id, updatedAt: task.updatedAt },
      });
      if (applied.count !== 1) return false;
      if (projection.lifecycle === "TIMED_OUT") {
        await tx.taskStageAttempt.updateMany({
          data: {
            finishedAt: now,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            status: "TIMED_OUT",
          },
          where: {
            stage: { taskExecutionId: task.id },
            status: { in: ["PENDING", "RUNNING"] },
          },
        });
        await tx.taskExecutionStage.updateMany({
          data: { finishedAt: now, status: "FAILED", waitingReason: null },
          where: {
            status: { in: ["PENDING", "RUNNING", "WAITING_INPUT"] },
            taskExecutionId: task.id,
          },
        });
        await tx.taskCaseExecution.updateMany({
          data: { dispatchStatus: "CANCELLED" },
          where: {
            dispatchStatus: { in: ["PENDING", "DISPATCHING", "FAILED"] },
            runId: null,
            taskExecutionId: task.id,
          },
        });
      }
      if (!["CANCELLED", "SKIPPED"].includes(execution.status)) {
        await tx.taskExecutionStage.update({
          data: {
            finishedAt: ["SUCCEEDED", "FAILED"].includes(
              projection.executionStageStatus,
            )
              ? (execution.finishedAt ?? now)
              : null,
            status: projection.executionStageStatus,
            waitingReason: projection.waitingReason,
          },
          where: { id: execution.id },
        });
      }
      if (becameTerminal) {
        await this.profileResolver.releasePendingRequests(task.id, tx);
        await tx.taskExecutionEvent.create({
          data: event(task.teamId, task.id, "CONTROL_PLANE", "task.completed", {
            executionDisposition: projection.executionDisposition,
            lifecycle: projection.lifecycle,
            verdict: projection.verdict,
          }),
        });
        await enqueuePostRunAnalysis(tx, {
          taskExecutionId: task.id,
        });
        await enqueueTaskCompletionNotifications(tx, {
          generation: task.postRunAnalysisGeneration,
          counts: completionCounts,
          enableFeishu: Boolean(
            taskNotificationContext(task.notificationContext).feishu ||
            env().FEISHU_NOTIFICATION_WEBHOOK_URL,
          ),
          enableGithub,
          executionDisposition: projection.executionDisposition,
          lifecycle: projection.lifecycle,
          notificationContext: task.notificationContext,
          primaryPullRequestUrl:
            completionSpecification?.primaryPullRequestUrl ?? null,
          resultRunId:
            completionRuns.length === 1
              ? (completionRuns[0]?.id ?? null)
              : null,
          sourceRef: task.sourceRef,
          summary: completionSpecification?.summary ?? null,
          taskExecutionId: task.id,
          teamId: task.teamId,
          title: task.title,
          verdict: projection.verdict,
        });
      }
      return true;
    });
    if (projectionApplied && projection.lifecycle === "TIMED_OUT") {
      const context = asToolContext(task);
      for (const run of task.executionRuns) {
        if (!["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(run.lifecycle)) {
          await this.runs.cancel(context, run.id).catch(() => undefined);
        }
      }
    }
    if (projectionApplied && terminal) {
      await this.reservations.releaseTask(task.id);
    }
    return projection;
  }

  private async githubWritebackEnabled(
    teamId: string,
    pullRequestUrl: string | null,
  ) {
    if (!pullRequestUrl) return false;
    const reference = parsePullRequestUrl(pullRequestUrl);
    return this.githubAccess.hasCandidateForRepository(
      teamId,
      reference.owner,
      reference.repository,
    );
  }

  private idempotentDetail(
    current: ToolAuthContext,
    existing: { id: string; inputSnapshot: Prisma.JsonValue },
    input: TaskExecutionCreateInput,
  ) {
    const normalizedExisting = taskExecutionCreateInputSchema.safeParse(
      existing.inputSnapshot,
    );
    if (
      !normalizedExisting.success ||
      !isDeepStrictEqual(normalizedExisting.data, input)
    ) {
      throw new ConflictException(
        "The idempotency key already belongs to a different task request.",
      );
    }
    return this.detail(current, existing.id);
  }

  private async createIssueTask(
    current: ToolAuthContext,
    input: Extract<TaskExecutionCreateInput, { kind: "ISSUE_SPEC" }>,
    actor: TaskRequestActor,
  ) {
    if (input.profilePolicy.strategy === "EXPLICIT_PROFILE") {
      if (actor.kind !== "USER" || !actor.userId) {
        throw new ForbiddenException(
          "Explicit browser profiles can only be selected by their signed-in owner.",
        );
      }
      const ownedProfile = await this.prisma.userBrowserProfile.findFirst({
        select: { id: true },
        where: {
          id: input.profilePolicy.profileId!,
          ownerUserId: actor.userId,
          teamId: current.team.id,
        },
      });
      if (!ownedProfile) {
        throw new ForbiddenException(
          "The explicit browser profile must belong to the requester.",
        );
      }
    }
    const taskId = randomUUID();
    const analysisStageId = randomUUID();
    const profileStageId = randomUUID();
    const executionStageId = randomUUID();
    const attemptId = randomUUID();
    const now = new Date();
    const targetUrl = input.targetUrl
      ? normalizeTargetUrl(input.targetUrl)
      : undefined;
    const deployments = normalizeTaskDeployments(input.deployments, targetUrl);
    const primaryDeployment = deployments[0];
    const target = primaryDeployment
      ? new URL(primaryDeployment.targetUrl)
      : null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.taskExecution.create({
          data: {
            deadlineAt: new Date(now.getTime() + input.deadlineSeconds * 1_000),
            environmentSnapshot: json({
              ...(target
                ? {
                    allowedHosts: [target.hostname],
                    targetSource: "MANUAL",
                    targetUrl: primaryDeployment!.targetUrl,
                  }
                : {}),
              browserPolicy: input.browserPolicy,
              hitlPolicy: input.hitlPolicy,
              model: input.model,
              retryPolicy: input.retryPolicy,
            }),
            id: taskId,
            idempotencyKey: input.idempotencyKey,
            inputSnapshot: json(input),
            kind: "ISSUE_SPEC",
            notificationContext: json(actor.notificationContext ?? {}),
            requestedByKind: actor.kind,
            requestedByUserId: actor.userId ?? null,
            sourceKind: "LINEAR_ISSUE",
            sourceRef: input.issueRef,
            teamId: current.team.id,
            title: input.issueRef,
            traceId: randomBytes(16).toString("hex"),
            deployments: {
              create: deployments.map((deployment) => ({
                environmentSnapshot: json(deployment.environment),
                key: deployment.key,
                name: deployment.name,
                targetUrl: deployment.targetUrl,
              })),
            },
          },
        });
        await tx.taskExecutionStage.createMany({
          data: [
            {
              currentAttemptNumber: 1,
              id: analysisStageId,
              maxAttempts: input.analysisMaxAttempts,
              taskExecutionId: taskId,
              type: "SPEC_ANALYSIS",
            },
            {
              id: profileStageId,
              maxAttempts: 1,
              taskExecutionId: taskId,
              type: "PROFILE_RESOLUTION",
            },
            {
              id: executionStageId,
              maxAttempts: CASE_DISPATCH_MAX_ATTEMPTS,
              taskExecutionId: taskId,
              type: "SPEC_EXECUTION",
            },
          ],
        });
        await tx.taskStageAttempt.create({
          data: {
            id: attemptId,
            inputSnapshot: json(input),
            number: 1,
            stageId: analysisStageId,
          },
        });
        await tx.taskProfileBinding.create({
          data: {
            requestedProfileId: input.profilePolicy.profileId ?? null,
            scopeKey: profilePolicyScopeKey(input.profilePolicy),
            strategy: input.profilePolicy.strategy,
            taskExecutionId: taskId,
            triggerSource:
              input.profilePolicy.strategy === "ISSUE_ASSIGNEE"
                ? "ISSUE_ASSIGNEE"
                : (actor.triggerSource ?? "CONSOLE"),
            unavailablePolicy: input.profilePolicy.onUnavailable,
          },
        });
        await tx.taskExecutionEvent.create({
          data: event(
            current.team.id,
            taskId,
            "CONTROL_PLANE",
            "task.created",
            {
              issueRef: input.issueRef,
              kind: input.kind,
            },
          ),
        });
      });
    } catch (error) {
      if (uniqueConstraint(error)) {
        const collided = await this.prisma.taskExecution.findUnique({
          where: {
            teamId_idempotencyKey: {
              idempotencyKey: input.idempotencyKey,
              teamId: current.team.id,
            },
          },
        });
        if (collided) return this.idempotentDetail(current, collided, input);
      }
      throw error;
    }
    return this.detail(current, taskId);
  }

  private async createDirectTask(
    current: ToolAuthContext,
    input: Extract<TaskExecutionCreateInput, { kind: "DIRECT_RUN" }>,
    preserveRunIdempotency = false,
    actor: TaskRequestActor = { kind: "CREDENTIAL", triggerSource: "CONSOLE" },
  ) {
    const taskId = randomUUID();
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.taskExecution.create({
          data: {
            currentStage: "SPEC_EXECUTION",
            deadlineAt: new Date(
              now.getTime() + input.run.deadlineSeconds * 1_000,
            ),
            environmentSnapshot: json(input.run.environment),
            id: taskId,
            idempotencyKey: input.idempotencyKey,
            inputSnapshot: json(input),
            kind: "DIRECT_RUN",
            lifecycle: "RUNNING",
            migrationSource: preserveRunIdempotency
              ? "RUN_COMPATIBILITY"
              : "NATIVE",
            notificationContext: json(actor.notificationContext ?? {}),
            sourceKind: input.run.source.kind,
            sourceRef: input.run.source.id ?? null,
            requestedByKind: actor.kind,
            requestedByUserId: actor.userId ?? null,
            startedAt: now,
            teamId: current.team.id,
            title: input.run.goal.slice(0, 500),
            traceId: randomBytes(16).toString("hex"),
          },
        });
        await tx.taskExecutionStage.createMany({
          data: [
            {
              currentAttemptNumber: 0,
              finishedAt: now,
              maxAttempts: 1,
              status: "SKIPPED",
              taskExecutionId: taskId,
              type: "SPEC_ANALYSIS",
            },
            {
              currentAttemptNumber: 0,
              finishedAt: now,
              maxAttempts: 1,
              status: "SKIPPED",
              taskExecutionId: taskId,
              type: "PROFILE_RESOLUTION",
            },
            {
              currentAttemptNumber: 1,
              maxAttempts: input.run.retryPolicy.maxAttempts,
              startedAt: now,
              status: "RUNNING",
              taskExecutionId: taskId,
              type: "SPEC_EXECUTION",
            },
          ],
        });
        await tx.taskExecutionEvent.create({
          data: event(
            current.team.id,
            taskId,
            "CONTROL_PLANE",
            "task.created",
            { kind: input.kind },
          ),
        });
      });
    } catch (error) {
      if (uniqueConstraint(error)) {
        const collided = await this.prisma.taskExecution.findUnique({
          where: {
            teamId_idempotencyKey: {
              idempotencyKey: input.idempotencyKey,
              teamId: current.team.id,
            },
          },
        });
        if (collided) return this.idempotentDetail(current, collided, input);
      }
      throw error;
    }
    let childCreated = false;
    try {
      const run = await this.runs.createForTask(
        current,
        preserveRunIdempotency
          ? input.run
          : directRunRequest(input.run, taskId),
        taskId,
      );
      childCreated = true;
      await this.prisma.taskExecutionEvent.create({
        data: event(
          current.team.id,
          taskId,
          "CONTROL_PLANE",
          "task.case.run_created",
          {
            direct: true,
            runId: run.id,
          },
        ),
      });
    } catch (error) {
      const failure = safeError(error);
      await this.prisma.$transaction(async (tx) => {
        await tx.taskExecutionStage.updateMany({
          data: {
            lastError: json(failure),
            status: "RUNNING",
          },
          where: { taskExecutionId: taskId, type: "SPEC_EXECUTION" },
        });
        await tx.taskExecution.update({
          data: {
            lifecycle: "QUEUED",
            projectionNeededAt: new Date(),
          },
          where: { id: taskId },
        });
        await tx.taskExecutionEvent.create({
          data: event(
            current.team.id,
            taskId,
            "CONTROL_PLANE",
            "task.case.dispatch_failed",
            { direct: true, error: failure },
          ),
        });
      });
    }
    if (childCreated) await this.projectTask(taskId);
    return this.detail(current, taskId);
  }

  private async dispatchOrphanDirectTasks(limit: number) {
    const tasks = await this.prisma.taskExecution.findMany({
      include: { team: true },
      orderBy: { createdAt: "asc" },
      take: limit,
      where: {
        cancelRequestedAt: null,
        deadlineAt: { gt: new Date() },
        executionRuns: { none: {} },
        kind: "DIRECT_RUN",
        lifecycle: { in: ["QUEUED", "RUNNING"] },
      },
    });
    let dispatched = 0;
    for (const task of tasks) {
      if (await this.dispatchDirectTask(task)) dispatched += 1;
    }
    return dispatched;
  }

  private async dispatchOrphanDirectTask(taskExecutionId: string) {
    const task = await this.prisma.taskExecution.findFirst({
      include: { team: true },
      where: {
        cancelRequestedAt: null,
        deadlineAt: { gt: new Date() },
        executionRuns: { none: {} },
        id: taskExecutionId,
        kind: "DIRECT_RUN",
        lifecycle: { in: ["QUEUED", "RUNNING"] },
      },
    });
    return task ? this.dispatchDirectTask(task) : false;
  }

  private async dispatchDirectTask(
    task: Prisma.TaskExecutionGetPayload<{ include: { team: true } }>,
  ) {
    const input = taskExecutionCreateInputSchema.parse(task.inputSnapshot);
    if (input.kind !== "DIRECT_RUN") return false;
    try {
      const run = await this.runs.createForTask(
        asToolContext(task),
        task.migrationSource === "RUN_COMPATIBILITY"
          ? input.run
          : directRunRequest(input.run, task.id),
        task.id,
      );
      await this.prisma.$transaction(async (tx) => {
        await tx.taskExecutionStage.updateMany({
          data: { lastError: Prisma.JsonNull, status: "RUNNING" },
          where: { taskExecutionId: task.id, type: "SPEC_EXECUTION" },
        });
        await tx.taskExecution.update({
          data: { lifecycle: "RUNNING", projectionNeededAt: new Date() },
          where: { id: task.id },
        });
        await tx.taskExecutionEvent.create({
          data: event(
            task.teamId,
            task.id,
            "CONTROL_PLANE",
            "task.case.run_created",
            { direct: true, recovered: true, runId: run.id },
          ),
        });
      });
      return true;
    } catch (error) {
      const failure = safeError(error);
      await this.prisma.taskExecutionStage.updateMany({
        data: { lastError: json(failure) },
        where: { taskExecutionId: task.id, type: "SPEC_EXECUTION" },
      });
      return false;
    }
  }

  private async reconcileCancelledRuns(limit: number) {
    const runs = await this.prisma.executionRun.findMany({
      include: { taskExecution: { include: { team: true } } },
      take: limit,
      where: {
        lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
        OR: [
          { taskExecution: { cancelRequestedAt: { not: null } } },
          { taskExecution: { lifecycle: "TIMED_OUT" } },
        ],
      },
    });
    let cancelled = 0;
    for (const run of runs) {
      if (!run.taskExecution) continue;
      try {
        await this.runs.cancel(asToolContext(run.taskExecution), run.id);
        cancelled += 1;
      } catch {
        // A later reconciliation pass retries cancellation.
      }
    }
    return cancelled;
  }

  private async claimAnalysisAttempt() {
    for (let collision = 0; collision < 5; collision += 1) {
      const claimed = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const candidate = await tx.taskStageAttempt.findFirst({
          orderBy: { createdAt: "asc" },
          where: {
            stage: {
              status: { in: ["PENDING", "RUNNING"] },
              taskExecution: {
                cancelRequestedAt: null,
                deadlineAt: { gt: now },
                lifecycle: { in: ["QUEUED", "RUNNING"] },
              },
              type: "SPEC_ANALYSIS",
            },
            OR: [
              { status: "PENDING" },
              { leaseExpiresAt: { lt: now }, status: "RUNNING" },
            ],
          },
        });
        if (!candidate) return null;
        const leaseToken = randomUUID();
        const leaseExpiresAt = new Date(
          now.getTime() + env().AGENT_RUNTIME_TASK_LEASE_SECONDS * 1_000,
        );
        const acquired = await tx.taskStageAttempt.updateMany({
          data: {
            fencingToken: { increment: 1 },
            leaseExpiresAt,
            leaseOwner: ANALYSIS_WORKER,
            leaseToken,
            startedAt: candidate.startedAt ?? now,
            status: "RUNNING",
          },
          where: {
            id: candidate.id,
            OR: [
              { status: "PENDING" },
              { leaseExpiresAt: { lt: now }, status: "RUNNING" },
            ],
          },
        });
        if (acquired.count !== 1) return undefined;
        const attempt = await tx.taskStageAttempt.findUniqueOrThrow({
          include: {
            stage: { include: { taskExecution: { include: { team: true } } } },
          },
          where: { id: candidate.id },
        });
        await tx.taskExecutionStage.update({
          data: {
            startedAt: attempt.stage.startedAt ?? now,
            status: "RUNNING",
          },
          where: { id: attempt.stageId },
        });
        await tx.taskExecution.update({
          data: {
            lifecycle: "RUNNING",
            startedAt: attempt.stage.taskExecution.startedAt ?? now,
          },
          where: { id: attempt.stage.taskExecutionId },
        });
        await tx.taskExecutionEvent.create({
          data: event(
            attempt.stage.taskExecution.teamId,
            attempt.stage.taskExecutionId,
            "WORKER",
            "task.stage.started",
            { attemptNumber: attempt.number, stage: "SPEC_ANALYSIS" },
          ),
        });
        return attempt;
      });
      if (claimed === undefined) continue;
      return claimed;
    }
    return null;
  }

  private async executeAnalysis(attemptId: string, leaseToken: string) {
    const attempt = await this.prisma.taskStageAttempt.findUniqueOrThrow({
      include: {
        stage: { include: { taskExecution: { include: { team: true } } } },
      },
      where: { id: attemptId },
    });
    requireAnalysisLease(attempt, leaseToken);
    const input = taskExecutionCreateInputSchema.parse(
      attempt.stage.taskExecution.inputSnapshot,
    );
    if (input.kind !== "ISSUE_SPEC") {
      throw new ConflictException("Only Issue tasks have an analysis stage.");
    }
    const resolved = await this.resolver.resolve(
      input.issueRef,
      attempt.stage.taskExecution.teamId,
    );
    const context = resolved.context;
    const generated = generateBusinessTestSpec(context);
    const cases = generated.cases.map((item) =>
      generatedTestCaseDefinitionSchema.parse(item),
    );
    const sourceHash = testGenerationContextHash(context);
    const primaryPullRequest = selectPrimaryPullRequest(context);
    const targetUrl =
      input.deployments[0]?.targetUrl ??
      input.targetUrl ??
      primaryPullRequest?.deploymentUrl ??
      null;
    const normalizedTarget = targetUrl ? normalizeTargetUrl(targetUrl) : null;
    const target = normalizedTarget ? new URL(normalizedTarget) : null;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.taskStageAttempt.findUniqueOrThrow({
        include: { stage: { include: { taskExecution: true } } },
        where: { id: attemptId },
      });
      requireAnalysisLease(locked, leaseToken);
      if (
        locked.stage.taskExecution.cancelRequestedAt ||
        locked.stage.taskExecution.deadlineAt <= now ||
        ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(
          locked.stage.taskExecution.lifecycle,
        )
      ) {
        throw new ConflictException("The task is no longer active.");
      }
      const snapshot = await tx.taskSpecificationSnapshot.create({
        data: {
          completeness: resolved.completeness,
          context: json(context),
          diagnostics: json(resolved.diagnostics),
          generatorKind: SPECIFICATION_GENERATOR.kind,
          generatorVersion: SPECIFICATION_GENERATOR.version,
          primaryPullRequestUrl: primaryPullRequest?.url ?? null,
          sourceHash,
          stageAttemptId: attemptId,
          summary: generated.summary,
          taskExecutionId: locked.stage.taskExecutionId,
          cases: {
            create: cases.map((definition, position) => ({
              definition: json(definition),
              definitionHash: specificationDefinitionHash(definition),
              name: definition.name,
              position,
            })),
          },
        },
        include: { cases: true },
      });
      let deployments = await tx.taskDeployment.findMany({
        where: {
          enabled: true,
          taskExecutionId: locked.stage.taskExecutionId,
        },
      });
      if (!deployments.length && normalizedTarget) {
        deployments = [
          await tx.taskDeployment.create({
            data: {
              environmentSnapshot: json({}),
              key: "default",
              name: "Default",
              targetUrl: normalizedTarget,
              taskExecutionId: locked.stage.taskExecutionId,
            },
          }),
        ];
      }
      await tx.taskCaseExecution.createMany({
        data: caseExecutionMatrix(
          locked.stage.taskExecutionId,
          snapshot.cases,
          deployments,
          locked.stage.taskExecution.inputSnapshot,
        ),
      });
      await tx.taskStageAttempt.update({
        data: {
          finishedAt: now,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          result: json({
            caseCount: cases.length,
            completeness: resolved.completeness,
            snapshotId: snapshot.id,
            sourceHash,
          }),
          status: "SUCCEEDED",
        },
        where: { id: attemptId },
      });
      await tx.taskExecutionStage.update({
        data: {
          finishedAt: now,
          lastError: Prisma.JsonNull,
          status: "SUCCEEDED",
        },
        where: { id: locked.stageId },
      });
      await tx.taskExecutionStage.updateMany({
        data: { startedAt: now, status: "PENDING", waitingReason: null },
        where: {
          taskExecutionId: locked.stage.taskExecutionId,
          type: "PROFILE_RESOLUTION",
        },
      });
      const previousEnvironment = record(
        locked.stage.taskExecution.environmentSnapshot,
      );
      await tx.taskExecution.update({
        data: {
          currentStage: "PROFILE_RESOLUTION",
          environmentSnapshot: json({
            ...previousEnvironment,
            ...(target
              ? {
                  allowedHosts: [target.hostname],
                  targetSource:
                    input.deployments.length || input.targetUrl
                      ? "MANUAL"
                      : "GITHUB",
                  targetUrl: normalizedTarget,
                }
              : {}),
            specificationSnapshotId: snapshot.id,
          }),
          lifecycle: "RUNNING",
          projectionNeededAt: null,
          sourceRef: context.issue.identifier,
          title: `${context.issue.identifier} · ${context.issue.title}`,
          waitingReason: null,
        },
        where: { id: locked.stage.taskExecutionId },
      });
      await tx.taskExecutionEvent.create({
        data: event(
          locked.stage.taskExecution.teamId,
          locked.stage.taskExecutionId,
          "WORKER",
          "task.stage.succeeded",
          {
            attemptNumber: locked.number,
            caseCount: cases.length,
            snapshotId: snapshot.id,
            stage: "SPEC_ANALYSIS",
          },
        ),
      });
      await tx.taskExecutionEvent.create({
        data: event(
          locked.stage.taskExecution.teamId,
          locked.stage.taskExecutionId,
          "CONTROL_PLANE",
          "task.stage.started",
          { stage: "PROFILE_RESOLUTION" },
        ),
      });
    });
    const profile = await this.profileResolver.resolve(
      attempt.stage.taskExecutionId,
    );
    if (normalizedTarget && profile?.status === "RESOLVED") {
      await this.dispatchPendingForTask(attempt.stage.taskExecutionId);
    }
  }

  private async failAnalysis(
    attemptId: string,
    leaseToken: string,
    error: unknown,
  ) {
    const failure = safeError(error);
    await this.prisma.$transaction(async (tx) => {
      const attempt = await tx.taskStageAttempt.findUnique({
        include: { stage: { include: { taskExecution: true } } },
        where: { id: attemptId },
      });
      if (!attempt || attempt.leaseToken !== leaseToken) return;
      const now = new Date();
      if (attempt.stage.taskExecution.cancelRequestedAt) {
        await tx.taskStageAttempt.update({
          data: {
            finishedAt: now,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            status: "CANCELLED",
          },
          where: { id: attemptId },
        });
        return;
      }
      const timedOut = attempt.stage.taskExecution.deadlineAt <= now;
      const terminal = ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(
        attempt.stage.taskExecution.lifecycle,
      );
      if (timedOut || terminal) {
        await tx.taskStageAttempt.update({
          data: {
            error: json(failure),
            finishedAt: now,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            status: timedOut ? "TIMED_OUT" : "CANCELLED",
          },
          where: { id: attemptId },
        });
        if (timedOut) {
          await tx.taskExecutionStage.updateMany({
            data: {
              finishedAt: now,
              lastError: json(failure),
              status: "FAILED",
            },
            where: {
              status: { in: ["PENDING", "RUNNING", "WAITING_INPUT"] },
              taskExecutionId: attempt.stage.taskExecutionId,
            },
          });
          const expired = await tx.taskExecution.updateMany({
            data: {
              executionDisposition: null,
              finishedAt: now,
              lifecycle: "TIMED_OUT",
              projectionNeededAt: null,
              verdict: null,
              waitingReason: null,
            },
            where: {
              id: attempt.stage.taskExecutionId,
              lifecycle: {
                notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"],
              },
            },
          });
          if (expired.count) {
            await this.profileResolver.releasePendingRequests(
              attempt.stage.taskExecutionId,
              tx,
            );
            await tx.taskExecutionEvent.create({
              data: event(
                attempt.stage.taskExecution.teamId,
                attempt.stage.taskExecutionId,
                "WORKER",
                "task.timed_out",
                { stage: "SPEC_ANALYSIS" },
              ),
            });
            await enqueuePostRunAnalysis(tx, {
              taskExecutionId: attempt.stage.taskExecutionId,
            });
          }
        }
        return;
      }
      const retry = attempt.number < attempt.stage.maxAttempts;
      await tx.taskStageAttempt.update({
        data: {
          error: json(failure),
          finishedAt: now,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          status: "FAILED",
        },
        where: { id: attemptId },
      });
      if (retry) {
        const nextNumber = attempt.number + 1;
        await tx.taskStageAttempt.create({
          data: {
            inputSnapshot: attempt.inputSnapshot as Prisma.InputJsonValue,
            number: nextNumber,
            stageId: attempt.stageId,
          },
        });
        await tx.taskExecutionStage.update({
          data: {
            currentAttemptNumber: nextNumber,
            lastError: json(failure),
            status: "PENDING",
          },
          where: { id: attempt.stageId },
        });
        await tx.taskExecution.update({
          data: { lifecycle: "QUEUED", projectionNeededAt: now },
          where: { id: attempt.stage.taskExecutionId },
        });
        await tx.taskExecutionEvent.create({
          data: event(
            attempt.stage.taskExecution.teamId,
            attempt.stage.taskExecutionId,
            "WORKER",
            "task.stage.retry_queued",
            {
              attemptNumber: nextNumber,
              error: failure,
              stage: "SPEC_ANALYSIS",
            },
          ),
        });
      } else {
        await tx.taskExecutionStage.update({
          data: {
            finishedAt: now,
            lastError: json(failure),
            status: "FAILED",
          },
          where: { id: attempt.stageId },
        });
        await tx.taskExecutionStage.updateMany({
          data: { finishedAt: now, status: "CANCELLED" },
          where: {
            taskExecutionId: attempt.stage.taskExecutionId,
            type: { in: ["PROFILE_RESOLUTION", "SPEC_EXECUTION"] },
          },
        });
        await tx.taskExecution.update({
          data: {
            executionDisposition: "NOT_RUN",
            finishedAt: now,
            lifecycle: "COMPLETED",
            projectionNeededAt: null,
          },
          where: { id: attempt.stage.taskExecutionId },
        });
        await tx.taskExecutionEvent.create({
          data: event(
            attempt.stage.taskExecution.teamId,
            attempt.stage.taskExecutionId,
            "WORKER",
            "task.stage.failed",
            {
              attemptNumber: attempt.number,
              error: failure,
              stage: "SPEC_ANALYSIS",
            },
          ),
        });
        await enqueuePostRunAnalysis(tx, {
          taskExecutionId: attempt.stage.taskExecutionId,
        });
      }
    });
  }

  private async dispatchPending(limit: number, taskExecutionId?: string) {
    const dispatchDeadline = new Date(Date.now() + MINIMUM_CHILD_RUN_WINDOW_MS);
    const where: Prisma.TaskCaseExecutionWhereInput = {
      dispatchAttempts: { lt: CASE_DISPATCH_MAX_ATTEMPTS },
      runId: null,
      ...(taskExecutionId ? { taskExecutionId } : {}),
      taskExecution: {
        cancelRequestedAt: null,
        deadlineAt: { gt: dispatchDeadline },
        lifecycle: { in: ["RUNNING", "QUEUED"] },
      },
      OR: [
        { dispatchStatus: "PENDING" },
        {
          dispatchRequestedAt: {
            lt: new Date(Date.now() - DISPATCH_RETRY_DELAY_MS),
          },
          dispatchStatus: { in: ["DISPATCHING", "FAILED"] },
        },
      ],
    };
    // Select one lightweight row per Issue before loading any full execution
    // candidate. This prevents a large or profile-blocked Issue from occupying a
    // global candidate window and starving every newer Issue.
    const issueRows = await this.prisma.taskCaseExecution.findMany({
      distinct: ["taskExecutionId"],
      orderBy: [{ createdAt: "asc" }, { taskExecutionId: "asc" }],
      select: { createdAt: true, taskExecutionId: true },
      where,
    });
    const issueQueue = issueRows.map((row) => row.taskExecutionId);
    const inspected = new Set<string>();
    let dispatched = 0;
    while (issueQueue.length && dispatched < limit) {
      const currentTaskExecutionId = issueQueue.shift()!;
      const candidate = await this.prisma.taskCaseExecution.findFirst({
        include: dispatchCandidateInclude,
        orderBy: [
          { executionOrdinal: "asc" },
          { dispatchOrder: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
          { id: "asc" },
        ],
        where: {
          AND: [
            where,
            {
              taskExecutionId: currentTaskExecutionId,
              id: { notIn: [...inspected] },
            },
          ],
        },
      });
      if (!candidate || inspected.has(candidate.id)) continue;
      inspected.add(candidate.id);
      issueQueue.push(currentTaskExecutionId);
      const policy = executionConcurrencyPolicySchema.safeParse(
        candidate.executionPolicy,
      );
      if (
        record(candidate.taskExecution.inputSnapshot)
          .casePolicyReviewRequired === true &&
        (!policy.success ||
          !["CONSOLE_REVIEWED", "REQUEST_REVIEWED"].includes(
            policy.data.provenance ?? "",
          ))
      ) {
        await this.recordScheduling(
          candidate,
          "WAITING",
          "POLICY_REVIEW",
          null,
        );
        continue;
      }
      const dependencies = policy.success
        ? (policy.data.dependsOnCaseIds ?? [])
        : [];
      if (dependencies.length) {
        const rows = latestCaseExecutions(
          await this.prisma.taskCaseExecution.findMany({
            include: { run: true },
            where: {
              taskExecutionId: candidate.taskExecutionId,
              deploymentId: candidate.deploymentId,
              executionOrdinal: candidate.executionOrdinal,
              testCase: { snapshotId: candidate.testCase.snapshotId },
              caseId: { in: dependencies },
            },
          }),
        );
        const missing = dependencies.find(
          (id) => !rows.some((row) => row.caseId === id),
        );
        const failed = rows.find(
          (row) =>
            caseExecutionPhase(row) === "terminal" &&
            (row.run?.verdict !== "PASSED" ||
              row.run.executionDisposition !== "EXECUTED"),
        );
        const pending = rows.find(
          (row) => caseExecutionPhase(row) !== "terminal",
        );
        if (missing || failed) {
          await this.recordScheduling(
            candidate,
            "TERMINAL",
            missing ? "CASE_DEPENDENCY_INVALID" : "CASE_DEPENDENCY_FAILED",
            failed
              ? {
                  resourceType: "CASE",
                  caseExecutionId: failed.id,
                  ...(failed.runId ? { runId: failed.runId } : {}),
                  taskId: candidate.taskExecutionId,
                }
              : {
                  resourceType: "CASE",
                  ...(missing ? { resourceId: missing } : {}),
                },
          );
          continue;
        }
        if (pending) {
          await this.recordScheduling(candidate, "WAITING", "CASE_DEPENDENCY", {
            resourceType: "CASE",
            caseExecutionId: pending.id,
            ...(pending.runId ? { runId: pending.runId } : {}),
            taskId: candidate.taskExecutionId,
          });
          continue;
        }
      }
      const reservation = await this.reservations.acquire(
        candidate.taskExecutionId,
        candidate.deploymentId,
      );
      if (!reservation.acquired) {
        await this.recordScheduling(
          candidate,
          "WAITING",
          reservation.reason,
          reservation.blockedBy,
          reservation.queue,
        );
        continue;
      }
      if (
        reservation.profile &&
        reservation.profile.executionMode !== "ISOLATED_AUTH"
      ) {
        const activeRun = await this.prisma.executionRun.findFirst({
          select: {
            id: true,
            taskExecutionId: true,
            browserExecutions: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { error: true },
            },
          },
          where: {
            browserProfileId: reservation.profile.id,
            teamId: candidate.taskExecution.teamId,
            lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
          },
        });
        if (activeRun) {
          const rootBlocker = profileRootBlocker(
            activeRun.browserExecutions?.[0]?.error,
          );
          await this.recordScheduling(
            candidate,
            "WAITING",
            "PROFILE_SESSION_BUSY",
            {
              resourceType: "PROFILE",
              resourceId: reservation.profile.id,
              runId: activeRun.id,
              ...rootBlocker,
              ...(activeRun.taskExecutionId
                ? { taskId: activeRun.taskExecutionId }
                : {}),
            },
          );
          continue;
        }
      }
      const claimed = await this.prisma.taskCaseExecution.updateMany({
        data: {
          dispatchAttempts: { increment: 1 },
          dispatchLastError: Prisma.JsonNull,
          dispatchRequestedAt: new Date(),
          dispatchStatus: "DISPATCHING",
          scheduling: json(
            newSchedulingDecision(candidate, "READY", null, null),
          ),
        },
        where: {
          id: candidate.id,
          runId: null,
          dispatchAttempts: candidate.dispatchAttempts,
          dispatchStatus: candidate.dispatchStatus,
          updatedAt: candidate.updatedAt,
        },
      });
      if (claimed.count !== 1) {
        continue;
      }
      try {
        const context = asToolContext(candidate.taskExecution);
        const request = taskCaseRunRequest(
          candidate,
          candidate.deployment.targetUrl,
          reservation.profile?.runtimeProfileKey ?? null,
        );
        const run = await this.runs.createForTask(
          context,
          request,
          candidate.taskExecutionId,
          reservation.profile?.id ?? null,
        );
        const linked = await this.prisma.$transaction(async (tx) => {
          const linkage = await tx.taskCaseExecution.updateMany({
            data: {
              dispatchLastError: Prisma.JsonNull,
              dispatchStatus: "LINKED",
              runId: run.id,
            },
            where: {
              dispatchStatus: "DISPATCHING",
              id: candidate.id,
              runId: null,
            },
          });
          if (linkage.count !== 1) return false;
          await tx.taskExecution.update({
            data: { projectionNeededAt: new Date() },
            where: { id: candidate.taskExecutionId },
          });
          await tx.taskExecutionEvent.create({
            data: event(
              candidate.taskExecution.teamId,
              candidate.taskExecutionId,
              "CONTROL_PLANE",
              "task.case.run_created",
              {
                caseId: candidate.caseId,
                deploymentId: candidate.deploymentId,
                deploymentKey: candidate.deployment.key,
                runId: run.id,
              },
            ),
          });
          return true;
        });
        if (!linked) {
          await this.runs.cancel(context, run.id).catch(() => undefined);
          continue;
        }
        if (reservation.profile) {
          await this.reservations.recordUsage({
            executionRunId: run.id,
            hostname: new URL(candidate.deployment.targetUrl).hostname,
            profileId: reservation.profile.id,
            requesterUserId: candidate.taskExecution.requestedByUserId,
            taskExecutionId: candidate.taskExecutionId,
            teamId: candidate.taskExecution.teamId,
            triggerSource:
              candidate.taskExecution.profileBinding?.triggerSource ??
              "CONSOLE",
          });
        }
        dispatched += 1;
      } catch (error) {
        const failure = safeError(error);
        await this.prisma.$transaction(async (tx) => {
          const failed = await tx.taskCaseExecution.updateMany({
            data: {
              dispatchLastError: json(failure),
              dispatchStatus: "FAILED",
              scheduling: json({
                ...newSchedulingDecision(
                  candidate,
                  candidate.dispatchAttempts + 1 >= CASE_DISPATCH_MAX_ATTEMPTS
                    ? "TERMINAL"
                    : "WAITING",
                  candidate.dispatchAttempts + 1 >= CASE_DISPATCH_MAX_ATTEMPTS
                    ? "DISPATCH_EXHAUSTED"
                    : "RETRY_BACKOFF",
                  null,
                ),
                nextRetryAt:
                  candidate.dispatchAttempts + 1 >= CASE_DISPATCH_MAX_ATTEMPTS
                    ? null
                    : new Date(
                        Date.now() + DISPATCH_RETRY_DELAY_MS,
                      ).toISOString(),
              }),
            },
            where: { dispatchStatus: "DISPATCHING", id: candidate.id },
          });
          if (failed.count !== 1) return;
          await tx.taskExecution.update({
            data: { projectionNeededAt: new Date() },
            where: { id: candidate.taskExecutionId },
          });
          await tx.taskExecutionEvent.create({
            data: event(
              candidate.taskExecution.teamId,
              candidate.taskExecutionId,
              "CONTROL_PLANE",
              "task.case.dispatch_failed",
              { caseId: candidate.caseId, error: failure },
            ),
          });
        });
      }
    }
    return dispatched;
  }

  private async recordScheduling(
    candidate: {
      id: string;
      taskExecutionId: string;
      scheduling?: unknown;
      createdAt: Date;
      updatedAt: Date;
      dispatchStatus: string;
    },
    state: CaseSchedulingDecision["state"],
    reason: string | null,
    blockedBy: CaseSchedulingDecision["blockedBy"],
    queue: CaseSchedulingDecision["queue"] = null,
  ) {
    const previous = readCaseScheduling(candidate.scheduling);
    if (
      previous?.state === state &&
      previous.reason === reason &&
      isDeepStrictEqual(previous.blockedBy, blockedBy) &&
      previous.queue?.scope === queue?.scope &&
      previous.queue?.position === queue?.position
    )
      return;
    const scheduling = {
      ...newSchedulingDecision(candidate, state, reason, blockedBy),
      queue,
    };
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.taskCaseExecution.updateMany({
        data: {
          scheduling: json(scheduling),
          ...(state === "TERMINAL"
            ? {
                dispatchStatus: "FAILED",
                dispatchAttempts: CASE_DISPATCH_MAX_ATTEMPTS,
                dispatchLastError: json({
                  code: reason,
                  message: "A required Case could not complete successfully.",
                }),
              }
            : {}),
        },
        where: {
          id: candidate.id,
          runId: null,
          updatedAt: candidate.updatedAt,
        },
      });
      if (changed.count !== 1) return;
      await tx.taskExecution.update({
        data: { projectionNeededAt: new Date() },
        where: { id: candidate.taskExecutionId },
      });
    });
  }

  private async expireExhaustedDispatches(limit: number) {
    const cutoff = new Date(Date.now() - DISPATCH_RETRY_DELAY_MS);
    const candidates = await this.prisma.taskCaseExecution.findMany({
      orderBy: { dispatchRequestedAt: "asc" },
      select: { id: true, taskExecutionId: true },
      take: limit,
      where: {
        dispatchAttempts: { gte: CASE_DISPATCH_MAX_ATTEMPTS },
        dispatchRequestedAt: { lt: cutoff },
        dispatchStatus: "DISPATCHING",
        runId: null,
      },
    });
    if (!candidates.length) return 0;
    const now = new Date();
    const ids = candidates.map((candidate) => candidate.id);
    const taskIds = Array.from(
      new Set(candidates.map((candidate) => candidate.taskExecutionId)),
    );
    const expired = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.taskCaseExecution.updateMany({
        data: {
          dispatchLastError: json({
            at: now.toISOString(),
            code: "RUN_DISPATCH_EXHAUSTED",
            message: "Case dispatch did not link a Run before retries expired.",
          }),
          dispatchStatus: "FAILED",
        },
        where: {
          dispatchAttempts: { gte: CASE_DISPATCH_MAX_ATTEMPTS },
          dispatchRequestedAt: { lt: cutoff },
          dispatchStatus: "DISPATCHING",
          id: { in: ids },
          runId: null,
        },
      });
      if (updated.count) {
        await tx.taskExecution.updateMany({
          data: { projectionNeededAt: now },
          where: { id: { in: taskIds } },
        });
      }
      return updated.count;
    });
    return expired;
  }

  private async dispatchPendingForTask(taskExecutionId: string) {
    for (let index = 0; index < 100; index += 1) {
      const before = await this.prisma.taskCaseExecution.count({
        where: {
          dispatchStatus: "PENDING",
          runId: null,
          taskExecutionId,
        },
      });
      if (!before) break;
      const dispatched = await this.dispatchPending(
        Math.min(before, 100),
        taskExecutionId,
      );
      if (!dispatched) break;
    }
  }

  private async projectPending(limit: number) {
    const tasks = await this.prisma.taskExecution.findMany({
      orderBy: { updatedAt: "asc" },
      select: { id: true },
      take: limit,
      where: {
        OR: [
          { lifecycle: { in: ["QUEUED", "RUNNING", "WAITING_HUMAN"] } },
          { projectionNeededAt: { not: null } },
        ],
      },
    });
    for (const task of tasks) await this.projectTask(task.id);
    return tasks.length;
  }

  private requireTask(teamId: string, id: string) {
    return this.prisma.taskExecution.findFirstOrThrow({
      select: { id: true },
      where: { id, teamId },
    });
  }
}

function taskCaseRunRequest(
  item: Prisma.TaskCaseExecutionGetPayload<{
    include: {
      deployment: true;
      taskExecution: {
        include: {
          analysisSources: true;
          profileBinding: true;
          team: true;
        };
      };
      testCase: { include: { snapshot: true } };
    };
  }>,
  targetUrl: string,
  runtimeProfileKey: string | null,
): ExecutionRunCreateInput {
  const agentDefinition = runtimeGeneratedSpecCaseSchema.safeParse(
    item.testCase.definition,
  );
  const legacyDefinition = agentDefinition.success
    ? null
    : generatedTestCaseDefinitionSchema.parse(item.testCase.definition);
  const context = testGenerationContextSchema.parse(
    item.testCase.snapshot.context,
  );
  const input = taskExecutionCreateInputSchema.parse(
    item.taskExecution.inputSnapshot,
  );
  if (input.kind !== "ISSUE_SPEC") {
    throw new ConflictException(
      "Generated Cases must belong to an Issue task.",
    );
  }
  const target = new URL(targetUrl);
  const agentBusinessReferences = agentDefinition.success
    ? taskAnalysisBusinessReferences(
        item.taskExecutionId,
        Array.from(
          new Set([
            ...agentDefinition.data.sourceRefs,
            ...agentDefinition.data.criteria.flatMap(
              (criterion) => criterion.sourceRefs,
            ),
          ]),
        ),
        item.taskExecution.analysisSources,
      )
    : null;
  const runtimeReferenceByAnalysisSource = new Map(
    (agentBusinessReferences ?? []).flatMap((reference) => {
      const sourceRef = reference.metadata?.analysisSourceRef;
      return typeof sourceRef === "string"
        ? [[sourceRef, reference.externalId] as const]
        : [];
    }),
  );
  return {
    concurrencyPolicy: executionConcurrencyPolicySchema.safeParse(
      item.executionPolicy,
    ).success
      ? executionConcurrencyPolicySchema.parse(item.executionPolicy)
      : { accessMode: "UNKNOWN" },
    browserPolicy: runtimeProfileKey
      ? {
          ...input.browserPolicy,
          profile: { key: runtimeProfileKey, mode: "PERSISTENT" },
        }
      : input.browserPolicy,
    businessReferences: agentDefinition.success
      ? agentBusinessReferences!
      : taskBusinessReferences(
          item.taskExecutionId,
          item.testCase.snapshot.id,
          context,
        ),
    criteria: agentDefinition.success
      ? agentDefinition.data.criteria.map((criterion) => ({
          description: [
            criterion.description,
            `Spec 来源：${criterion.sourceRefs
              .map((sourceRef) =>
                runtimeReferenceByAnalysisSource.get(sourceRef),
              )
              .filter((sourceRef): sourceRef is string => Boolean(sourceRef))
              .join(", ")}`,
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 4_000),
          id: criterion.id,
          required: criterion.required,
          requiredEvidenceKinds: criterion.requiredEvidenceKinds,
        }))
      : legacyDefinition!.expected.map((expected, index) => ({
          description: expected,
          id: `expected-${index + 1}`,
          required: true,
          requiredEvidenceKinds: Array.from(
            new Set(
              legacyDefinition!.evidence.map((evidence) => evidence.kind),
            ),
          ),
        })),
    deadlineSeconds: Math.max(
      30,
      Math.min(
        900,
        Math.floor(
          (item.taskExecution.deadlineAt.getTime() - Date.now()) / 1_000,
        ),
      ),
    ),
    deadlinePolicy: input.runDeadlinePolicy,
    environment: {
      ...record(item.deployment.environmentSnapshot),
      allowedHosts: [target.hostname],
      authRole: agentDefinition.success
        ? agentDefinition.data.authRole
        : legacyDefinition!.authRole,
      caseId: item.caseId,
      deploymentId: item.deploymentId,
      deploymentKey: item.deployment.key,
      deploymentName: item.deployment.name,
      specificationSnapshotId: item.testCase.snapshot.id,
      targetUrl,
      taskExecutionId: item.taskExecutionId,
    },
    goal: [
      `${context.issue.identifier} · ${context.issue.title}`,
      agentDefinition.success
        ? agentDefinition.data.name
        : legacyDefinition!.name,
      "前置条件：",
      ...(agentDefinition.success
        ? agentDefinition.data.preconditions
        : legacyDefinition!.preconditions
      ).map((value) => `- ${value}`),
      ...(agentDefinition.success && agentDefinition.data.testData.length
        ? [
            "测试数据：",
            ...agentDefinition.data.testData.map((value) => `- ${value}`),
          ]
        : []),
      "操作步骤：",
      ...(agentDefinition.success
        ? agentDefinition.data.steps.map(
            (step) =>
              `${step.order}. ${step.action}\n   预期现象：${step.expectedObservation}`,
          )
        : legacyDefinition!.steps.map(
            (step) => `${step.order}. ${step.action}`,
          )),
      "验收标准：",
      ...(agentDefinition.success
        ? agentDefinition.data.criteria.map(
            (criterion) => `- ${criterion.description}`,
          )
        : legacyDefinition!.expected.map((value) => `- ${value}`)),
      ...(agentDefinition.success && agentDefinition.data.cleanup.length
        ? [
            "清理步骤：",
            ...agentDefinition.data.cleanup.map((value) => `- ${value}`),
          ]
        : []),
    ].join("\n"),
    hitlPolicy: input.hitlPolicy,
    idempotencyKey: `task:${item.taskExecutionId}:snapshot:${item.testCase.snapshot.id}:case:${item.caseId}:deployment:${item.deploymentId}:execution:${item.executionOrdinal}`,
    ...(input.model ? { model: input.model } : {}),
    retryPolicy: input.retryPolicy,
    source: { id: item.id, kind: "TASK_CASE" },
  };
}

function newSchedulingDecision(
  candidate: { scheduling?: unknown; createdAt?: Date },
  state: CaseSchedulingDecision["state"],
  reason: string | null,
  blockedBy: CaseSchedulingDecision["blockedBy"],
): CaseSchedulingDecision {
  const previous = readCaseScheduling(candidate.scheduling);
  const now = new Date().toISOString();
  return {
    state,
    reason,
    blockedBy,
    waitingSince:
      state === "WAITING" ||
      state === "RECOVERING" ||
      state === "READY" ||
      state === "ADMITTED"
        ? (previous?.waitingSince ?? candidate.createdAt?.toISOString() ?? now)
        : null,
    evaluatedAt: now,
    queue: null,
    nextRetryAt: null,
  };
}

export function caseExecutionMatrix(
  taskId: string,
  cases: readonly { id: string; position?: number }[],
  deployments: readonly { id: string }[],
  inputSnapshot: Prisma.JsonValue,
) {
  const policies = record(inputSnapshot).caseExecutionPolicies;
  const configured =
    policies && typeof policies === "object" && !Array.isArray(policies)
      ? (policies as Record<string, unknown>)
      : {};
  const casePolicies = cases.map((testCase, index) => {
    const policy =
      configured[testCase.id] ??
      configured[String((testCase.position ?? index) + 1)];
    return {
      caseId: testCase.id,
      executionPolicy:
        policy === undefined
          ? { accessMode: "UNKNOWN" as const }
          : {
              ...executionConcurrencyPolicySchema.parse(policy),
              provenance: "REQUEST_REVIEWED",
              version: 1,
            },
    };
  });
  validateCaseDependencyGraph(casePolicies);
  return taskDeploymentMatrix(taskId, cases, deployments).map((row) => ({
    ...row,
    dispatchOrder:
      cases.find((testCase) => testCase.id === row.caseId)?.position ??
      cases.findIndex((testCase) => testCase.id === row.caseId),
    executionPolicy: json(
      casePolicies.find((policy) => policy.caseId === row.caseId)!
        .executionPolicy,
    ),
  }));
}

export function validateCaseDependencyGraph(
  rows: readonly { caseId: string; executionPolicy?: unknown }[],
) {
  const graph = new Map(
    rows.map((row) => {
      const policy = executionConcurrencyPolicySchema.safeParse(
        row.executionPolicy,
      );
      return [
        row.caseId,
        policy.success ? (policy.data.dependsOnCaseIds ?? []) : [],
      ];
    }),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id))
      throw new BadRequestException(
        "Case dependencies must not contain a cycle.",
      );
    if (visited.has(id)) return;
    if (!graph.has(id))
      throw new BadRequestException(
        "Case dependencies must belong to this Task and deployment.",
      );
    visiting.add(id);
    for (const dependency of graph.get(id)!) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

function taskAnalysisBusinessReferences(
  taskId: string,
  requestedSourceRefs: string[],
  sources: Array<{
    content: Prisma.JsonValue;
    externalId: string;
    id: string;
    kind: string;
    label: string;
    locator: Prisma.JsonValue;
    revision: string | null;
    uri: string;
  }>,
): ExecutionRunCreateInput["businessReferences"] {
  const requested = new Set(requestedSourceRefs);
  return sources
    .filter((source) => requested.has(source.externalId))
    .slice(0, 100)
    .map((source) => ({
      externalId: `reference://task/${taskId}/analysis/${source.id}`,
      kind: "BUSINESS_REFERENCE" as const,
      label: source.label,
      metadata: {
        analysisSourceRef: source.externalId,
        excerpt: referenceExcerpt(JSON.stringify(source.content)),
        kind: source.kind,
        locator: source.locator,
        revision: source.revision,
        url: safeReferenceUrl(source.uri),
      },
    }));
}

function directRunRequest(
  run: ExecutionRunCreateInput,
  taskId: string,
): ExecutionRunCreateInput {
  return { ...run, idempotencyKey: `task:${taskId}:direct` };
}

function taskBusinessReferences(
  taskId: string,
  snapshotId: string,
  context: ReturnType<typeof testGenerationContextSchema.parse>,
): ExecutionRunCreateInput["businessReferences"] {
  const prefix = `reference://task/${taskId}/spec/${snapshotId}`;
  const references: ExecutionRunCreateInput["businessReferences"] = [
    {
      externalId: `${prefix}/issue`,
      kind: "BUSINESS_REFERENCE",
      label: `${context.issue.identifier} · ${context.issue.title}`,
      metadata: {
        excerpt: referenceExcerpt(context.issue.description),
        source: "LINEAR",
        state: context.issue.state,
        title: context.issue.title,
        url: safeReferenceUrl(context.issue.url),
      },
    },
  ];
  context.pullRequests.slice(0, 25).forEach((pullRequest, index) => {
    references.push({
      externalId: `${prefix}/pull-request/${index + 1}`,
      kind: "BUSINESS_REFERENCE",
      label: `${pullRequest.repository}#${pullRequest.number} · ${pullRequest.title}`,
      metadata: {
        changedFiles: pullRequest.changedFiles.slice(0, 100),
        excerpt: referenceExcerpt(pullRequest.body),
        repository: pullRequest.repository,
        source: "GITHUB",
        title: pullRequest.title,
        url: safeReferenceUrl(pullRequest.url),
      },
    });
  });
  context.knowledge.slice(0, 25).forEach((knowledge, index) => {
    references.push({
      externalId: `${prefix}/knowledge/${index + 1}`,
      kind: "BUSINESS_REFERENCE",
      label: knowledge.title,
      metadata: {
        excerpt: referenceExcerpt(knowledge.content),
        source: "KNOWLEDGE",
        title: knowledge.title,
        ...(knowledge.url ? { url: safeReferenceUrl(knowledge.url) } : {}),
      },
    });
  });
  return references;
}

function toTaskDetail(row: TaskDetailRow) {
  const latestSnapshot = row.specificationSnapshots[0] ?? null;
  const cases = latestSnapshot?.cases ?? [];
  const executionsByCase = new Map<string, TaskDetailRow["caseExecutions"]>();
  for (const execution of row.caseExecutions) {
    const current = executionsByCase.get(execution.caseId) ?? [];
    current.push(execution);
    executionsByCase.set(execution.caseId, current);
  }
  const caseDetails = cases.map((testCase) => ({
    definition: parseGeneratedCaseDefinition(testCase.definition),
    definitionHash: testCase.definitionHash,
    executions: (executionsByCase.get(testCase.id) ?? []).map((execution) =>
      toCaseExecution(execution, row.lifecycle),
    ),
    id: testCase.id,
    name: testCase.name,
    position: testCase.position,
  }));
  const allExecutions =
    row.kind === "DIRECT_RUN" || row.kind === "LEGACY_RUN"
      ? row.executionRuns.map((run) => ({
          dispatchStatus: "LINKED",
          run,
        }))
      : latestCaseExecutions(
          row.caseExecutions.filter((execution) =>
            cases.some((testCase) => testCase.id === execution.caseId),
          ),
        ).map((execution) => ({
          ...execution,
          scheduling: caseSchedulingForDisplay(execution, row.lifecycle),
        }));
  const counts = executionCounts(
    allExecutions,
    row.kind === "DIRECT_RUN" || row.kind === "LEGACY_RUN"
      ? row.executionRuns.length
      : cases.length *
          row.deployments.filter((deployment) => deployment.enabled !== false)
            .length,
    row.lifecycle,
  );
  return {
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    capabilities: {
      postRunAnalysis:
        row.kind === "ISSUE_SPEC" && env().POST_RUN_ANALYSIS_ENABLED,
    },
    cases: caseDetails,
    counts,
    scheduling: summarizeCaseScheduling(allExecutions, row.lifecycle),
    projectedAt: row.projectedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    currentStage: row.currentStage,
    deadlineAt: row.deadlineAt.toISOString(),
    environment: row.environmentSnapshot,
    deployments: row.deployments.map((deployment) => ({
      enabled: deployment.enabled,
      environment: deployment.environmentSnapshot,
      id: deployment.id,
      key: deployment.key,
      name: deployment.name,
      targetUrl: deployment.targetUrl,
    })),
    executionDisposition: row.executionDisposition,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    id: row.id,
    input: row.inputSnapshot,
    kind: row.kind,
    lifecycle: row.lifecycle,
    profileBinding: row.profileBinding
      ? {
          failureCode: row.profileBinding.failureCode,
          failureMessage: row.profileBinding.failureMessage,
          profileOwnerUserId: row.profileBinding.profileOwnerUserId,
          requestedProfile: row.profileBinding.requestedProfile,
          resolvedAt: row.profileBinding.resolvedAt?.toISOString() ?? null,
          resolvedProfile: row.profileBinding.resolvedProfile,
          status: row.profileBinding.status,
          strategy: row.profileBinding.strategy,
          triggerSource: row.profileBinding.triggerSource,
          unavailablePolicy: row.profileBinding.unavailablePolicy,
        }
      : null,
    runs: row.executionRuns.map((run) => ({
      infrastructureRecoveryCount: run.infrastructureRecoveryCount,
      scheduling: caseSchedulingForDisplay(
        {
          dispatchStatus: "LINKED",
          run,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        },
        row.lifecycle,
      ),
      currentAttemptNumber: run.currentAttemptNumber,
      evidenceCount: run._count.evidences,
      executionDisposition: run.executionDisposition,
      interventionCount: run._count.interventions,
      lifecycle: run.lifecycle,
      maxAttempts: run.maxAttempts,
      runId: run.id,
      verdict: run.verdict,
    })),
    source: { kind: row.sourceKind, ref: row.sourceRef },
    specification: latestSnapshot
      ? {
          completeness: latestSnapshot.completeness,
          context: latestSnapshot.context,
          diagnostics: latestSnapshot.diagnostics,
          generatedAt: latestSnapshot.generatedAt.toISOString(),
          generatorKind: latestSnapshot.generatorKind,
          generatorVersion: latestSnapshot.generatorVersion,
          id: latestSnapshot.id,
          primaryPullRequestUrl: latestSnapshot.primaryPullRequestUrl,
          sourceHash: latestSnapshot.sourceHash,
          summary: latestSnapshot.summary,
        }
      : null,
    stages: [...row.stages]
      .sort((left, right) => stageOrder(left.type) - stageOrder(right.type))
      .map((stage) => ({
        attempts: stage.attempts.map((attempt) => ({
          error: attempt.error,
          finishedAt: attempt.finishedAt?.toISOString() ?? null,
          id: attempt.id,
          number: attempt.number,
          result: attempt.result,
          startedAt: attempt.startedAt?.toISOString() ?? null,
          status: attempt.status,
        })),
        currentAttemptNumber: stage.currentAttemptNumber,
        finishedAt: stage.finishedAt?.toISOString() ?? null,
        id: stage.id,
        lastError: stage.lastError,
        maxAttempts: stage.maxAttempts,
        startedAt: stage.startedAt?.toISOString() ?? null,
        status: stage.status,
        type: stage.type,
        waitingReason: stage.waitingReason,
      })),
    startedAt: row.startedAt?.toISOString() ?? null,
    title: row.title,
    traceId: row.traceId,
    updatedAt: row.updatedAt.toISOString(),
    verdict: row.verdict,
    waitingReason: row.waitingReason,
  };
}

function parseGeneratedCaseDefinition(value: unknown) {
  const agent = runtimeGeneratedSpecCaseSchema.safeParse(value);
  return agent.success
    ? agent.data
    : generatedTestCaseDefinitionSchema.parse(value);
}

function toTaskSummary(
  row: Prisma.TaskExecutionGetPayload<{ include: typeof taskListInclude }>,
) {
  const executions =
    row.kind === "DIRECT_RUN" || row.kind === "LEGACY_RUN"
      ? row.executionRuns.map((run) => ({ dispatchStatus: "LINKED", run }))
      : latestCaseExecutions(
          row.caseExecutions.filter(
            (execution) =>
              !row.specificationSnapshots[0]?.cases ||
              row.specificationSnapshots[0].cases.some(
                (testCase) => testCase.id === execution.caseId,
              ),
          ),
        ).map((execution) => ({
          ...execution,
          scheduling: caseSchedulingForDisplay(execution, row.lifecycle),
        }));
  const total =
    row.kind === "ISSUE_SPEC"
      ? (row.specificationSnapshots[0]?._count.cases ?? 0) *
        row.deployments.filter((deployment) => deployment.enabled !== false)
          .length
      : row.executionRuns.length;
  return {
    counts: executionCounts(executions, total, row.lifecycle),
    scheduling: summarizeCaseScheduling(executions, row.lifecycle),
    createdAt: row.createdAt.toISOString(),
    currentStage: row.currentStage,
    executionDisposition: row.executionDisposition,
    id: row.id,
    kind: row.kind,
    lifecycle: row.lifecycle,
    source: { kind: row.sourceKind, ref: row.sourceRef },
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    verdict: row.verdict,
    waitingReason: row.waitingReason,
  };
}

export function executionCounts(
  executions: readonly CaseExecutionProgress[],
  total: number,
  parentLifecycle?: string,
) {
  return countCaseExecutions(executions, total, parentLifecycle);
}

function latestCaseExecutions<
  T extends { caseId: string; deploymentId: string; executionOrdinal: number },
>(executions: readonly T[]) {
  const latest = new Map<string, T>();
  for (const execution of executions) {
    const key = `${execution.caseId}:${execution.deploymentId}`;
    const previous = latest.get(key);
    if (!previous || execution.executionOrdinal > previous.executionOrdinal) {
      latest.set(key, execution);
    }
  }
  return [...latest.values()];
}

function normalizeTaskDeployments(
  deployments: readonly TaskDeployment[],
  legacyTargetUrl?: string,
): TaskDeployment[] {
  if (deployments.length) {
    return deployments.map((deployment) => ({
      ...deployment,
      targetUrl: normalizeTargetUrl(deployment.targetUrl),
    }));
  }
  return legacyTargetUrl
    ? [
        {
          environment: {},
          key: "default",
          name: "Default",
          targetUrl: normalizeTargetUrl(legacyTargetUrl),
        },
      ]
    : [];
}

function stageOrder(
  type: "SPEC_ANALYSIS" | "PROFILE_RESOLUTION" | "SPEC_EXECUTION",
) {
  if (type === "SPEC_ANALYSIS") return 0;
  return type === "PROFILE_RESOLUTION" ? 1 : 2;
}

function compatibilityTaskLifecycle(lifecycle: string) {
  switch (lifecycle) {
    case "QUEUED":
      return "QUEUED" as const;
    case "WAITING_HUMAN":
      return "WAITING_HUMAN" as const;
    case "COMPLETED":
      return "COMPLETED" as const;
    case "CANCELLED":
      return "CANCELLED" as const;
    case "TIMED_OUT":
      return "TIMED_OUT" as const;
    default:
      return "RUNNING" as const;
  }
}

function toCaseExecution(
  execution: TaskDetailRow["caseExecutions"][number],
  parentLifecycle: string,
) {
  return {
    executionPolicy: execution.executionPolicy,
    scheduling: caseSchedulingForDisplay(execution, parentLifecycle),
    dispatch: {
      attempts: execution.dispatchAttempts,
      lastError: execution.dispatchLastError,
      requestedAt: execution.dispatchRequestedAt?.toISOString() ?? null,
      status: execution.dispatchStatus,
    },
    executionOrdinal: execution.executionOrdinal,
    deployment: {
      id: execution.deployment.id,
      key: execution.deployment.key,
      name: execution.deployment.name,
      targetUrl: execution.deployment.targetUrl,
    },
    id: execution.id,
    run: execution.run
      ? {
          infrastructureRecoveryCount:
            execution.run.infrastructureRecoveryCount,
          currentAttemptNumber: execution.run.currentAttemptNumber,
          evidenceCount: execution.run._count.evidences,
          executionDisposition: execution.run.executionDisposition,
          interventionCount: execution.run._count.interventions,
          lifecycle: execution.run.lifecycle,
          maxAttempts: execution.run.maxAttempts,
          runId: execution.run.id,
          verdict: execution.run.verdict,
        }
      : null,
  };
}

function caseSchedulingForDisplay(
  execution: CaseExecutionProgress & {
    createdAt: Date;
    updatedAt: Date;
    dispatchRequestedAt?: Date | null;
  },
  parentLifecycle?: string,
): CaseSchedulingDecision {
  const previous = readCaseScheduling(execution.scheduling);
  const phase = caseExecutionPhase(execution);
  const terminal =
    phase === "terminal" ||
    (!execution.run &&
      ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(parentLifecycle ?? ""));
  if (terminal)
    return {
      state: "TERMINAL",
      reason:
        !execution.run && execution.dispatchStatus === "LINKED"
          ? "RUN_RECORD_MISSING"
          : (previous?.reason ?? null),
      waitingSince: null,
      evaluatedAt: execution.updatedAt.toISOString(),
      blockedBy: null,
      queue: null,
      nextRetryAt: null,
    };
  if (phase === "recovering")
    return {
      ...newSchedulingDecision(execution, "RECOVERING", "LEASE_RECOVERY", null),
      ...previous,
      state: "RECOVERING",
      reason: "LEASE_RECOVERY",
    };
  if (!execution.run && execution.dispatchStatus === "FAILED")
    return {
      ...newSchedulingDecision(execution, "WAITING", "RETRY_BACKOFF", null),
      nextRetryAt: execution.dispatchRequestedAt
        ? new Date(
            execution.dispatchRequestedAt.getTime() + DISPATCH_RETRY_DELAY_MS,
          ).toISOString()
        : null,
    };
  if (
    previous &&
    (previous.state === "RECOVERING" ||
      !execution.run ||
      (execution.run.lifecycle !== "RUNNING" && previous.state !== "READY"))
  )
    return previous;
  const running = execution.run?.lifecycle === "RUNNING";
  return {
    state: running ? "RUNNING" : "WAITING",
    reason: running
      ? null
      : execution.run
        ? "BROWSER_ADMISSION"
        : execution.dispatchStatus === "FAILED"
          ? "RETRY_BACKOFF"
          : "SCHEDULER_PENDING",
    waitingSince: running
      ? null
      : (previous?.waitingSince ?? execution.createdAt.toISOString()),
    evaluatedAt: execution.updatedAt.toISOString(),
    blockedBy: null,
    queue: null,
    nextRetryAt:
      execution.dispatchStatus === "FAILED" && execution.dispatchRequestedAt
        ? new Date(
            execution.dispatchRequestedAt.getTime() + DISPATCH_RETRY_DELAY_MS,
          ).toISOString()
        : null,
  };
}

function event(
  teamId: string,
  taskExecutionId: string,
  actor: string,
  kind: string,
  payload: Record<string, unknown>,
): Prisma.TaskExecutionEventUncheckedCreateInput {
  return { actor, kind, payload: json(payload), taskExecutionId, teamId };
}

function profilePolicyScopeKey(
  policy: Extract<
    TaskExecutionCreateInput,
    { kind: "ISSUE_SPEC" }
  >["profilePolicy"],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        authRole: policy.scope.authRole,
        environmentKey: policy.scope.environmentKey,
        hostname: policy.scope.hostname ?? null,
      }),
    )
    .digest("hex");
}

function asToolContext(task: {
  team: { id: string; name: string; slug: string };
}): ToolAuthContext {
  return {
    credential: {
      id: "system:task-execution-worker",
      name: "Task execution worker",
      scopes: ["run:read", "run:write", "run:cancel"],
    },
    team: task.team,
  };
}

function requireAnalysisLease(
  attempt: { leaseOwner: string | null; leaseToken: string | null },
  leaseToken: string,
) {
  if (
    attempt.leaseOwner !== ANALYSIS_WORKER ||
    attempt.leaseToken !== leaseToken
  ) {
    throw new ConflictException("The Spec analysis lease is stale.");
  }
}

function referenceExcerpt(value: string) {
  return redactText(value)
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/\S+/gu, "[link]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
}

function safeReferenceUrl(value: string) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeTargetUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    throw new BadRequestException("Deployment target must be an HTTP(S) URL.");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function safeError(error: unknown) {
  return {
    at: new Date().toISOString(),
    code:
      error instanceof ConflictException
        ? "TASK_STAGE_CONFLICT"
        : "TASK_STAGE_FAILED",
    message: redactText(
      error instanceof Error ? error.message : String(error),
    ).slice(0, 4_000),
  };
}

function uniqueConstraint(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

/** Forward only explicit safe scheduling metadata, never arbitrary upstream errors. */
export function profileRootBlocker(error: unknown) {
  const value = record(error);
  if (
    !["LEASE_RECOVERY", "DATA_LOCK", "WRITE_OUTCOME_UNKNOWN"].includes(
      String(value.code),
    )
  )
    return {};
  const blocker = record(value.blockedBy);
  return {
    rootReason: String(value.code),
    ...(typeof blocker.recoveryId === "string"
      ? { recoveryId: blocker.recoveryId }
      : {}),
    ...(typeof blocker.recoveryPhase === "string"
      ? { recoveryPhase: blocker.recoveryPhase }
      : {}),
  };
}
