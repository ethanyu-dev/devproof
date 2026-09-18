import { isSpecTask } from "@devproof/contracts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  executionConcurrencyPolicySchema,
  taskCaseRerunSourceSchema,
  taskExecutionCreateInputSchema,
  type TaskCaseRerunSource,
} from "@devproof/contracts";
import { specificationDefinitionHash } from "@devproof/test-domain";
import type { TaskRequestActor } from "./task-execution.service.js";
import {
  readAccountPlan,
  resolveCaseExecutionDefinition,
} from "./case-account-definition.js";

export const caseRerunInclude = {
  analysisSources: true,
  caseExecutions: {
    include: {
      deployment: true,
      testCase: { include: { snapshot: true } },
      run: {
        select: {
          lifecycle: true,
          tasks: { select: { recoveryStatus: true } },
        },
      },
    },
  },
} satisfies Prisma.TaskExecutionInclude;

type CaseRerunTask = Prisma.TaskExecutionGetPayload<{
  include: typeof caseRerunInclude;
}>;

export function caseRerunSource(
  environment: unknown,
): TaskCaseRerunSource | null {
  const parsed = taskCaseRerunSourceSchema.safeParse(
    environment &&
      typeof environment === "object" &&
      "caseRerunSource" in environment
      ? environment.caseRerunSource
      : null,
  );
  return parsed.success ? parsed.data : null;
}

