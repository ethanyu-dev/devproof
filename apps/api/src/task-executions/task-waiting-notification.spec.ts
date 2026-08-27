import { describe, expect, it, vi } from "vitest";

import {
  enqueueTaskCompletionNotifications,
  enqueueTaskWaitingNotification,
  taskNotificationContext,
  taskWaitingPrompt,
} from "./task-waiting-notification.js";

describe("task waiting notifications", () => {
  it("queues durable Feishu and GitHub completion deliveries once", async () => {
    const tx = {
      notificationOutbox: {
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      taskExecutionEvent: { create: vi.fn() },
    };

    await expect(
      enqueueTaskCompletionNotifications(tx as never, {
        counts: { failed: 0, inconclusive: 0, passed: 3, total: 3 },
        enableFeishu: true,
        enableGithub: true,
        executionDisposition: "EXECUTED",
        lifecycle: "COMPLETED",
        notificationContext: {
          feishu: { replyToMessageId: "message-1" },
        },
        primaryPullRequestUrl: "https://github.com/acme/store/pull/42",
        sourceRef: "ENG-123",
        summary: "Checkout remains available.",
        taskExecutionId: "task-1",
        teamId: "team-1",
        title: "ENG-123",
        verdict: "PASSED",
      }),
    ).resolves.toBe(2);
    expect(tx.notificationOutbox.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          channel: "FEISHU",
          dedupeKey: "task:task-1:completed:feishu",
        }),
        expect.objectContaining({
          channel: "GITHUB",
          dedupeKey: "task:task-1:completed:github",
        }),
      ]),
      skipDuplicates: true,
    });
    expect(tx.taskExecutionEvent.create).toHaveBeenCalledOnce();
  });

  it("creates one deduplicated Feishu delivery and an audit event", async () => {
    const tx = {
      notificationOutbox: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      taskExecutionEvent: { create: vi.fn() },
    };

    await expect(
      enqueueTaskWaitingNotification(tx as never, {
        generation: 4,
        input: "BROWSER_PROFILE",
        message: "The profile owner must complete browser login.",
        notificationContext: {
          feishu: { replyToMessageId: "message-1" },
        },
        profileId: "profile-1",
        reason: "PROFILE_LOGIN_REQUIRED",
        taskExecutionId: "task-1",
        teamId: "team-1",
        title: "ENG-123",
      }),
    ).resolves.toBe(true);
    expect(tx.notificationOutbox.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            dedupeKey: "task:task-1:waiting-input:browser_profile:4:feishu",
            taskExecutionId: "task-1",
          }),
        ],
        skipDuplicates: true,
      }),
    );
    expect(tx.taskExecutionEvent.create).toHaveBeenCalledOnce();
  });

  it("does not duplicate the audit event when the outbox row already exists", async () => {
    const tx = {
      notificationOutbox: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      taskExecutionEvent: { create: vi.fn() },
    };
    await expect(
      enqueueTaskWaitingNotification(tx as never, {
        generation: 4,
        input: "DEPLOYMENT_TARGET",
        message: "Deployment target required.",
        notificationContext: {},
        reason: "DEPLOYMENT_TARGET_REQUIRED",
        taskExecutionId: "task-1",
        teamId: "team-1",
        title: "ENG-123",
      }),
    ).resolves.toBe(false);
    expect(tx.taskExecutionEvent.create).not.toHaveBeenCalled();
  });

  it("normalizes stored context and gives users a concrete action", () => {
    expect(
      taskNotificationContext({
        feishu: {
          cardMessageId: "card-message-1",
          replyToMessageId: "message-1",
        },
      }),
    ).toEqual({
      feishu: {
        cardMessageId: "card-message-1",
        replyToMessageId: "message-1",
      },
    });
    expect(
      taskNotificationContext({ feishu: { replyToMessageId: 1 } }),
    ).toEqual({});
    expect(taskWaitingPrompt("PROFILE_REQUESTER_UNKNOWN")).toContain(
      "认领为任务请求人",
    );
    expect(taskWaitingPrompt("PROFILE_EXPLICIT_NOT_FOUND")).toContain(
      "另一个可用浏览器身份",
    );
  });
});
