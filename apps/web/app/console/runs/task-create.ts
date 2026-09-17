import {
  taskExecutionCreateInputSchema,
  type TaskProfilePolicy,
} from "@devproof/contracts";

export interface TaskCreateDraft {
  issueRef: string;
  title?: string;
  goal?: string;
  pullRequestUrls: string;
  targetUrls: string;
  profileStrategy: TaskProfilePolicy["strategy"];
  profileId: string;
}

function uniqueLines(value: string) {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function taskCreateInput(
  draft: TaskCreateDraft,
  idempotencyKey: string,
) {
  const issueRef = draft.issueRef.trim();
  if (issueRef.length > 500) {
    throw new Error("请填写 Issue 链接或编号，最多 500 个字符。");
  }
  if (issueRef && !/^[a-z][a-z0-9]*-\d+$/iu.test(issueRef)) {
    let url: URL;
    try {
      url = new URL(issueRef);
    } catch {
      throw new Error("请填写有效的 Linear Issue 链接或编号（如 ENG-123）。");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "linear.app" ||
      url.username ||
      url.password ||
      url.port ||
      !/^\/[^/]+\/issue\/[a-z][a-z0-9]*-\d+(?:\/|$)/iu.test(url.pathname)
    ) {
      throw new Error("请填写有效的 Linear Issue 链接或编号（如 ENG-123）。");
    }
  }

  const pullRequestUrls = uniqueLines(draft.pullRequestUrls);
  const targetUrls = uniqueLines(draft.targetUrls);
  if (!targetUrls.length) throw new Error("请至少填写一个执行测试环境地址。");
  const parsed = taskExecutionCreateInputSchema.safeParse({
    kind: "SPEC_TASK",
    ...(issueRef ? { issueRef } : {}),
    ...(draft.title?.trim() ? { title: draft.title.trim() } : {}),
    ...(draft.goal?.trim() ? { goal: draft.goal.trim() } : {}),
    idempotencyKey,
    profilePolicy: {
      strategy: draft.profileStrategy,
      onUnavailable: "WAIT_FOR_PROFILE",
      ...(draft.profileStrategy === "EXPLICIT_PROFILE"
        ? { profileId: draft.profileId }
        : {}),
    },
    ...(pullRequestUrls.length ? { pullRequestUrls } : {}),
    deployments: targetUrls.map((targetUrl, index) => ({
      key: `deployment-${index + 1}`,
      name: `测试环境 ${index + 1}`,
      targetUrl,
    })),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === "goal")
      throw new Error("请至少填写 Issue、GitHub PR 或具体测试说明。");
    if (field === "profilePolicy") {
      throw new Error(
        draft.profileStrategy === "ISSUE_ASSIGNEE" && !issueRef
          ? "使用 Issue 负责人身份需要填写 Issue。"
          : "请选择有效的浏览器身份。",
      );
    }
    if (field === "pullRequestUrls") {
      throw new Error(
        "请填写有效的 GitHub PR 链接（https://github.com/组织/仓库/pull/编号），每行一个，最多 25 个。",
      );
    }
    if (field === "deployments") {
      throw new Error(
        "测试环境须为不含账号密码的 HTTP 或 HTTPS 地址，每行一个，最多 20 个。",
      );
    }
    throw new Error("创建信息无效，请检查后重试。");
  }
  return parsed.data;
}

type TaskCreateApi = <T>(path: string, init?: RequestInit) => Promise<T>;
type CreatedTask = { id: string };

export class TaskCreateRequest {
  private readonly keys = new Map<string, string>();
  private pending: Promise<CreatedTask> | null = null;

  constructor(private readonly api: TaskCreateApi) {}

  async submit(draft: TaskCreateDraft): Promise<CreatedTask> {
    if (this.pending) return this.pending;
    const input = taskCreateInput(draft, "console-task-validation");
    const fingerprint = JSON.stringify(input);
    // A timeout may happen after creation committed. Preserve the key for retries,
    // including when the user closes the form or edits and restores its values.
    let key = this.keys.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      this.keys.set(fingerprint, key);
    }
    this.pending = this.api<CreatedTask>("/tasks", {
      method: "POST",
      body: JSON.stringify({ ...input, idempotencyKey: key }),
    });
    try {
      const task = await this.pending;
      this.keys.delete(fingerprint);
      return task;
    } finally {
      this.pending = null;
    }
  }
}
