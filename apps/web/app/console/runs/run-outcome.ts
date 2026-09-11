import { displayLabel } from "../../../lib/display-text";

interface RunOutcome {
  description: string;
  label: string;
  title: string;
  tone: "neutral" | "info" | "warning" | "danger" | "success";
  reasonCode?: string | undefined;
  nextStep?: string | undefined;
}

export function runOutcome(
  detail: { lifecycle: string; verdict: string | null },
  executionDisposition: string | null,
  failures: { message: string; causeCode?: string; nextStep?: string }[],
  criteria: {
    status: string | null;
    summary?: string | null;
    description: string;
  }[],
): RunOutcome {
  const cause = failures[0];
  if (detail.lifecycle === "QUEUED") {
    return {
      description: "等待执行资源或前置条件满足，浏览器尚未开始验证。",
      label: "排队中",
      title: "等待开始验证",
      tone: "neutral" as const,
    };
  }
  if (detail.lifecycle === "PREPARING") {
    return {
      description: "正在准备浏览器与执行环境，尚未得到验收结论。",
      label: "准备执行",
      title: "正在准备验证",
      tone: "info" as const,
    };
  }
  if (detail.lifecycle === "RUNNING") {
    return {
      description: "浏览器正在执行验收步骤，页面会自动刷新最新进度。",
      label: "执行中",
      title: "正在验证",
      tone: "info" as const,
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
      reasonCode: cause?.causeCode,
      nextStep: cause?.nextStep ?? "检查耗时步骤与执行时限后再重试。",
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
  if (executionDisposition === "BLOCKED") {
    return {
      description:
        cause?.message ??
        "本次执行被阻塞，未得到可信的验收结论；当前记录未提供具体中断原因。",
      label: "执行受阻",
      title: "执行已中断，验证未完成",
      tone: "warning",
      reasonCode: cause?.causeCode,
      nextStep:
        "查看阻塞信息；如有待核对的业务写入，先确认实际结果，再决定是否重试。",
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
      nextStep: "查看未通过标准及其证据，确认与预期的差异后处理。",
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
      title: "执行失败，未得到验证结论",
      reasonCode: cause?.causeCode,
      nextStep: cause?.nextStep ?? "检查执行节点和失败步骤，处理异常后再重试。",
      tone: "danger" as const,
    };
  }
  if (detail.verdict === "INCONCLUSIVE") {
    const incomplete = criteria.find((item) => item.status === "INCONCLUSIVE");
    return {
      description:
        cause?.message ||
        incomplete?.summary ||
        "现有证据不足，尚不能确认所有必需验收标准是否满足。",
      label: "结果不确定",
      title: "未得到确定的验证结论",
      tone: "warning",
      reasonCode: cause?.causeCode,
      nextStep:
        cause?.nextStep ?? "查看未确认的验收标准，补充缺失条件或证据后再验证。",
    };
  }
  if (executionDisposition === "NOT_RUN") {
    return {
      description: cause?.message ?? "验证未开始，当前记录未提供具体原因。",
      label: "未执行",
      title: "验证尚未执行",
      tone: "warning",
      reasonCode: cause?.causeCode,
      nextStep:
        cause?.nextStep ?? "查看准备阶段与调度记录，补齐执行条件后重试。",
    };
  }
  return {
    description:
      cause?.message ??
      "执行已结束，但没有保存验证判定；请查看验收记录和技术详情。",
    reasonCode: cause?.causeCode,
    nextStep: cause?.nextStep,
    label: displayLabel(
      detail.verdict ?? executionDisposition ?? detail.lifecycle,
    ),
    title: "执行已结束，尚无验证结论",
    tone: "neutral" as const,
  };
}
