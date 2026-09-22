import { describe, expect, it } from "vitest";
import { runOutcome } from "./run-outcome";

describe("Run lifecycle outcome", () => {
  it("does not label an entire case unscored when only one criterion has an environmental blocker", () => {
    const criteria = [
      {
        status: "INCONCLUSIVE",
        description: "保存后列表展示",
        environmentBlocked: true,
      },
      {
        status: "INCONCLUSIVE",
        description: "默认值",
        environmentBlocked: false,
      },
    ];
    expect(
      runOutcome(
        { lifecycle: "COMPLETED", verdict: "INCONCLUSIVE" },
        "EXECUTED",
        [],
        criteria,
      ),
    ).toMatchObject({
      unscored: false,
      scoringNote: expect.stringContaining("不参与评分"),
    });
    expect(
      runOutcome(
        { lifecycle: "COMPLETED", verdict: "INCONCLUSIVE" },
        "EXECUTED",
        [],
        criteria.slice(0, 1),
      ),
    ).toMatchObject({ unscored: true });
  });
  it("explains that unverified results after lease loss do not enter scoring", () => {
    expect(
      runOutcome(
        { lifecycle: "COMPLETED", verdict: null },
        "BLOCKED",
        [{ causeCode: "RUNTIME_LEASE_LOST", message: "执行节点租约丢失" }],
        [],
      ),
    ).toMatchObject({ scoringNote: expect.stringContaining("不参与评分") });
  });
  it.each([
    ["QUEUED", "neutral"],
    ["PREPARING", "info"],
    ["RUNNING", "info"],
    ["WAITING_HUMAN", "warning"],
  ])(
    "%s never presents a stale verdict as a completed verification",
    (lifecycle, tone) => {
      const result = runOutcome(
        { lifecycle, verdict: "PASSED" },
        "EXECUTED",
        [],
        [],
      );
      expect(result.title).not.toMatch(/已完成|验证通过/u);
      expect(result.tone).toBe(tone);
    },
  );
  it("shows the reason for a blocked run without claiming verification completed", () => {
    const result = runOutcome(
      { lifecycle: "COMPLETED", verdict: null },
      "BLOCKED",
      [{ message: "重复操作没有产生进展。", causeCode: "REPEATED_OPERATIONS" }],
      [],
    );
    expect(result.title).toBe("执行已中断，验证未完成");
    expect(result.description).toBe("重复操作没有产生进展。");
    expect(result.reasonCode).toBe("REPEATED_OPERATIONS");
    expect(result.tone).toBe("warning");
  });
  it("explains inconclusive criteria and genuine product failures separately", () => {
    expect(
      runOutcome(
        { lifecycle: "COMPLETED", verdict: "INCONCLUSIVE" },
        "EXECUTED",
        [],
        [
          {
            description: "类型可选",
            status: "INCONCLUSIVE",
            summary: "缺少测试账号，未完成验证。",
          },
        ],
      ),
    ).toMatchObject({
      label: "结果不确定",
      description: "缺少测试账号，未完成验证。",
    });
    expect(
      runOutcome(
        { lifecycle: "COMPLETED", verdict: "FAILED" },
        "EXECUTED",
        [{ message: "历史工具失败" }],
        [
          {
            description: "类型可选",
            status: "FAILED",
            summary: "下拉菜单缺少要求新增的类型。",
          },
        ],
      ),
    ).toMatchObject({
      title: "验证未通过",
      description: "下拉菜单缺少要求新增的类型。",
    });
  });
  it.each(["BLOCKED", "NOT_RUN", "AGENT_ERROR", "EXECUTED"])(
    "does not call a run verified without a verdict: %s",
    (disposition) => {
      const result = runOutcome(
        { lifecycle: "COMPLETED", verdict: null },
        disposition,
        [],
        [],
      );
      expect(result.title).not.toMatch(/验证已完成|验证通过/);
      expect(result.description.length).toBeGreaterThan(0);
    },
  );
  it("only completed runs present verification verdicts", () => {
    expect(
      runOutcome(
        { lifecycle: "COMPLETED", verdict: "PASSED" },
        "EXECUTED",
        [],
        [],
      ).title,
    ).toBe("验证通过");
    expect(
      runOutcome(
        { lifecycle: "UNKNOWN_NEW_STATE", verdict: "PASSED" },
        "EXECUTED",
        [],
        [],
      ).label,
    ).toBe("状态待确认");
    expect(
      runOutcome(
        { lifecycle: "TIMED_OUT", verdict: "PASSED" },
        "EXECUTED",
        [],
        [],
      ).label,
    ).toBe("已超时");
  });
});

it("excludes unverified session-loss criteria without hiding a recorded failure", () => {
  const failure = [
    { causeCode: "RUNTIME_SESSION_UNAVAILABLE", message: "浏览器会话已失效。" },
  ];
  const detail = { lifecycle: "COMPLETED", verdict: null };
  const criterion = { status: "INCONCLUSIVE", description: "重叠校验" };
  expect(
    runOutcome(detail, "RUNTIME_LOST", failure, [criterion]),
  ).toMatchObject({
    unscored: true,
    reasonCode: "RUNTIME_SESSION_UNAVAILABLE",
  });
  expect(
    runOutcome(detail, "RUNTIME_LOST", failure, [
      criterion,
      { ...criterion, status: "FAILED" },
    ]),
  ).toMatchObject({ unscored: false });
});
