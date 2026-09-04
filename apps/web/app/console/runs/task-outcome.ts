import type { TaskCaseExecution, TaskScheduling } from "./task-types";
import { displayLabel } from "../../../lib/display-text";

interface TaskOutcomeSource {
  scheduling?: { state: string; reason: string | null };
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
  if (
    ["QUEUED", "PREPARING", "RUNNING"].includes(task.lifecycle) &&
    isSchedulingWait(task.scheduling)
  ) {
    return {
      description: task.scheduling?.reason
        ? displayLabel(task.scheduling.reason)
        : null,
      label:
        task.scheduling?.state === "RECOVERING"
          ? "执行恢复中"
          : displayLabel(task.scheduling?.reason ?? "WAITING"),
      toneStatus:
        task.scheduling?.state === "RECOVERING" ? "RUNNING" : "PENDING",
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

export function isSchedulingWait(scheduling?: { state: string } | null) {
  return ["WAITING", "ADMITTED", "RECOVERING"].includes(
    scheduling?.state ?? "",
  );
}

export function executionSchedulingLabel(execution: TaskCaseExecution) {
  if (
    execution.run &&
    ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(execution.run.lifecycle)
  )
    return taskOutcomeDisplay(execution.run).label;
  if (execution.run?.lifecycle === "WAITING_HUMAN") return "等待人工操作";
  const scheduling = execution.scheduling;
  if (scheduling?.state === "RECOVERING") return "执行恢复中";
  if (isSchedulingWait(scheduling))
    return displayLabel(scheduling?.reason ?? "WAITING");
  if (scheduling?.state === "TERMINAL")
    return displayLabel(scheduling.reason ?? "TERMINAL");
  return execution.run
    ? taskOutcomeDisplay(execution.run).label
    : displayLabel(execution.dispatch.status);
}

export function schedulingWaitText(
  scheduling: TaskScheduling | undefined,
  now = Date.now(),
) {
  if (!scheduling || !isSchedulingWait(scheduling)) return null;
  const since = scheduling.waitingSince
    ? Date.parse(scheduling.waitingSince)
    : NaN;
  const seconds = Number.isFinite(since)
    ? Math.max(0, Math.floor((now - since) / 1000))
    : null;
  const label = displayLabel(scheduling.reason ?? scheduling.state);
  return seconds === null
    ? label
    : `${label} · 已等待 ${seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`}`;
}
