import { specificationDefinitionHash } from "@devproof/test-domain";
import { resolveCaseExecutionDefinition } from "./case-account-definition.js";
import { describe, expect, it, vi } from "vitest";
import {
  caseRerunBlockReason,
  insertCaseRerunTask,
} from "./task-case-rerun.js";
import { TaskExecutionService } from "./task-execution.service.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const caseId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "33333333-3333-4333-8333-333333333333";
const executionId = "44444444-4444-4444-8444-444444444444";
const teamId = "55555555-5555-4555-8555-555555555555";
const userId = "66666666-6666-4666-8666-666666666666";
const deploymentId = "77777777-7777-4777-8777-777777777777";
const sourceRef = "analysis-source://original-attempt/original-source";
const current = {
  team: { id: teamId },
  credential: { id: "console" },
} as never;
const actor = {
  kind: "USER" as const,
  userId,
  triggerSource: "CONSOLE" as const,
};
const replayEnvironment = {
  caseRerunSource: {
    taskId,
    caseId,
    snapshotId,
    caseName: "独立核验",
    executionIds: [executionId],
  },
};

function fixture() {
  const snapshot = {
    id: snapshotId,
    stageAttemptId: "original-attempt",
    context: { issue: { identifier: "ENG-123" }, sourceRefs: [sourceRef] },
    completeness: "PARTIAL",
    diagnostics: [{ code: "GITHUB_PR_NOT_LINKED" }],
    sourceHash: "source-hash",
    generatorKind: "AGENT",
    generatorVersion: "1",
    generatedAt: new Date("2026-01-01T00:00:00Z"),
    primaryPullRequestUrl: null,
  };
  const testCase = {
    id: caseId,
    name: "独立核验",
    snapshotId,
    snapshot,
    position: 4,
    generatedAt: snapshot.generatedAt,
    definition: {
      name: "独立核验",
      authRole: "default",
      preconditions: [],
      steps: [{ order: 1, action: "查看页面" }],
      sourceRefs: [sourceRef],
      criteria: [
        {
          id: "criterion-1",
          description: "目标可见",
          sourceRefs: [sourceRef],
          basis: { sourceRef },
        },
      ],
    },
  };
  const execution = {
    id: executionId,
    caseId,
    executionOrdinal: 2,
    deploymentId,
    testCase,
    deployment: {
      id: deploymentId,
      key: "preview",
      name: "Preview",
      enabled: true,
      targetUrl: "https://current.example.com",
      environmentSnapshot: { name: "current" },
    },
    executionPolicy: {
      accessMode: "READ_ONLY",
      provenance: "CONSOLE_REVIEWED",
      version: 1,
    },
    run: {
      lifecycle: "COMPLETED",
      tasks: [{ recoveryStatus: null as string | null }],
    },
  };
  const source = {
    id: taskId,
    teamId,
    kind: "ISSUE_SPEC",
    sourceKind: "LINEAR_ISSUE",
    sourceRef: "ENG-123",
    lifecycle: "COMPLETED",
    deadlineAt: new Date("2026-01-01"),
    cancelRequestedAt: null,
    inputSnapshot: {
      kind: "ISSUE_SPEC",
      issueRef: "ENG-123",
      idempotencyKey: "original-request",
      deadlineSeconds: 3600,
      targetUrl: "https://old.example.com",
    },
    environmentSnapshot: { targetUrl: "https://current.example.com" },
    caseExecutions: [execution],
    analysisSources: [
      {
        id: "source-id",
        stageAttemptId: "original-attempt",
        externalId: sourceRef,
        kind: "LINEAR_ISSUE",
        label: "需求",
        uri: "https://linear.app/team/issue/ENG-123",
        content: { description: "原始需求" },
        contentHash: "content-hash",
        byteSize: 30,
        locator: {},
        revision: null,
      },
    ],
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    taskExecution: {
      findFirst: vi.fn().mockResolvedValue(source),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    taskExecutionStage: { createMany: vi.fn() },
    taskStageAttempt: { create: vi.fn() },
    taskSpecificationSnapshot: { create: vi.fn() },
    taskAnalysisSource: { createMany: vi.fn() },
    taskCaseExecution: { createMany: vi.fn() },
    taskProfileBinding: { create: vi.fn() },
    taskExecutionEvent: { createMany: vi.fn() },
    userBrowserProfile: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
    taskExecution: tx.taskExecution,
  };
  const service = new TaskExecutionService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  vi.spyOn(service, "detail").mockImplementation(
    async (_current, id) => ({ id }) as never,
  );
  const rerun = (key = "case-rerun-request") =>
    service.rerunCaseAsTask(
      current,
      taskId,
      caseId,
      { idempotencyKey: key },
      actor,
    );
  return { source, tx, service, rerun, execution };
}

describe("case rerun task creation", () => {
  it("creates a reviewed multi-case suite in one snapshot with a shared deployment and distinct policies", async () => {
    const { source, tx, execution } = fixture();
    const second = structuredClone(execution);
    second.id = "88888888-8888-4888-8888-888888888888";
    second.caseId = "99999999-9999-4999-8999-999999999999";
    second.testCase.id = second.caseId;
    second.testCase.name = "第二用例";
    second.executionPolicy = {
      accessMode: "MUTATING",
      resourceScopes: ["records/second"],
    } as never;
    const before = structuredClone(source);
    await insertCaseRerunTask(
      tx as never,
      source as never,
      [execution, second] as never,
      "reviewed-suite",
      actor,
      { suite: true },
    );
    expect(source).toEqual(before);
    expect(tx.taskSpecificationSnapshot.create).toHaveBeenCalledOnce();
    const snapshot = tx.taskSpecificationSnapshot.create.mock.calls[0]![0].data;
    expect(snapshot.cases.create).toHaveLength(2);
    expect(snapshot.cases.create[0].id).not.toBe(snapshot.cases.create[1].id);
    const task = tx.taskExecution.create.mock.calls[0]![0].data;
    expect(task.deployments.create).toHaveLength(1);
    expect(task.environmentSnapshot.caseRerunSource).toBeUndefined();
    expect(task.environmentSnapshot.reviewedSuiteSource.caseIds).toEqual([
      caseId,
      second.caseId,
    ]);
    const runs = tx.taskCaseExecution.createMany.mock.calls[0]![0].data;
    expect(runs.map((r: { caseId: string }) => r.caseId)).toEqual(
      snapshot.cases.create.map((c: { id: string }) => c.id),
    );
    expect(runs[0].deploymentId).toBe(runs[1].deploymentId);
    expect(runs[1].executionPolicy).toEqual(second.executionPolicy);
    expect(
      tx.taskStageAttempt.create.mock.calls[0]![0].data.result.caseCount,
    ).toBe(2);
  });
  it("reuses only the selected Case after expiry, with new references, deadline, identity and no original-record edits", async () => {
    const { source, tx, rerun } = fixture();
    const before = structuredClone(source);
    const start = Date.now();
    const result = await rerun();
    expect(source).toEqual(before);
    expect(tx.taskExecution.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: taskId, teamId },
        include: expect.objectContaining({
          caseExecutions: expect.objectContaining({
            where: { caseId, deployment: { enabled: true } },
          }),
        }),
      }),
    );
    const task = tx.taskExecution.create.mock.calls[0]![0].data;
    expect(task.id).toBe(result.id);
    expect(task.id).not.toBe(taskId);
    expect(task.deadlineAt.getTime()).toBeGreaterThanOrEqual(start + 3600_000);
    expect(task.deadlineAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 3600_000,
    );
    expect(task).toMatchObject({
      currentStage: "PROFILE_RESOLUTION",
      lifecycle: "RUNNING",
      requestedByUserId: userId,
    });
    expect(task.inputSnapshot).toMatchObject({
      targetUrl: "https://current.example.com",
      deployments: [{ targetUrl: "https://current.example.com" }],
    });
    expect(task.environmentSnapshot.caseRerunSource).toMatchObject({
      taskId,
      caseId,
      snapshotId,
      executionIds: [executionId],
    });

    const snapshot = tx.taskSpecificationSnapshot.create.mock.calls[0]![0].data;
    expect(snapshot.cases.create).toHaveLength(1);
    expect(snapshot.cases.create[0]).toMatchObject({
      name: "独立核验",
      position: 0,
    });
    const reference =
      tx.taskAnalysisSource.createMany.mock.calls[0]![0].data[0];
    expect(reference.externalId).not.toBe(sourceRef);
    expect(snapshot.cases.create[0].definition).toMatchObject({
      sourceRefs: [reference.externalId],
      criteria: [
        {
          sourceRefs: [reference.externalId],
          basis: { sourceRef: reference.externalId },
        },
      ],
    });
    expect(snapshot.context.sourceRefs).toEqual([reference.externalId]);
    expect(reference.content).toEqual(source.analysisSources[0]!.content);
    expect(snapshot).toMatchObject({
      completeness: "PARTIAL",
      generatedAt: source.caseExecutions[0]!.testCase.generatedAt,
    });
    expect(tx.taskStageAttempt.create.mock.calls[0]![0].data).toMatchObject({
      status: "SUCCEEDED",
      result: { reused: true, caseCount: 1 },
    });
    expect(
      tx.taskExecutionStage.createMany.mock.calls[0]![0].data[0],
    ).toMatchObject({ type: "SPEC_ANALYSIS", status: "SUCCEEDED" });
    expect(tx.taskProfileBinding.create.mock.calls[0]![0].data).toMatchObject({
      strategy: "EPHEMERAL",
      taskExecutionId: task.id,
    });
    const executions = tx.taskCaseExecution.createMany.mock.calls[0]![0].data;
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      caseId: snapshot.cases.create[0].id,
      taskExecutionId: task.id,
      executionOrdinal: 1,
      executionPolicy: source.caseExecutions[0]!.executionPolicy,
    });
    expect(tx.taskExecutionEvent.createMany.mock.calls[0]![0].data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskExecutionId: taskId,
          kind: "task.case.rerun.created",
          payload: { rerunTaskId: task.id, caseId },
        }),
        expect.objectContaining({
          taskExecutionId: task.id,
          kind: "task.rerun.linked",
        }),
      ]),
    );
  });

  it("returns the committed task on a repeated request, even if source state subsequently changed", async () => {
    const { tx, rerun, source } = fixture();
    const first = await rerun();
    const created = tx.taskExecution.create.mock.calls[0]![0].data;
    tx.taskExecution.findUnique.mockResolvedValue(created);
    source.caseExecutions[0]!.run.tasks[0]!.recoveryStatus =
      "WRITE_OUTCOME_UNKNOWN";
    expect(await rerun()).toEqual(first);
    expect(tx.taskExecution.create).toHaveBeenCalledTimes(1);
  });

  it("rejects idempotency keys belonging to another request", async () => {
    const { tx, rerun } = fixture();
    tx.taskExecution.findUnique.mockResolvedValue({
      id: taskId,
      environmentSnapshot: {},
    });
    await expect(rerun()).rejects.toMatchObject({ status: 409 });
    expect(tx.taskExecution.create).not.toHaveBeenCalled();
  });

  it("does not revive previous failed attempts when picking the latest execution", async () => {
    const { source, execution, tx, rerun } = fixture();
    source.caseExecutions.unshift({
      ...execution,
      executionOrdinal: 1,
      run: {
        lifecycle: "COMPLETED",
        tasks: [{ recoveryStatus: "WRITE_OUTCOME_UNKNOWN" }],
      },
    });
    await rerun();
    expect(tx.taskCaseExecution.createMany.mock.calls[0]![0].data).toHaveLength(
      1,
    );
  });

  it.each(["RUNNING", "WAITING_HUMAN", "QUEUED"])(
    "rejects an active %s execution",
    async (lifecycle) => {
      const { execution, tx, rerun } = fixture();
      execution.run.lifecycle = lifecycle;
      await expect(rerun()).rejects.toThrow("仍在执行");
      expect(tx.taskExecution.create).not.toHaveBeenCalled();
    },
  );

  it("blocks unconfirmed writes until the recovery is resolved", async () => {
    const { execution, tx, rerun } = fixture();
    execution.run.tasks[0]!.recoveryStatus = "WRITE_OUTCOME_UNKNOWN";
    await expect(rerun()).rejects.toThrow("业务写入结果尚未确认");
    expect(tx.taskExecution.create).not.toHaveBeenCalled();
    execution.run.tasks[0]!.recoveryStatus = "RESOLVED";
    await expect(rerun()).resolves.toBeTruthy();
  });

  it("rejects explicit dependencies without creating a partial task", async () => {
    const { execution, tx, rerun } = fixture();
    Object.assign(execution.executionPolicy, { dependsOnCaseIds: [taskId] });
    await expect(rerun()).rejects.toThrow("前置用例");
    expect(tx.taskExecution.create).not.toHaveBeenCalled();
  });

  it("requires the current requester to own an explicit profile", async () => {
    const { source, tx, rerun } = fixture();
    Object.assign(source.inputSnapshot, {
      profilePolicy: { strategy: "EXPLICIT_PROFILE", profileId: userId },
    });
    await expect(rerun()).rejects.toMatchObject({ status: 403 });
    expect(tx.userBrowserProfile.findFirst).toHaveBeenCalledWith({
      where: { id: userId, ownerUserId: userId, teamId },
      select: { id: true },
    });
    expect(tx.taskExecution.create).not.toHaveBeenCalled();
  });

  it("rejects missing analysis sources instead of dropping evidence references", async () => {
    const { source, tx, rerun } = fixture();
    source.analysisSources = [];
    await expect(rerun()).rejects.toThrow("分析来源已缺失");
    expect(tx.taskExecution.create).not.toHaveBeenCalled();
  });

  it("does not broaden scope when the task-level rerun is used on a case replay", async () => {
    const { service, source, tx } = fixture();
    Object.assign(source, {
      environmentSnapshot: {
        caseRerunSource: {
          taskId,
          caseId,
          snapshotId,
          caseName: "独立核验",
          executionIds: [executionId],
        },
      },
      specificationSnapshots: [{ cases: [{ id: caseId }] }],
    });
    const clone = vi
      .spyOn(service, "rerunCaseAsTask")
      .mockResolvedValue({ id: "replayed" } as never);
    await service.rerun(current, taskId, actor);
    expect(clone).toHaveBeenCalledWith(
      current,
      taskId,
      caseId,
      { idempotencyKey: expect.any(String) },
      actor,
    );
    expect(tx.taskExecution.create).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "CANCELLED", "TIMED_OUT"])(
    "reruns a %s single-Case task that never created a Run",
    async (lifecycle) => {
      const { service, source, execution, tx } = fixture();
      Object.assign(source, {
        lifecycle,
        environmentSnapshot: replayEnvironment,
        cancelRequestedAt: lifecycle === "CANCELLED" ? new Date() : null,
        specificationSnapshots: [{ cases: [{ id: caseId }] }],
      });
      Object.assign(execution, { run: null });
      const result = await service.rerun(current, taskId, actor);
      const created = tx.taskExecution.create.mock.calls[0]![0].data;
      expect(created.id).toBe(result.id);
      expect(created.environmentSnapshot.caseRerunSource.taskId).toBe(taskId);
      expect(created.inputSnapshot.deployments).toEqual([
        {
          key: "preview",
          name: "Preview",
          targetUrl: "https://current.example.com",
          environment: { name: "current" },
        },
      ]);
      expect(
        tx.taskSpecificationSnapshot.create.mock.calls[0]![0].data.cases.create,
      ).toHaveLength(1);
      expect(
        tx.taskCaseExecution.createMany.mock.calls[0]![0].data,
      ).toHaveLength(1);
      expect(tx.taskProfileBinding.create).toHaveBeenCalledOnce();
    },
  );

  it.each(["QUEUED", "RUNNING", "WAITING_INPUT"])(
    "does not duplicate unstarted executions of an active %s replay",
    async (lifecycle) => {
      const { source, execution, rerun, tx } = fixture();
      Object.assign(source, {
        lifecycle,
        environmentSnapshot: replayEnvironment,
      });
      Object.assign(execution, { run: null });
      await expect(rerun()).rejects.toMatchObject({ status: 409 });
      expect(tx.taskExecution.create).not.toHaveBeenCalled();
    },
  );

  it("still requires a created Run when extracting a Case from a full task", async () => {
    const { execution, rerun, tx } = fixture();
    Object.assign(execution, { run: null });
    await expect(rerun()).rejects.toThrow("尚未创建执行记录");
    expect(tx.taskExecution.create).not.toHaveBeenCalled();
  });

  it("keeps dependency and unresolved-write guards for terminal replays", async () => {
    const { source, execution, rerun, tx } = fixture();
    Object.assign(source, { environmentSnapshot: replayEnvironment });
    execution.run.tasks[0]!.recoveryStatus = "WRITE_OUTCOME_UNKNOWN";
    await expect(rerun()).rejects.toThrow("业务写入结果尚未确认");
    Object.assign(execution, { run: null });
    Object.assign(execution.executionPolicy, { dependsOnCaseIds: [taskId] });
    await expect(rerun()).rejects.toThrow("前置用例");
    expect(tx.taskExecution.create).not.toHaveBeenCalled();
  });

  it("rejects an active child Run even if the replay parent is terminal", async () => {
    const { source, execution, rerun, tx } = fixture();
    Object.assign(source, { environmentSnapshot: replayEnvironment });
    execution.run.lifecycle = "RUNNING";
    await expect(rerun()).rejects.toThrow("仍在执行");
    expect(tx.taskExecution.create).not.toHaveBeenCalled();
  });

  it("requires an existing task and selected case in the authenticated team", async () => {
    const { tx, source, rerun } = fixture();
    source.caseExecutions = [];
    await expect(rerun()).rejects.toMatchObject({ status: 404 });
    tx.taskExecution.findFirst.mockResolvedValue(null);
    await expect(rerun()).rejects.toMatchObject({ status: 404 });
  });
});

