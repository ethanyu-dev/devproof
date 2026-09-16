import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "./task-types";
import { CaseRetryRequest, type CaseRetryPlan } from "./case-retry";

const recoveryId = "447f00c6-5f60-4c54-9d9a-4a0f137a5e63";
const recovery = {
  id: recoveryId,
  version: 3,
  closureState: "VERIFIED",
  writeOutcomeState: "UNKNOWN",
  resolvedAt: null,
};

function harness(needsReview = false) {
  const task = {
    id: "task-1",
    deployments: [{ id: "deployment", enabled: true }],
    cases: [
      {
        id: "case-1",
        name: "创建白名单",
        rerunBlockReason: needsReview
          ? "上次执行的业务写入结果尚未确认，请先核对。"
          : null,
        executions: [
          {
            id: "case-execution",
            deployment: { id: "deployment" },
            executionOrdinal: 1,
            run: { runId: "run-1", lifecycle: "COMPLETED" },
          },
        ],
      },
    ],
  } as unknown as TaskDetail;
  const api = vi.fn(
    async (path: string, init?: RequestInit): Promise<unknown> => {
      if (path === "/tasks/task-1" && !init) return task;
      if (path === "/runs/run-1" && !init)
        return { recoveries: needsReview ? [recovery] : [] };
      if (path === `/runtime-recoveries/${recoveryId}` && !init)
        return recovery;
      if (path.endsWith("/authorize-retry"))
        return { ...recovery, writeOutcomeState: "RETRY_AUTHORIZED" };
      if (path.endsWith("/rerun")) return { id: "task-1" };
      throw new Error(`Unexpected request: ${path}`);
    },
  );
  const request = new CaseRetryRequest(api as never);
  return { api, task, request };
}

describe("manual Case retry", () => {
  it("exposes the current case's account constraints before another retry", async () => {
    const { task, request, api } = harness();
    task.testAccountPreparation = {
      revision: "revision",
      missingCount: 0,
      totalCount: 1,
      cases: [
        {
          caseExecutionId: "case-execution",
          caseName: "新增",
          started: true,
          deployment: { name: "测试", targetUrl: "https://example.test" },
          slots: [
            {
              label: "新增账号",
              constraints: ["不存在目标类型白名单"],
              account: "assigned",
            },
          ],
        },
        {
          caseExecutionId: "other-case",
          slots: [{ label: "无关账号", constraints: ["无关条件"] }],
        },
      ],
    } as unknown as NonNullable<TaskDetail["testAccountPreparation"]>;
    const plan = await request.prepare("task-1", "run-1");
    expect(plan.preparationConditions).toEqual([
      "新增账号：不存在目标类型白名单",
    ]);
    expect(plan.hasTestAccounts).toBe(true);
    expect(api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    await request.submit(plan, false, false);
    expect(
      JSON.parse(api.mock.lastCall![1]!.body as string).reuseTestAccounts,
    ).toBe(false);
  });
  it("retries a finished Case without regenerating its Spec", async () => {
    const { api, request } = harness();
    const plan = await request.prepare("task-1", "run-1");
    expect(plan).toMatchObject({
      caseId: "case-1",
      recoveries: [],
      blockedReason: null,
    });
    expect(api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    expect(await request.submit(plan)).toMatchObject({ id: "task-1" });
    expect(api.mock.lastCall?.[0]).toBe("/tasks/task-1/cases/case-1/rerun");
  });

  it("keeps unknown writes pending until explicit retry confirmation, without claiming a verified write", async () => {
    const { api, request } = harness(true);
    const plan = await request.prepare("task-1", "run-1");
    expect(plan.blockedReason).toBeNull();
    await expect(request.submit(plan)).rejects.toThrow("请确认");
    expect(api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    await request.submit(plan, true);
    const writes = api.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes.map(([path]) => path)).toEqual([
      `/runtime-recoveries/${recoveryId}/authorize-retry`,
      "/tasks/task-1/cases/case-1/rerun",
    ]);
    const authorization = JSON.parse(writes[0]![1]!.body as string);
    expect(authorization).not.toHaveProperty("outcome");
    expect(authorization).not.toHaveProperty("evidenceRefs");
    expect(authorization).not.toHaveProperty("note");
    expect(authorization).toMatchObject({
      acknowledgeUnknownWrite: true,
      expectedVersion: 3,
    });
  });

  it("does not create a retry if authorization is rejected or its version changed", async () => {
    const { api, request } = harness(true);
    const plan = await request.prepare("task-1", "run-1");
    api.mockRejectedValueOnce(
      new Error("Recovery changed. Refresh before resolving."),
    );
    await expect(request.submit(plan, true)).rejects.toThrow(
      "Recovery changed",
    );
    expect(api.mock.calls.some(([path]) => path.endsWith("/rerun"))).toBe(
      false,
    );
  });

  it("preserves request keys after an uncertain retry response", async () => {
    const { api, request } = harness();
    const plan = await request.prepare("task-1", "run-1");
    api.mockRejectedValueOnce(new Error("response timeout"));
    await expect(request.submit(plan)).rejects.toThrow("timeout");
    await request.submit(plan);
    const calls = api.mock.calls.filter(([path]) => path.endsWith("/rerun"));
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]!.body).toBe(calls[1]![1]!.body);
  });

  it("preserves authorization keys and versions across a partial submission failure", async () => {
    const { api, request } = harness(true);
    const plan = await request.prepare("task-1", "run-1");
    api
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("retry response lost"));
    await expect(request.submit(plan, true)).rejects.toThrow("lost");
    await request.submit(plan, true);
    const calls = api.mock.calls.filter(([path]) =>
      path.endsWith("/authorize-retry"),
    );
    expect(calls[0]![1]!.body).toBe(calls[1]![1]!.body);
  });

  it("blocks active latest executions even when opening an older failed run", async () => {
    const { task, api, request } = harness();
    const original = task.cases[0]!.executions[0]!;
    task.cases[0]!.executions.push({
      ...original,
      executionOrdinal: 2,
      run: { ...original.run!, lifecycle: "RUNNING", runId: "new-run" },
    });
    const plan = await request.prepare("task-1", "run-1");
    expect(plan.blockedReason).toContain("仍在执行");
    await expect(request.submit(plan)).rejects.toThrow("仍在执行");
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("requires verified browser closure before authorization or retry", async () => {
    const { api, request } = harness(true);
    const plan = await request.prepare("task-1", "run-1");
    const unclosed: CaseRetryPlan = {
      ...plan,
      recoveries: [{ ...plan.recoveries[0]!, closureState: "CLOSING" }],
    };
    await expect(request.submit(unclosed, true)).rejects.toThrow(
      "尚未确认关闭",
    );
    expect(api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("validates every browser closure before authorizing any recovery", async () => {
    const { api, request } = harness(true);
    const plan = await request.prepare("task-1", "run-1");
    plan.recoveries.push({
      ...plan.recoveries[0]!,
      id: "cd1b3f0e-8a19-49a7-86fb-bd2f196f3f09",
      closureState: "CLOSING",
    });
    await expect(request.submit(plan, true)).rejects.toThrow("尚未确认关闭");
    expect(api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
});
