import { describe, expect, it } from "vitest";

import {
  executionDispositionLabel,
  taskOutcomeDisplay,
  verificationVerdictLabel,
} from "./task-outcome";

describe("taskOutcomeDisplay", () => {
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
