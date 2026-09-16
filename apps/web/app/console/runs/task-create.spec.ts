import { describe, expect, it, vi } from "vitest";
import { taskExecutionCreateInputSchema } from "@devproof/contracts";
import {
  TaskCreateRequest,
  taskCreateInput,
  type TaskCreateDraft,
} from "./task-create";

const draft: TaskCreateDraft = {
  issueRef: " https://linear.app/acme/issue/ENG-123/test-feature ",
  pullRequestUrls:
    " https://github.com/acme/web/pull/123 \r\n\nhttps://github.com/acme/api/pull/456\nhttps://github.com/acme/web/pull/123",
  targetUrls:
    " https://staging.example.com \nhttp://preview.example.com:8080/app\nhttps://staging.example.com ",
  profileStrategy: "REQUESTER",
  profileId: "",
};

describe("manual task creation", () => {
  it("submits normalized Issue, PRs and every environment through the existing task contract", async () => {
    const api = vi.fn().mockResolvedValue({ id: "new-task" });
    const request = new TaskCreateRequest(api);
    await expect(request.submit(draft)).resolves.toEqual({ id: "new-task" });
    const [path, init] = api.mock.calls[0]!;
    expect(path).toBe("/tasks");
    expect(init.method).toBe("POST");
    const input = JSON.parse(init.body);
    expect(taskExecutionCreateInputSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({
      kind: "ISSUE_SPEC",
      profilePolicy: {
        strategy: "REQUESTER",
        onUnavailable: "WAIT_FOR_PROFILE",
        scope: { authRole: "default", environmentKey: "default" },
      },
      issueRef: "https://linear.app/acme/issue/ENG-123/test-feature",
      pullRequestUrls: [
        "https://github.com/acme/web/pull/123",
        "https://github.com/acme/api/pull/456",
      ],
      deployments: [
        {
          key: "deployment-1",
          name: "测试环境 1",
          targetUrl: "https://staging.example.com",
        },
        {
          key: "deployment-2",
          name: "测试环境 2",
          targetUrl: "http://preview.example.com:8080/app",
        },
      ],
    });
    expect(input.idempotencyKey).not.toBe("console-task-validation");
  });

  it.each(["REQUESTER", "ISSUE_ASSIGNEE", "EPHEMERAL"] as const)(
    "submits the selected %s strategy without a stale explicit identity",
    async (profileStrategy) => {
      const api = vi.fn().mockResolvedValue({ id: "new-task" });
      await new TaskCreateRequest(api).submit({
        ...draft,
        profileStrategy,
        profileId: "11111111-1111-4111-8111-111111111111",
      });
      const input = JSON.parse(api.mock.calls[0]![1].body);
      expect(input.profilePolicy).toMatchObject({
        strategy: profileStrategy,
        onUnavailable: "WAIT_FOR_PROFILE",
      });
      expect(input.profilePolicy).not.toHaveProperty("profileId");
    },
  );

  it("submits an explicitly selected browser identity", async () => {
    const api = vi.fn().mockResolvedValue({ id: "new-task" });
    const profileId = "11111111-1111-4111-8111-111111111111";
    await new TaskCreateRequest(api).submit({
      ...draft,
      profileStrategy: "EXPLICIT_PROFILE",
      profileId,
    });
    expect(JSON.parse(api.mock.calls[0]![1].body).profilePolicy).toMatchObject({
      strategy: "EXPLICIT_PROFILE",
      profileId,
    });
  });

  it("requires an identity for explicit selection before creating a task", async () => {
    const api = vi.fn();
    await expect(
      new TaskCreateRequest(api).submit({
        ...draft,
        profileStrategy: "EXPLICIT_PROFILE",
      }),
    ).rejects.toThrow("请选择有效的浏览器身份");
    expect(api).not.toHaveBeenCalled();
  });

  it("accepts an Issue identifier and leaves PR discovery enabled when no links are supplied", () => {
    const input = taskCreateInput(
      { ...draft, issueRef: "ENG-123", pullRequestUrls: " \n " },
      "manual-test-key",
    );
    expect(input).toHaveProperty("issueRef", "ENG-123");
    expect(input).not.toHaveProperty("pullRequestUrls");
  });

  it.each([
    { change: { issueRef: "  " }, message: "Issue" },
    { change: { issueRef: "not-an-issue" }, message: "Linear" },
    {
      change: { issueRef: "https://linear.app.evil.test/acme/issue/ENG-123" },
      message: "Linear",
    },
    {
      change: { issueRef: "https://github.com/acme/web/issues/1" },
      message: "Linear",
    },
    {
      change: { pullRequestUrls: "https://github.com/acme/web/issues/1" },
      message: "GitHub PR",
    },
    {
      change: {
        pullRequestUrls: "https://github.com/acme/web/pull/1\ninvalid",
      },
      message: "GitHub PR",
    },
    {
      change: {
        pullRequestUrls: Array.from(
          { length: 26 },
          (_, i) => `https://github.com/acme/web/pull/${i + 1}`,
        ).join("\n"),
      },
      message: "最多 25 个",
    },
    { change: { targetUrls: " \n " }, message: "至少填写一个" },
    {
      change: { targetUrls: "https://staging.example.com\ninvalid" },
      message: "HTTP 或 HTTPS",
    },
    {
      change: { targetUrls: "ftp://staging.example.com" },
      message: "HTTP 或 HTTPS",
    },
    {
      change: { targetUrls: "https://user:password@staging.example.com" },
      message: "不含账号密码",
    },
    {
      change: {
        targetUrls: Array.from(
          { length: 21 },
          (_, i) => `https://preview-${i}.example.com`,
        ).join("\n"),
      },
      message: "最多 20 个",
    },
  ])(
    "rejects invalid fields before making any request: $change",
    async ({ change, message }) => {
      const api = vi.fn();
      await expect(
        new TaskCreateRequest(api).submit({ ...draft, ...change }),
      ).rejects.toThrow(message);
      expect(api).not.toHaveBeenCalled();
    },
  );

  it("reuses the request key after an uncertain failure, even after editing and restoring inputs", async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error("请求超时"))
      .mockRejectedValueOnce(new Error("连接中断"))
      .mockResolvedValue({ id: "new-task" });
    const request = new TaskCreateRequest(api);
    await expect(request.submit(draft)).rejects.toThrow("请求超时");
    await expect(
      request.submit({ ...draft, targetUrls: "https://other.example.com" }),
    ).rejects.toThrow("连接中断");
    await request.submit({ ...draft, issueRef: draft.issueRef.trim() });
    expect(api.mock.calls[2]).toEqual(api.mock.calls[0]);
    expect(JSON.parse(api.mock.calls[1]![1].body).idempotencyKey).not.toBe(
      JSON.parse(api.mock.calls[0]![1].body).idempotencyKey,
    );
    await request.submit(draft);
    expect(JSON.parse(api.mock.calls[3]![1].body).idempotencyKey).not.toBe(
      JSON.parse(api.mock.calls[0]![1].body).idempotencyKey,
    );
  });

  it("coalesces submissions while creation is pending", async () => {
    let complete!: (task: { id: string }) => void;
    const api = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const request = new TaskCreateRequest(api);
    const first = request.submit(draft);
    const second = request.submit(draft);
    expect(api).toHaveBeenCalledTimes(1);
    complete({ id: "new-task" });
    await expect(first).resolves.toEqual({ id: "new-task" });
    await expect(second).resolves.toEqual({ id: "new-task" });
  });
});
