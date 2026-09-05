import { describe, expect, it, vi } from "vitest";

import {
  feishuConsoleUrl,
  githubTaskResultComment,
  NotificationOutboxWorker,
  signAgentResumeWebhook,
  signFeishuWebhook,
  taskCompletionPresentation,
} from "./notification-outbox-worker.service.js";

describe("Feishu notification signing", () => {
  it("uses the documented timestamp-newline-secret HMAC input", () => {
    expect(signFeishuWebhook("1599360473", "demo")).toBe(
      "l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=",
    );
  });
});

describe("Feishu notification links", () => {
  it("opens a Run v2 intervention in its Runtime execution detail", () => {
    expect(
      feishuConsoleUrl("https://devproof.example.com/", {
        interventionId: "intervention-id",
        runId: "execution-run-id",
        runKind: "EXECUTION_RUN",
      }),
    ).toBe("https://devproof.example.com/console/executions/execution-run-id");
  });

  it("keeps legacy verification checkpoints on the verification detail", () => {
    expect(
      feishuConsoleUrl("https://devproof.example.com", {
        checkpointId: "checkpoint-id",
        runId: "verification-run-id",
      }),
    ).toBe(
      "https://devproof.example.com/console/verifications/verification-run-id",
    );
  });

  it("opens task notifications at the exact waiting task or Profile", () => {
    expect(
      feishuConsoleUrl("https://devproof.example.com", {
        taskExecutionId: "task-id",
      }),
    ).toBe("https://devproof.example.com/console/runs?task=task-id");
    expect(
      feishuConsoleUrl("https://devproof.example.com", {
        profileId: "profile-id",
        reason: "PROFILE_LOGIN_REQUIRED",
        taskExecutionId: "task-id",
      }),
    ).toBe("https://devproof.example.com/console/profiles?profile=profile-id");
  });

  it("opens a single-case completion directly on the final result", () => {
    expect(
      feishuConsoleUrl("https://devproof.example.com", {
        notificationKind: "TASK_COMPLETED",
        resultRunId: "run-id",
        taskExecutionId: "task-id",
      }),
    ).toBe("https://devproof.example.com/console/executions/run-id");
  });
});

describe("task completion notifications", () => {
  it("renders a concise pass result and a stable PR comment marker", () => {
    const payload = {
      counts: { failed: 0, inconclusive: 0, passed: 3, total: 3 },
      goal: "ENG-123 checkout",
      lifecycle: "COMPLETED",
      taskExecutionId: "task-1",
      verdict: "PASSED",
    };

    expect(taskCompletionPresentation(payload)).toEqual({
      icon: "✅",
      label: "验证通过",
      template: "green",
    });
    expect(
      githubTaskResultComment(
        payload,
        "https://devproof.example.com/console/runs?task=task-1",
      ),
    ).toContain("| 3 | 3 | 0 | 0 |");
    expect(githubTaskResultComment(payload, "https://example.com")).toContain(
      "<!-- devproof-task:task-1 -->",
    );
  });
});

describe("Feishu task card delivery", () => {
  it("updates the stored card for later HITL and completion states", async () => {
    const feishu = {
      replyCardToMessage: vi.fn(),
      updateCardMessage: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new NotificationOutboxWorker(
      {} as never,
      feishu as never,
      {} as never,
    );
    const sendFeishu = Reflect.get(worker, "sendFeishu") as (
      deliveryId: string,
      payload: Record<string, unknown>,
      task: Record<string, unknown>,
    ) => Promise<void>;

    await sendFeishu.call(
      worker,
      "delivery-1",
      {
        goal: "A verbose case-level goal",
        interventionId: "intervention-1",
        prompt: "Complete MFA in the preserved browser session.",
        runId: "run-1",
        runKind: "EXECUTION_RUN",
      },
      {
        notificationContext: {
          feishu: {
            cardMessageId: "card-message-1",
            replyToMessageId: "source-message-1",
          },
        },
        taskExecutionId: "task-1",
        taskTitle: "ENG-123",
      },
    );

    expect(feishu.updateCardMessage).toHaveBeenCalledWith(
      "card-message-1",
      expect.objectContaining({
        header: expect.objectContaining({ template: "orange" }),
      }),
      expect.any(AbortSignal),
    );
    expect(feishu.replyCardToMessage).not.toHaveBeenCalled();
    expect(
      JSON.stringify(feishu.updateCardMessage.mock.calls[0]?.[1]),
    ).not.toContain("Complete MFA");
  });
});

describe("Agent resume webhook signing", () => {
  it("binds timestamp and exact body to the shared secret", () => {
    expect(
      signAgentResumeWebhook(
        "1700000000",
        '{"ok":true}',
        "secretsecretsecretsecretsecretsecret",
      ),
    ).toBe("89a53534b32c52279d021c98a5a7b4aa9d7ef3d177faf9ca39bfdb1c66ad22bb");
  });
});

describe("GitHub result comment pagination", () => {
  it("updates an existing task result beyond the first 100 comments", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (new URL(input).searchParams.get("page") === "1")
        return Response.json(
          Array.from({ length: 100 }, (_, id) => ({ id, body: "discussion" })),
        );
      if (new URL(input).searchParams.get("page") === "2")
        return Response.json([
          { id: 123, body: "<!-- devproof-task:task-1 -->" },
        ]);
      expect(init?.method).toBe("PATCH");
      return Response.json({ id: 123 });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const worker = new NotificationOutboxWorker(
        {} as never,
        {} as never,
        { candidatesForRepository: async () => [{ token: "test" }] } as never,
      );
      await Reflect.get(worker, "sendGithub").call(worker, "team-1", {
        taskExecutionId: "task-1",
        primaryPullRequestUrl: "https://github.com/acme/web/pull/7",
        verdict: "PASSED",
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(fetcher.mock.calls[2]![0]).toContain("/issues/comments/123");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