export function caseRerunBlockReason(
  executions: readonly {
    executionPolicy?: unknown;
    run: {
      lifecycle: string;
      tasks?: { recoveryStatus: string | null }[];
    } | null;
  }[],
  task?: {
    lifecycle: string;
    environmentSnapshot: unknown;
    cancelRequestedAt?: Date | null;
  },
  options: { inPlace?: boolean } = {},
): string | null {
  if (options.inPlace && task?.cancelRequestedAt)
    return "任务已取消，无法在其中重跑用例。";
  const allowUnstarted =
    !options.inPlace &&
    task &&
    ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(task.lifecycle) &&
    caseRerunSource(task.environmentSnapshot) !== null;
  if (
    !executions.length ||
    (!allowUnstarted && executions.some((item) => !item.run))
  )
    return "用例尚未创建执行记录，暂时无法单独重跑。";
  if (
    executions.some(
      (item) =>
        item.run &&
        !["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(item.run.lifecycle),
    )
  )
    return "用例仍在执行，请等待结束后重跑。";
  if (
    executions.some((item) =>
      item.run?.tasks?.some(
        (task) => task.recoveryStatus === "WRITE_OUTCOME_UNKNOWN",
      ),
    )
  )
    return "上次执行的业务写入结果尚未确认，请先在会话恢复中核对结果，再重跑。";
  for (const item of executions) {
    const policy = executionConcurrencyPolicySchema.safeParse(
      item.executionPolicy,
    );
    if (item.executionPolicy != null && !policy.success)
      return "用例执行策略无效，请先核对执行策略。";
    if (
      !options.inPlace &&
      policy.success &&
      policy.data.dependsOnCaseIds?.length
    )
      return "该用例配置了前置用例，暂不支持单独创建重跑任务。";
  }
  return null;
}

/** Build the complete task atomically so the analysis worker cannot claim it. */
export async function insertCaseRerunTask(
  tx: Prisma.TransactionClient,
  source: CaseRerunTask,
  executions: CaseRerunTask["caseExecutions"],
  idempotencyKey: string,
  actor: TaskRequestActor,
) {
  const reason = caseRerunBlockReason(executions, source);
  if (reason) throw new ConflictException(reason);
  const originalCase = executions[0]!.testCase;
  const snapshot = originalCase.snapshot;
  if (executions.some((item) => item.testCase.snapshotId !== snapshot.id))
    throw new ConflictException("用例规格不一致，无法创建重跑任务。");
  const input = taskExecutionCreateInputSchema.parse(source.inputSnapshot);
  if (!isSpecTask(input))
    throw new ConflictException("仅 Spec 任务支持单用例重跑。");
  if (input.profilePolicy.strategy === "EXPLICIT_PROFILE") {
    if (actor.kind !== "USER" || !actor.userId)
      throw new ForbiddenException(
        "Explicit browser profiles can only be selected by their signed-in owner.",
      );
    const owned = await tx.userBrowserProfile.findFirst({
      where: {
        id: input.profilePolicy.profileId!,
        ownerUserId: actor.userId,
        teamId: source.teamId,
      },
      select: { id: true },
    });
    if (!owned)
      throw new ForbiddenException(
        "The explicit browser profile must belong to the requester.",
      );
  }

  const now = new Date();
  const taskId = randomUUID();
  const caseId = randomUUID();
  const snapshotId = randomUUID();
  const analysisStageId = randomUUID();
  const attemptId = randomUUID();
  const sources = source.analysisSources.filter(
    (item) => item.stageAttemptId === snapshot.stageAttemptId,
  );
  const references = new Map(
    sources.map((item) => [
      item.externalId,
      `analysis-source://${attemptId}/${randomUUID()}`,
    ]),
  );
  const definition = remapSourceReferences(originalCase.definition, references);
  const context = remapSourceReferences(snapshot.context, references);
  const provenance: TaskCaseRerunSource = {
    taskId: source.id,
    caseId: originalCase.id,
    caseName: originalCase.name,
    snapshotId: snapshot.id,
    executionIds: executions.map((item) => item.id),
  };
  const deployments = executions.map((item) => ({
    ...item.deployment,
    id: randomUUID(),
    executionPolicy: item.executionPolicy,
  }));
  // The current deployment targets and reviewed policies may differ from the
  // original create request. Preserve what was actually selected for this Case.
  const rerunInput = {
    ...input,
    idempotencyKey,
    targetUrl: deployments[0]!.targetUrl,
    deployments: deployments.map((item) => ({
      key: item.key,
      name: item.name,
      targetUrl: item.targetUrl,
      environment: item.environmentSnapshot,
    })),
    caseExecutionPolicies: undefined,
  };
  const title = `${source.sourceRef ?? source.title} · ${originalCase.name}（重跑）`;
  const environment = {
    ...asRecord(source.environmentSnapshot),
    allowedHosts: [new URL(deployments[0]!.targetUrl).hostname],
    targetUrl: deployments[0]!.targetUrl,
    specificationSnapshotId: snapshotId,
    caseRerunSource: provenance,
  };
  await tx.taskExecution.create({
    data: {
      id: taskId,
      teamId: source.teamId,
      kind: input.kind,
      title,
      idempotencyKey,
      inputSnapshot: json(rerunInput),
      creationInputSnapshot: json(rerunInput),
      environmentSnapshot: json(environment),
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      requestedByKind: actor.kind,
      requestedByUserId: actor.userId ?? null,
      notificationContext: json(actor.notificationContext ?? {}),
      traceId: randomBytes(16).toString("hex"),
      deadlineAt: new Date(now.getTime() + input.deadlineSeconds * 1000),
      currentStage: "PROFILE_RESOLUTION",
      lifecycle: "RUNNING",
      startedAt: now,
      deployments: {
        create: deployments.map((item) => ({
          id: item.id,
          key: item.key,
          name: item.name,
          targetUrl: item.targetUrl,
          environmentSnapshot: json(item.environmentSnapshot),
        })),
      },
    },
  });
  await tx.taskExecutionStage.createMany({
    data: [
      {
        id: analysisStageId,
        taskExecutionId: taskId,
        type: "SPEC_ANALYSIS",
        status: "SUCCEEDED",
        currentAttemptNumber: 1,
        maxAttempts: 1,
        startedAt: now,
        finishedAt: now,
      },
      { taskExecutionId: taskId, type: "PROFILE_RESOLUTION", maxAttempts: 1 },
      { taskExecutionId: taskId, type: "SPEC_EXECUTION", maxAttempts: 3 },
    ],
  });
  await tx.taskStageAttempt.create({
    data: {
      id: attemptId,
      stageId: analysisStageId,
      number: 1,
      status: "SUCCEEDED",
      inputSnapshot: json(rerunInput),
      startedAt: now,
      finishedAt: now,
      result: json({
        reused: true,
        sourceSnapshotId: snapshot.id,
        snapshotId,
        caseCount: 1,
      }),
    },
  });
  await tx.taskSpecificationSnapshot.create({
    data: {
      id: snapshotId,
      taskExecutionId: taskId,
      stageAttemptId: attemptId,
      completeness: snapshot.completeness,
      context: json(context),
      diagnostics: json(snapshot.diagnostics),
      sourceHash: snapshot.sourceHash,
      generatorKind: snapshot.generatorKind,
      generatorVersion: snapshot.generatorVersion,
      generatedAt: snapshot.generatedAt,
      primaryPullRequestUrl: snapshot.primaryPullRequestUrl,
      summary: `单用例重跑：${originalCase.name}。复用原任务规格，仅验证本用例的验收标准。`,
      cases: {
        create: [
          {
            id: caseId,
            name: originalCase.name,
            position: 0,
            definition: json(definition),
            definitionHash: specificationDefinitionHash(definition),
            generatedAt: originalCase.generatedAt,
          },
        ],
      },
    },
  });
  if (sources.length)
    await tx.taskAnalysisSource.createMany({
      data: sources.map((item) => ({
        taskExecutionId: taskId,
        stageAttemptId: attemptId,
        teamId: source.teamId,
        externalId: references.get(item.externalId)!,
        kind: item.kind,
        label: item.label,
        uri: item.uri,
        revision: item.revision,
        locator: json(item.locator),
        content: json(item.content),
        contentHash: item.contentHash,
        byteSize: item.byteSize,
      })),
    });
  await tx.taskCaseExecution.createMany({
    data: deployments.map((item, index) => ({
      taskExecutionId: taskId,
      caseId,
      deploymentId: item.id,
      executionOrdinal: 1,
      dispatchOrder: 0,
      executionPolicy: item.executionPolicy ?? Prisma.JsonNull,
      ...(() => {
        const previous = executions[index]!;
        const plan = readAccountPlan(previous.testAccountPlan);
        if (plan?.version !== 2) return {};
        resolveCaseExecutionDefinition(originalCase.definition, plan);
        return {
          testAccountPlan: json({
            ...(remapSourceReferences(plan, references) as object),
            definitionHash: specificationDefinitionHash(definition),
            revision: randomUUID(),
            requestedAt: now.toISOString(),
            expiresAt: new Date(
              now.getTime() + input.hitlPolicy.timeoutSeconds * 1000,
            ).toISOString(),
          }),
        };
      })(),
    })),
  });
  await tx.taskProfileBinding.create({
    data: {
      taskExecutionId: taskId,
      strategy: input.profilePolicy.strategy,
      requestedProfileId: input.profilePolicy.profileId ?? null,
      unavailablePolicy: input.profilePolicy.onUnavailable,
      scopeKey: createHash("sha256")
        .update(
          JSON.stringify({
            authRole: input.profilePolicy.scope.authRole,
            environmentKey: input.profilePolicy.scope.environmentKey,
            hostname: input.profilePolicy.scope.hostname ?? null,
          }),
        )
        .digest("hex"),
      triggerSource:
        input.profilePolicy.strategy === "ISSUE_ASSIGNEE"
          ? "ISSUE_ASSIGNEE"
          : (actor.triggerSource ?? "CONSOLE"),
    },
  });
  await tx.taskExecutionEvent.createMany({
    data: [
      {
        taskExecutionId: source.id,
        kind: "task.case.rerun.created",
        actor: "HUMAN",
        payload: json({ rerunTaskId: taskId, caseId: originalCase.id }),
      },
      {
        taskExecutionId: taskId,
        kind: "task.rerun.linked",
        actor: "CONTROL_PLANE",
        payload: json({
          sourceTaskId: source.id,
          sourceCaseId: originalCase.id,
        }),
      },
      {
        taskExecutionId: taskId,
        kind: "task.spec.reused",
        actor: "CONTROL_PLANE",
        payload: json({ ...provenance, stage: "SPEC_ANALYSIS", caseCount: 1 }),
      },
    ].map((item) => ({ ...item, teamId: source.teamId })),
  });
  return taskId;
}

function remapSourceReferences(
  value: Prisma.JsonValue,
  references: Map<string, string>,
): Prisma.JsonValue {
  if (typeof value === "string") {
    if (value.startsWith("analysis-source://") && !references.has(value))
      throw new ConflictException(
        "原用例的分析来源已缺失，无法复用规格，请重新创建完整任务。",
      );
    return references.get(value) ?? value;
  }
  if (Array.isArray(value))
    return value.map((item) => remapSourceReferences(item, references));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        remapSourceReferences(item ?? null, references),
      ]),
    );
  return value;
}

function asRecord(value: Prisma.JsonValue): Prisma.JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
