import {
  runtimeRecoveryAuthorizeRetrySchema,
  type RuntimeRecoveryDetail,
} from "@devproof/contracts";
import type { TaskDetail } from "./task-types";
import { latestTaskCaseExecutions } from "./task-case-display";

type RetryApi = <T>(path: string, init?: RequestInit) => Promise<T>;
type Recovery = Pick<
  RuntimeRecoveryDetail,
  "id" | "closureState" | "writeOutcomeState" | "resolvedAt"
>;
export interface CaseRetryPlan {
  taskId: string;
  caseId: string;
  name: string;
  blockedReason: string | null;
  recoveries: RuntimeRecoveryDetail[];
  preparationConditions?: string[];
  hasTestAccounts?: boolean;
}

/** Keep request keys after transport failures: either write may have committed. */
export class CaseRetryRequest {
  private readonly keys = new Map<string, string>();
  constructor(private readonly api: RetryApi) {}

  private key(scope: string) {
    let key = this.keys.get(scope);
    if (!key) {
      key = crypto.randomUUID();
      this.keys.set(scope, key);
    }
    return key;
  }

  async prepare(taskId: string, runId: string): Promise<CaseRetryPlan> {
    const task = await this.api<TaskDetail>(
      `/tasks/${encodeURIComponent(taskId)}`,
    );
    const testCase = task.cases.find((item) =>
      item.executions.some((execution) => execution.run?.runId === runId),
    );
    if (!testCase)
      throw new Error("未找到这个执行对应的用例，请返回任务详情重试。");
    const executions = latestTaskCaseExecutions(testCase.executions).filter(
      (execution) =>
        task.deployments.some(
          (deployment) =>
            deployment.enabled && deployment.id === execution.deployment.id,
        ),
    );
    const plan: CaseRetryPlan = {
      taskId,
      caseId: testCase.id,
      name: testCase.name,
      recoveries: [],
      blockedReason: null,
      hasTestAccounts: (task.testAccountPreparation?.cases ?? []).some(
        (item) =>
          item.slots.length > 0 &&
          executions.some((execution) => execution.id === item.caseExecutionId),
      ),
      preparationConditions: [
        ...new Set(
          (task.testAccountPreparation?.cases ?? [])
            .filter((item) =>
              executions.some(
                (execution) => execution.id === item.caseExecutionId,
              ),
            )
            .flatMap((item) =>
              item.slots.flatMap((slot) =>
                slot.constraints.map(
                  (condition) => `${slot.label}：${condition}`,
                ),
              ),
            ),
        ),
      ],
    };
    if (
      !executions.length ||
      executions.some(
        (execution) =>
          !execution.run ||
          !["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(
            execution.run.lifecycle,
          ),
      )
    )
      return {
        ...plan,
        blockedReason: "用例仍在执行或尚未创建执行记录，请等待结束后重试。",
      };
    const runs = await Promise.all(
      executions.map((execution) =>
        this.api<{ recoveries?: Recovery[] }>(
          `/runs/${encodeURIComponent(execution.run!.runId)}`,
        ),
      ),
    );
    const pending = new Map(
      runs
        .flatMap((run) =>
          (run.recoveries ?? []).filter(
            (recovery) =>
              !recovery.resolvedAt &&
              (recovery.closureState !== "VERIFIED" ||
                ["UNKNOWN", "UNASSESSED"].includes(recovery.writeOutcomeState)),
          ),
        )
        .map((recovery) => [recovery.id, recovery]),
    );
    plan.recoveries = await Promise.all(
      [...pending.keys()].map((id) =>
        this.api<RuntimeRecoveryDetail>(
          `/runtime-recoveries/${encodeURIComponent(id)}`,
        ),
      ),
    );
    plan.recoveries = plan.recoveries.filter(
      (recovery) =>
        !recovery.resolvedAt &&
        (recovery.closureState !== "VERIFIED" ||
          ["UNKNOWN", "UNASSESSED"].includes(recovery.writeOutcomeState)),
    );
    if (
      plan.recoveries.some((recovery) => recovery.closureState !== "VERIFIED")
    )
      plan.blockedReason =
        "旧浏览器会话尚未确认关闭。请先处理下方恢复记录，再重试用例。";
    else if (!plan.recoveries.length && testCase.rerunBlockReason)
      plan.blockedReason = testCase.rerunBlockReason;
    return plan;
  }

  async submit(
    plan: CaseRetryPlan,
    acknowledgeUnknownWrite = false,
    reuseTestAccounts = true,
  ) {
    if (plan.blockedReason) throw new Error(plan.blockedReason);
    // A retry authorization is an explicit user decision, never a fabricated
    // NO_WRITE attestation. Validate every recovery before writing any of them.
    const authorizations = plan.recoveries.map((recovery) => {
      if (recovery.closureState !== "VERIFIED")
        throw new Error("旧浏览器会话尚未确认关闭。");
      if (!acknowledgeUnknownWrite)
        throw new Error("请确认在上次写入结果未核实的情况下重试。");
      const body = runtimeRecoveryAuthorizeRetrySchema.parse({
        acknowledgeUnknownWrite,
        expectedVersion: recovery.version,
        idempotencyKey: this.key(
          `authorize:${recovery.id}:${recovery.version}`,
        ),
      });
      return { id: recovery.id, body };
    });
    for (const authorization of authorizations)
      await this.api(
        `/runtime-recoveries/${encodeURIComponent(authorization.id)}/authorize-retry`,
        { method: "POST", body: JSON.stringify(authorization.body) },
      );
    const task = await this.api<TaskDetail>(
      `/tasks/${encodeURIComponent(plan.taskId)}/cases/${encodeURIComponent(plan.caseId)}/rerun`,
      {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: this.key(`retry:${plan.taskId}:${plan.caseId}`),
          ...(!reuseTestAccounts ? { reuseTestAccounts: false } : {}),
        }),
      },
    );
    this.keys.delete(`retry:${plan.taskId}:${plan.caseId}`);
    return task;
  }
}
