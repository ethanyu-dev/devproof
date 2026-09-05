import { describe, expect, it } from "vitest";
import type { TaskCaseExecution, TaskScheduling } from "./task-types";

import {
  executionDispositionLabel,
  executionSchedulingLabel,
  schedulingWaitText,
  taskOutcomeDisplay,
  verificationVerdictLabel,
} from "./task-outcome";

describe("taskOutcomeDisplay", () => {
  it("explains a nonterminal task with no active execution", () => {
    expect(
      taskOutcomeDisplay({
        lifecycle: "RUNNING",
        verdict: null,
        executionDisposition: null,
        scheduling: { state: "WAITING", reason: "PROFILE_RESERVED" },
      }),
    ).toMatchObject({ label: "等待浏览器身份", toneStatus: "PENDING" });
    expect(
      taskOutcomeDisplay({
        lifecycle: "RUNNING",
        verdict: null,
        executionDisposition: null,
        scheduling: { state: "RECOVERING", reason: "LEASE_RECOVERY" },
      }),
    ).toMatchObject({ label: "执行恢复中", toneStatus: "RUNNING" });
  });
  it("explains admitted Agent capacity waiting at Task, Case, and elapsed-time levels", () => {
    const scheduling: TaskScheduling = {
      state: "ADMITTED",
      reason: "AGENT_CAPACITY",
      waitingSince: "2026-09-04T01:00:00Z",
      evaluatedAt: "2026-09-04T01:02:00Z",
      blockedBy: null,
      queue: null,
      nextRetryAt: null,
    };
    const run = {
      lifecycle: "PREPARING",
      verdict: null,
      executionDisposition: null,
    };
    expect(taskOutcomeDisplay({ ...run, scheduling })).toMatchObject({
      label: "等待 Agent",
      toneStatus: "PENDING",
    });
    expect(
      executionSchedulingLabel({
        scheduling,
        run,
        dispatch: { status: "LINKED" },
      } as TaskCaseExecution),
    ).toBe("等待 Agent");
    expect(
      schedulingWaitText(scheduling, Date.parse("2026-09-04T01:02:00Z")),
    ).toBe("等待 Agent · 已等待 2 分钟");
    expect(schedulingWaitText({ ...scheduling, state: "RUNNING" })).toBeNull();
    expect(
      taskOutcomeDisplay({ ...run, lifecycle: "TIMED_OUT", scheduling }),
    ).toMatchObject({ label: "任务执行超时" });
  });

  it("identifies a completed execution whose verification did not pass", () => {
    expect(
      taskOutcomeDisplay({
        executionDisposition: "EXECUTED",
        lifecycle: "COMPLETED",
        verdict: "FAILED",
      }),
    ).toMatchObject({ label: "验证未通过", toneStatus: "FAILED" });
  });

  it("identifies an execution failure without presenting it as a verdict", () => {
    expect(
      taskOutcomeDisplay({
        executionDisposition: "AGENT_ERROR",
        lifecycle: "COMPLETED",
        verdict: null,
      }),
    ).toEqual({
      description: "未得到验证判定：Agent 异常。",
      label: "任务执行失败",
      toneStatus: "AGENT_ERROR",
    });
  });

  it("keeps terminal lifecycle states more specific than failure", () => {
    expect(
      taskOutcomeDisplay({
        executionDisposition: "BLOCKED",
        lifecycle: "TIMED_OUT",
        verdict: null,
      }),
    ).toMatchObject({ label: "任务执行超时", toneStatus: "TIMED_OUT" });
  });
});

describe("task outcome dimension labels", () => {
  it("uses explicit execution and verification wording", () => {
    expect(executionDispositionLabel("EXECUTED")).toBe("任务执行成功");
    expect(executionDispositionLabel("PROVIDER_ERROR")).toBe(
      "任务执行失败（模型服务异常）",
    );
    expect(verificationVerdictLabel("FAILED")).toBe("验证未通过");
    expect(verificationVerdictLabel(null)).toBe("尚无验证判定");
  });
});

it("explains the recovery behind a queued identity holder", () => {
  expect(
    schedulingWaitText({
      state: "WAITING",
      reason: "PROFILE_SESSION_BUSY",
      waitingSince: null,
      blockedBy: {
        resourceType: "PROFILE",
        rootReason: "LEASE_RECOVERY",
        recoveryId: "recovery-1",
      },
    }),
  ).toContain("前一个执行正在等待会话恢复");
});
