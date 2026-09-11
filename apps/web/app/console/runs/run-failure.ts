interface ErrorSource {
  error?: unknown;
}

export interface FailureSummary {
  code: string;
  causeCode: string;
  detail: string;
  message: string;
  nextStep: string;
  occurrences: number;
  raw: string;
  signature: string;
}

const reasons: Record<string, [string, string]> = {
  REPEATED_OPERATIONS: [
    "重复操作未产生新的页面观察或验收进展，自动执行已停止。",
    "查看最后几步操作与页面反馈，确认目标控件和前置条件后再重试。",
  ],
  LOCATOR_RECOVERY_EXHAUSTED: [
    "多次重新定位后仍无法找到目标控件，自动执行已停止。",
    "核对当前页面、控件位置和操作步骤后再重试。",
  ],
  TOOL_LIMIT_REACHED: [
    "已达到本次执行的工具调用上限，验收尚未完成。",
    "检查是否存在重复操作，精简步骤或调整执行预算后再重试。",
  ],
  FINALIZATION_RESERVE_REACHED: [
    "剩余执行时间已进入结果保存阶段，未完成的验收已停止。",
    "检查耗时步骤，调整执行时限或拆分用例后再重试。",
  ],
  WRITE_OUTCOME_UNKNOWN: [
    "操作可能已产生业务写入，但写入结果尚未确认，已停止自动重试。",
    "先核对可能受影响的业务数据，再通过恢复记录确认结果。",
  ],
  RUNTIME_LEASE_LOST: [
    "执行节点未能维持任务租约，本次执行已中断。",
    "检查执行节点连接及恢复记录，确认旧会话状态后再重试。",
  ],
  AGENT_RUNTIME_LOST: [
    "执行节点连接中断，未能完成本次验证。",
    "检查执行节点连接及恢复记录后再重试。",
  ],
  BROWSER_SESSION_LOST: [
    "浏览器会话已丢失，无法继续验证。",
    "检查浏览器节点和身份状态，确认旧会话已关闭后再重试。",
  ],
  COMMAND_TIMEOUT: [
    "浏览器操作超过等待时限，未能完成。",
    "查看超时步骤的页面和网络反馈，确认环境可用后再重试。",
  ],
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Recovery wrappers describe why retry is blocked; originalError records why execution stopped. */
export function summarizeTaskFailures(
  tasks: readonly ErrorSource[],
): FailureSummary[] {
  const failures = new Map<string, FailureSummary>();
  for (const task of tasks) {
    if (!task.error) continue;
    const outer = record(task.error);
    let root = task.error;
    for (let depth = 0; depth < 8; depth++) {
      const original = record(record(root).details).originalError;
      if (
        !original ||
        (typeof original !== "string" && !Object.keys(record(original)).length)
      )
        break;
      root = original;
    }
    const error = record(root);
    const detail =
      typeof error.message === "string"
        ? error.message
        : typeof root === "string"
          ? root
          : "未记录具体错误原因。";
    const code =
      typeof outer.code === "string" ? outer.code : "RUNTIME_TASK_FAILED";
    const causeCode = typeof error.code === "string" ? error.code : code;
    const invalidSchema =
      /invalid schema for function|is not a valid format/iu.test(detail);
    const known = reasons[causeCode];
    const message = invalidSchema
      ? "Agent 工具定义与模型接口不兼容，模型请求在执行浏览器命令前被拒绝。"
      : (known?.[0] ??
        (/^fetch failed$/iu.test(detail.trim())
          ? "执行请求失败（fetch failed），当前记录未提供更具体的连接失败原因。"
          : detail.split(/\r?\n/u)[0]!.slice(0, 800)));
    const signature = `${code}:${causeCode}:${detail}`;
    const existing = failures.get(signature);
    if (existing) {
      existing.occurrences++;
      continue;
    }
    failures.set(signature, {
      code,
      causeCode,
      detail,
      message,
      nextStep: invalidSchema
        ? "检查 Agent 工具定义与模型接口的兼容性，修复后再重试。"
        : (known?.[1] ?? "查看失败步骤和技术详情，确认原因后再重试。"),
      occurrences: 1,
      raw: JSON.stringify(task.error, null, 2),
      signature,
    });
  }
  return [...failures.values()];
}

export function currentRunFailures(
  detail: {
    currentAttemptNumber: number;
    attempts: Array<ErrorSource & { id: string; number: number }>;
    tasks: Array<ErrorSource & { attemptId: string }>;
    browserExecutions?: Array<ErrorSource & { attemptId: string }>;
  },
  attemptId = detail.attempts.find(
    (item) => item.number === detail.currentAttemptNumber,
  )?.id,
) {
  if (!attemptId) return [];
  return summarizeTaskFailures([
    ...detail.attempts.filter((item) => item.id === attemptId),
    ...detail.tasks.filter((item) => item.attemptId === attemptId).reverse(),
    ...(detail.browserExecutions ?? [])
      .filter((item) => item.attemptId === attemptId)
      .reverse(),
  ]);
}
