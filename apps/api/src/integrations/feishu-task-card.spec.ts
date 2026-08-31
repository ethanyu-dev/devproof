import { describe, expect, it } from "vitest";

import {
  buildFeishuTaskCard,
  feishuTaskCardPresentation,
} from "./feishu-task-card.js";

describe("Feishu task cards", () => {
  it("keeps created and HITL cards concise and action-oriented", () => {
    const created = buildFeishuTaskCard(
      { goal: "ENG-123", notificationKind: "TASK_CREATED" },
      "https://devproof.example.com/console/runs?task=task-1",
    );
    const hitl = buildFeishuTaskCard(
      {
        goal: "ENG-123",
        notificationKind: "TASK_WAITING_INPUT",
        prompt: "A deliberately long prompt that must stay out of the card.",
      },
      "https://devproof.example.com/console/profiles?profile=profile-1",
    );

    expect(created.header).toEqual({
      template: "blue",
      title: { content: "DevProof · 任务已创建", tag: "plain_text" },
    });
    expect(created.config).toEqual({ update_multi: true });
    expect(hitl.header).toEqual({
      template: "orange",
      title: { content: "DevProof · 等待补充信息", tag: "plain_text" },
    });
    expect(JSON.stringify(hitl)).toContain("前往补充");
    expect(JSON.stringify(hitl)).not.toContain("deliberately long prompt");
  });

  it("replaces the HITL call to action after resolution or expiry", () => {
    const resolved = buildFeishuTaskCard(
      { notificationKind: "HITL_RESOLVED" },
      "https://devproof.example.com/console/runs?task=task-1",
      "ENG-123",
    );
    const expired = buildFeishuTaskCard(
      { notificationKind: "HITL_EXPIRED" },
      "https://devproof.example.com/console/runs?task=task-1",
      "ENG-123",
    );

    expect(resolved.header).toEqual({
      template: "blue",
      title: { content: "DevProof · 人工操作已完成", tag: "plain_text" },
    });
    expect(JSON.stringify(resolved)).toContain("已收到反馈，验证正在继续");
    expect(JSON.stringify(resolved)).toContain("查看进度");
    expect(JSON.stringify(resolved)).not.toContain("前往处理");
    expect(expired.header).toEqual({
      template: "grey",
      title: { content: "DevProof · 人工操作已超时", tag: "plain_text" },
    });
    expect(JSON.stringify(expired)).toContain("查看详情");
  });

  it("makes the final success or failure verdict unambiguous", () => {
    expect(
      feishuTaskCardPresentation({
        counts: { failed: 0, passed: 3, total: 3 },
        notificationKind: "TASK_COMPLETED",
        verdict: "PASSED",
      }),
    ).toMatchObject({
      label: "DevProof · 验证通过",
      summary: "3/3 个场景通过",
      template: "green",
    });
    expect(
      feishuTaskCardPresentation({
        counts: { failed: 1, passed: 2, total: 3 },
        notificationKind: "TASK_COMPLETED",
        verdict: "FAILED",
      }),
    ).toMatchObject({
      label: "DevProof · 验证失败",
      summary: "1/3 个场景未通过",
      template: "red",
    });
  });
});
