import { describe, expect, it, vi } from "vitest";
import { TaskExecutionService } from "./task-execution.service.js";
import { TaskExecutionConsoleController } from "./task-execution-console.controller.js";
import { TaskExecutionController } from "./task-execution.controller.js";
import {
  unassignedTestAccountPlan,
  accountsReady,
} from "./task-test-accounts.js";

const current = {
  team: { id: "team", name: "Team" },
  credential: { id: "credential", name: "test", scopes: ["run:write"] },
} as never;
const request = { idempotencyKey: "in-place-request" };

function fixture() {
  const original = {
    id: "old-execution",
    caseId: "case",
    deploymentId: "deployment",
    executionOrdinal: 1,
    runId: "old-run",
    run: { lifecycle: "COMPLETED", tasks: [{ recoveryStatus: "RESOLVED" }] },
    testCase: { snapshotId: "spec", position: 0 },
    executionPolicy: { accessMode: "READ_ONLY" },
  };
  const task = {
    id: "task",
    kind: "ISSUE_SPEC",
    lifecycle: "TIMED_OUT",
    cancelRequestedAt: null,
    deadlineAt: new Date("2020-01-01"),
    finishedAt: new Date("2020-01-01"),
    inputSnapshot: {
      kind: "ISSUE_SPEC",
      issueRef: "ENG-123",
      idempotencyKey: "original-task",
      deadlineSeconds: 3600,
    },
    caseExecutions: [original],
    specificationSnapshots: [{ id: "spec" }],
    stages: [{ id: "execution-stage", type: "SPEC_EXECUTION" }],
  };
  const events: Array<{ payload: Record<string, unknown> }> = [];
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    taskExecution: {
      findFirst: vi.fn(async () => task),
      create: vi.fn(),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(task, data);
        return { count: 1 };
      }),
    },
    taskCaseExecution: {
      create: vi.fn(async ({ data }) => {
        const row = {
          ...data,
          id: `execution-${data.executionOrdinal}`,
          run: null,
          runId: null,
          testCase: original.testCase,
        };
        task.caseExecutions.push(row);
        return row;
      }),
    },
    browserRuntimeSession: { count: vi.fn().mockResolvedValue(0) },
    taskExecutionStage: { update: vi.fn() },
    taskSpecificationSnapshot: { create: vi.fn() },
    taskExecutionEvent: {
      findFirst: vi.fn(
        async ({ where }) =>
          events.find(
            (event) => event.payload.idempotencyKey === where.payload.equals,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }) => {
        events.push(data);
        return data;
      }),
    },
  };
  const service = new TaskExecutionService(
    {
      $transaction: (callback: (tx: unknown) => unknown) => callback(tx),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  vi.spyOn(
    service as never as {
      dispatchPendingForTask: (id: string) => Promise<void>;
    },
    "dispatchPendingForTask",
  ).mockResolvedValue(undefined);
  vi.spyOn(service, "detail").mockResolvedValue({ id: "task" } as never);
  return { service, task, original, tx, events };
}

describe("Case reruns within the original task", () => {
  it("starts account preparation with empty assignments only when explicitly requested", async () => {
    const { service, task, original, tx, events } = fixture();
    const definition = {
      authRole: "operator",
      accountRequirementsVersion: 2,
      accountRequirements: [
        {
          role: "subject",
          label: "新增账号",
          count: 1,
          usage: "CREATE_OR_MODIFY",
          requiredTypes: ["TYPE_A"],
          constraints: ["目标记录不存在"],
          rationale: "验证新增",
        },
      ],
    };
    const previous = unassignedTestAccountPlan(definition, 3600, new Date());
    Object.assign(previous, {
      bindings: [
        {
          slotId: "subject:1",
          role: "subject",
          account: "original@example.test",
          usage: "CREATE_OR_MODIFY",
          requiredTypes: ["TYPE_A"],
        },
      ],
    });
    Object.assign(original.testCase, { definition });
    Object.assign(original, { testAccountPlan: previous });
    const saved = structuredClone(previous);
    const retry = { ...request, reuseTestAccounts: false };
    await service.rerunCase(current, "task", "case", undefined, retry);
    const data = tx.taskCaseExecution.create.mock.calls[0]![0].data;
    expect(data.testAccountPlan).toMatchObject({
      version: 2,
      bindings: [],
      requirements: previous.requirements,
    });
    expect(data.testAccountPlan.revision).not.toBe(previous.revision);
    expect(accountsReady(data.testAccountPlan, definition)).toBe(false);
    expect(previous).toEqual(saved);
    expect(events[0]!.payload.reuseTestAccounts).toBe(false);
    await service.rerunCase(current, "task", "case", undefined, retry);
    expect(task.caseExecutions).toHaveLength(2);
    await expect(
      service.rerunCase(current, "task", "case", undefined, request),
    ).rejects.toThrow("账号准备方式已确定");
  });
  it("renews an expired deadline and appends an execution without recreating the task or Spec", async () => {
    const { service, task, tx, original, events } = fixture();
    const before = Date.now();
    expect(
      await service.rerunCase(current, "task", "case", undefined, request),
    ).toEqual({ id: "task" });
    expect(task).toMatchObject({ lifecycle: "RUNNING", finishedAt: null });
    expect(task.deadlineAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    expect(task.caseExecutions).toHaveLength(2);
    expect(task.caseExecutions[0]).toBe(original);
    expect(task.caseExecutions[1]).toMatchObject({
      taskExecutionId: "task",
      caseId: "case",
      executionOrdinal: 2,
      run: null,
    });
    expect(tx.taskExecution.create).not.toHaveBeenCalled();
    expect(tx.taskSpecificationSnapshot.create).not.toHaveBeenCalled();
    expect(
      tx.taskCaseExecution.create.mock.calls[0]![0].data,
    ).not.toHaveProperty("testAccountPlan");
    expect(events[0]!.payload).toMatchObject({
      previousCaseExecutionId: "old-execution",
      idempotencyKey: request.idempotencyKey,
    });
  });

  it("does not shorten an active task's existing time budget", async () => {
    const { service, task } = fixture();
    const later = new Date(Date.now() + 7200_000);
    task.deadlineAt = later;
    await service.rerunCase(current, "task", "case", undefined, request);
    expect(task.deadlineAt).toEqual(later);
  });

  it("replays an acknowledged request after response loss without adding another execution", async () => {
    const { service, task, tx } = fixture();
    await service.rerunCase(current, "task", "case", undefined, request);
    await service.rerunCase(current, "task", "case", undefined, request);
    expect(task.caseExecutions).toHaveLength(2);
    expect(tx.taskCaseExecution.create).toHaveBeenCalledOnce();
    expect(tx.taskExecution.updateMany).toHaveBeenCalledOnce();
  });

  it("rejects reuse of a request key for another Case or environment", async () => {
    const { service, tx } = fixture();
    await service.rerunCase(current, "task", "case", undefined, request);
    await expect(
      service.rerunCase(current, "task", "other-case", undefined, request),
    ).rejects.toThrow("其他用例或环境");
    await expect(
      service.rerunCase(current, "task", "case", "other-deployment", request),
    ).rejects.toThrow("其他用例或环境");
    expect(tx.taskCaseExecution.create).toHaveBeenCalledOnce();
  });

  it.each(["active", "unknown-write", "unclosed", "old-spec", "cancelled"])(
    "does not append an execution when %s",
    async (condition) => {
      const { service, original, task, tx } = fixture();
      if (condition === "active") original.run.lifecycle = "RUNNING";
      if (condition === "unknown-write")
        original.run.tasks[0]!.recoveryStatus = "WRITE_OUTCOME_UNKNOWN";
      if (condition === "unclosed")
        tx.browserRuntimeSession.count.mockResolvedValue(1);
      if (condition === "old-spec") original.testCase.snapshotId = "old-spec";
      if (condition === "cancelled")
        Object.assign(task, { cancelRequestedAt: new Date() });
      await expect(
        service.rerunCase(current, "task", "case", undefined, request),
      ).rejects.toThrow();
      expect(tx.taskCaseExecution.create).not.toHaveBeenCalled();
      expect(tx.taskExecution.updateMany).not.toHaveBeenCalled();
    },
  );

  it("routes both current and legacy Console/Tool endpoints to the same in-place operation", async () => {
    const tasks = { rerunCase: vi.fn(), rerunCaseAsTask: vi.fn() };
    const consoleController = new TaskExecutionConsoleController(
      tasks as never,
    );
    const toolController = new TaskExecutionController(tasks as never);
    const auth = {
      team: { id: "team", name: "Team" },
      user: { id: "user", name: "User" },
    } as never;
    consoleController.rerunCase(auth, "task", "case", request);
    consoleController.rerunCaseAsTask(auth, "task", "case", request);
    toolController.rerunCase(current, "task", "case", request);
    toolController.rerunCaseAsTask(current, "task", "case", request);
    expect(tasks.rerunCase).toHaveBeenCalledTimes(4);
    for (const call of tasks.rerunCase.mock.calls)
      expect(call.slice(1)).toEqual(["task", "case", undefined, request]);
    expect(tasks.rerunCaseAsTask).not.toHaveBeenCalled();
  });
});
