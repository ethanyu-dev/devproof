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
    expect(JSON.stringify(hitl)).toContain("前往处理");
    expect(JSON.stringify(hitl)).not.toContain("deliberately long prompt");
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
