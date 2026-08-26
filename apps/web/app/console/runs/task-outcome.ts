import { displayLabel } from "../../../lib/display-text";

interface TaskOutcomeSource {
  executionDisposition: string | null;
  lifecycle: string;
  verdict: string | null;
}

export interface TaskOutcomeDisplay {
  description: string | null;
  label: string;
  toneStatus: string;
}

export function verificationVerdictLabel(verdict: string | null) {
  if (verdict === "PASSED") return "验证通过";
  if (verdict === "FAILED") return "验证未通过";
  if (verdict === "INCONCLUSIVE") return "验证结果不确定";
  return "尚无验证判定";
}

export function executionDispositionLabel(disposition: string | null) {
  if (disposition === "EXECUTED") return "任务执行成功";
  if (disposition) return `任务执行失败（${displayLabel(disposition)}）`;
  return "尚无执行结果";
}

export function taskOutcomeDisplay(
  task: TaskOutcomeSource,
): TaskOutcomeDisplay {
  if (task.lifecycle === "CANCELLED") {
    return {
      description: null,
      label: "任务已取消",
      toneStatus: task.lifecycle,
    };
  }
  if (task.lifecycle === "TIMED_OUT") {
    return {
      description: "任务执行超过时限，未得到验证判定。",
      label: "任务执行超时",
      toneStatus: task.lifecycle,
    };
  }
  if (task.lifecycle === "WAITING_HUMAN") {
    return {
      description: null,
      label: "等待人工操作",
      toneStatus: task.lifecycle,
    };
  }
  if (task.verdict) {
    return {
      description:
        task.verdict === "FAILED"
          ? "任务已执行完成，但至少一项验收标准未通过。"
          : null,
      label: verificationVerdictLabel(task.verdict),
      toneStatus: task.verdict,
    };
  }
  if (task.executionDisposition && task.executionDisposition !== "EXECUTED") {
    return {
      description: `未得到验证判定：${displayLabel(task.executionDisposition)}。`,
      label: "任务执行失败",
      toneStatus: task.executionDisposition,
    };
  }
  if (task.executionDisposition === "EXECUTED") {
    return {
      description: "任务已执行完成，尚无验证判定。",
      label: "任务执行完成",
      toneStatus: task.executionDisposition,
    };
  }
  return {
    description: null,
    label: displayLabel(task.lifecycle),
    toneStatus: task.lifecycle,
  };
}