describe("case rerun availability", () => {
  it("requires a created execution and rejects malformed declared policies", () => {
    expect(caseRerunBlockReason([])).toContain("尚未创建");
    expect(caseRerunBlockReason([{ run: null }])).toContain("尚未创建");
    expect(
      caseRerunBlockReason([
        {
          run: { lifecycle: "COMPLETED" },
          executionPolicy: { accessMode: "invalid" },
        },
      ]),
    ).toContain("策略无效");
  });
  it.each(["COMPLETED", "CANCELLED", "TIMED_OUT"])(
    "supports terminal %s executions without a task deadline requirement",
    (lifecycle) => {
      expect(
        caseRerunBlockReason([{ run: { lifecycle }, executionPolicy: null }]),
      ).toBeNull();
    },
  );
});

it("copies the corrected plan, remaps account provenance and recalculates its hash", async () => {
  const { execution, tx, rerun } = fixture();
  const subject = {
    role: "subject",
    label: "指定用户",
    count: 1,
    usage: "READ_EXISTING",
    rationale: "检查指定用户记录",
    requiredTypes: [],
    constraints: [],
    subjectBinding: {
      kind: "BUSINESS_RECORD",
      target: "用户 ID",
      stepOrders: [1],
      basis: { sourceRef, quote: "指定用户" },
    },
  };
  Object.assign(execution.testCase.definition, {
    accountRequirements: [
      {
        role: "editor",
        label: "LLM 产品编辑账号",
        count: 1,
        usage: "CREATE_OR_MODIFY",
        rationale: "编辑权限",
      },
      subject,
    ],
  });
  Object.assign(execution, {
    testAccountPlan: {
      version: 2,
      revision: "88888888-8888-4888-8888-888888888888",
      requestedAt: new Date().toISOString(),
      definitionHash: specificationDefinitionHash(
        execution.testCase.definition,
      ),
      requirements: [subject],
      bindings: [],
      effectiveAuthRole: "模型编辑员",
      resolution: {
        kind: "REVIEWED_CORRECTION",
        removedRoles: ["editor"],
        reason: "操作身份已分离",
      },
    },
  });
  await rerun();
  const definition =
    tx.taskSpecificationSnapshot.create.mock.calls[0]![0].data.cases.create[0]
      .definition;
  const plan =
    tx.taskCaseExecution.createMany.mock.calls[0]![0].data[0].testAccountPlan;
  const ref =
    tx.taskAnalysisSource.createMany.mock.calls[0]![0].data[0].externalId;
  expect(plan).toMatchObject({
    definitionHash: specificationDefinitionHash(definition),
    effectiveAuthRole: "模型编辑员",
    resolution: { removedRoles: ["editor"] },
    requirements: [{ subjectBinding: { basis: { sourceRef: ref } } }],
  });
  expect(plan.revision).not.toBe("88888888-8888-4888-8888-888888888888");
  expect(
    resolveCaseExecutionDefinition(definition, plan).accountRequirements,
  ).toHaveLength(1);
});
