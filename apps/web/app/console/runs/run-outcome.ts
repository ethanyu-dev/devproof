import { displayLabel } from "../../../lib/display-text";

export function runOutcome(
  detail: { lifecycle: string; verdict: string | null },
  executionDisposition: string | null,
  failures: { message: string }[],
  criteria: {
    status: string | null;
    summary?: string | null;
    description: string;
  }[],
) {
  if (detail.lifecycle === "QUEUED") {
    return {
      description: "等待执行资源或前置条件满足，浏览器尚未开始验证。",
      label: "排队中",
      title: "等待开始验证",
      tone: "warning" as const,
    };
  }
  if (detail.lifecycle === "PREPARING") {
    return {
      description: "正在准备浏览器与执行环境，尚未得到验收结论。",
      label: "准备执行",
      title: "正在准备验证",
      tone: "warning" as const,
    };
  }
  if (detail.lifecycle === "RUNNING") {
    return {
      description: "浏览器正在执行验收步骤，页面会自动刷新最新进度。",
      label: "执行中",
      title: "正在验证",
      tone: "warning" as const,
    };
  }
  if (detail.lifecycle === "WAITING_HUMAN") {
    return {
      description: "自动化需要登录、验证码或其他人工操作，完成后会继续执行。",
      label: "需要处理",
      title: "等待人工继续",
      tone: "warning" as const,
    };
  }
  if (detail.lifecycle === "CANCELLED") {
    return {
      description: "任务已取消，现有证据和操作记录仍可查看。",
      label: "已取消",
      title: "验证没有完成",
      tone: "neutral" as const,
    };
  }
  if (detail.lifecycle === "TIMED_OUT") {
    return {
      description:
        failures[0]?.message ?? "任务超过执行时限，请检查运行记录后重试。",
      label: "已超时",
      title: "验证超时",
      tone: "danger" as const,
    };
  }
  if (detail.lifecycle !== "COMPLETED") {
    return {
      description: "尚未识别当前运行状态，请刷新查看最新进度。",
      label: "状态待确认",
      title: "验证状态待确认",
      tone: "neutral" as const,
    };
  }
  if (detail.verdict === "PASSED") {
    return {
      description: "所有必需验收标准均已通过，完整操作过程已留存。",
      label: "已通过",
      title: "验证通过",
      tone: "success" as const,
    };
  }
  if (detail.verdict === "FAILED") {
    const failedCriterion = criteria.find(
      (criterion) => criterion.status === "FAILED",
    );
    return {
      description:
        failedCriterion?.summary ||
        failedCriterion?.description ||
        failures[0]?.message ||
        "至少一项必需验收标准未通过。",
      label: "未通过",
      title: "验证未通过",
      tone: "danger" as const,
    };
  }
  if (
    executionDisposition &&
    [
      "AGENT_ERROR",
      "PROVIDER_ERROR",
      "BROWSER_UNAVAILABLE",
      "RUNTIME_LOST",
    ].includes(executionDisposition)
  ) {
    return {
      description:
        failures[0]?.message ?? "执行环境异常，尚未得到可信的验收结论。",
      label: "执行异常",
      title: "暂时无法得出结论",
      tone: "danger" as const,
    };
  }
  return {
    description: "任务已结束，请结合验收标准和证据确认结果。",
    label: displayLabel(
      detail.verdict ?? executionDisposition ?? detail.lifecycle,
    ),
    title: "验证已完成",
    tone: "neutral" as const,
  };
}
