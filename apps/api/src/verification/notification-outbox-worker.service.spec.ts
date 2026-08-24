import { describe, expect, it } from "vitest";

import {
  feishuConsoleUrl,
  githubTaskResultComment,
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
