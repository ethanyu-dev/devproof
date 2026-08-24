import { Prisma } from "@prisma/client";

export interface TaskNotificationContext {
  feishu?: {
    replyToMessageId: string;
  };
}

export interface TaskWaitingNotificationInput {
  generation: number;
  input: "BROWSER_PROFILE" | "DEPLOYMENT_TARGET";
  message: string;
  notificationContext: Prisma.JsonValue;
  profileId?: string | null;
  profileOwnerUserId?: string | null;
  reason: string;
  taskExecutionId: string;
  teamId: string;
  title: string;
}

export interface TaskCompletionNotificationInput {
  counts: {
    failed: number;
    inconclusive: number;
    passed: number;
    total: number;
  };
  enableFeishu: boolean;
  enableGithub: boolean;
  executionDisposition: string | null;
  lifecycle: string;
  notificationContext: Prisma.JsonValue;
  primaryPullRequestUrl?: string | null;
  resultRunId?: string | null;
  sourceRef?: string | null;
  summary?: string | null;
  taskExecutionId: string;
  teamId: string;
  title: string;
  verdict: string | null;
}

export async function enqueueTaskWaitingNotification(
  tx: Prisma.TransactionClient,
  input: TaskWaitingNotificationInput,
) {
  const dedupeKey = [
    "task",
    input.taskExecutionId,
    "waiting-input",
    input.input.toLowerCase(),
    String(input.generation),
    "feishu",
  ].join(":");
  const replyToMessageId = taskNotificationContext(input.notificationContext)
    .feishu?.replyToMessageId;
  const created = await tx.notificationOutbox.createMany({
    data: [
      {
        channel: "FEISHU",
        dedupeKey,
        eventType: "task.waiting_input",
        payload: json({
          ...(replyToMessageId
            ? { feishuReplyToMessageId: replyToMessageId }
            : {}),
          goal: input.title,
          input: input.input,
          message: input.message,
          notificationKind: "TASK_WAITING_INPUT",
          profileId: input.profileId ?? null,
          profileOwnerUserId: input.profileOwnerUserId ?? null,
          prompt: taskWaitingPrompt(input.reason),
          reason: input.reason,
          runKind: "TASK_EXECUTION",
          taskExecutionId: input.taskExecutionId,
        }),
        taskExecutionId: input.taskExecutionId,
        teamId: input.teamId,
      },
    ],
    skipDuplicates: true,
  });
  if (created.count !== 1) return false;
  await tx.taskExecutionEvent.create({
    data: {
      actor: "SYSTEM",
      kind: "notification.enqueued",
      payload: json({
        channel: "FEISHU",
        dedupeKey,
        input: input.input,
        reason: input.reason,
      }),
      taskExecutionId: input.taskExecutionId,
      teamId: input.teamId,
    },
  });
  return true;
}

export async function enqueueTaskCompletionNotifications(
  tx: Prisma.TransactionClient,
  input: TaskCompletionNotificationInput,
) {
  const replyToMessageId = taskNotificationContext(input.notificationContext)
    .feishu?.replyToMessageId;
  const commonPayload = {
    counts: input.counts,
    executionDisposition: input.executionDisposition,
    goal: input.title,
    lifecycle: input.lifecycle,
    notificationKind: "TASK_COMPLETED",
    resultRunId: input.resultRunId ?? null,
    runKind: "TASK_EXECUTION",
    sourceRef: input.sourceRef ?? null,
    summary: input.summary ?? null,
    taskExecutionId: input.taskExecutionId,
    verdict: input.verdict,
  };
  const deliveries: Prisma.NotificationOutboxCreateManyInput[] = [];
  if (input.enableFeishu) {
    deliveries.push({
      channel: "FEISHU",
      dedupeKey: `task:${input.taskExecutionId}:completed:feishu`,
      eventType: "task.completed",
      payload: json({
        ...commonPayload,
        ...(replyToMessageId
          ? { feishuReplyToMessageId: replyToMessageId }
          : {}),
      }),
      taskExecutionId: input.taskExecutionId,
      teamId: input.teamId,
    });
  }
  if (input.enableGithub && input.primaryPullRequestUrl) {
    deliveries.push({
      channel: "GITHUB",
      dedupeKey: `task:${input.taskExecutionId}:completed:github`,
      eventType: "task.completed",
      payload: json({
        ...commonPayload,
        primaryPullRequestUrl: input.primaryPullRequestUrl,
      }),
      taskExecutionId: input.taskExecutionId,
      teamId: input.teamId,
    });
  }
  if (deliveries.length === 0) return 0;
  const created = await tx.notificationOutbox.createMany({
    data: deliveries,
    skipDuplicates: true,
  });
  if (created.count === 0) return 0;
  await tx.taskExecutionEvent.create({
    data: {
      actor: "SYSTEM",
      kind: "notification.enqueued",
      payload: json({
        channels: deliveries.map((delivery) => delivery.channel),
        notificationKind: "TASK_COMPLETED",
      }),
      taskExecutionId: input.taskExecutionId,
      teamId: input.teamId,
    },
  });
  return created.count;
}

export function taskNotificationContext(
  value: Prisma.JsonValue | undefined,
): TaskNotificationContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const feishu = value.feishu;
  if (!feishu || typeof feishu !== "object" || Array.isArray(feishu)) return {};
  const replyToMessageId = feishu.replyToMessageId;
  return typeof replyToMessageId === "string" && replyToMessageId.length > 0
    ? { feishu: { replyToMessageId } }
    : {};
}

export function taskWaitingPrompt(reason: string) {
  switch (reason) {
    case "DEPLOYMENT_TARGET_REQUIRED":
      return "请打开任务并填写可访问的 Deployment URL，然后提交执行全部 Case。";
    case "PROFILE_ACCESS_APPROVAL_REQUIRED":
      return "请由 Profile 所有人打开 Profile 页面，确认允许本次任务使用该登录身份。";
    case "PROFILE_AUTHORIZATION_CHANGED":
      return "Profile 授权已发生变化，请由所有人重新登录或确认本次任务入口授权。";
    case "PROFILE_EXPLICIT_NOT_FOUND":
      return "原先指定的 Profile 已不存在，请打开任务选择另一个 READY Profile，或改用其他策略。";
    case "PROFILE_INACTIVITY_EXPIRED":
      return "Profile 登录状态已过期，请由所有人重新完成网页登录并验证保存。";
    case "PROFILE_ISSUE_ASSIGNEE_ISSUER_CONFLICT":
      return "Linear 负责人身份已关联到其他团队，请联系管理员修正身份关联，或改选其他 Profile 策略。";
    case "PROFILE_LOGIN_REQUIRED":
      return "请由 Profile 所有人打开 Profile 页面，完成网页登录后点击“验证并保存”。";
    case "PROFILE_REQUESTER_UNKNOWN":
      return "请打开任务并重新选择 Profile 策略；选择“使用我的 Profile”可将当前登录用户认领为任务请求人。";
    case "PROFILE_ISSUE_ASSIGNEE_UNMAPPED":
      return "请让 Linear Issue 负责人先登录 DevProof 完成身份关联，或在任务中改选其他 Profile 策略。";
    case "PROFILE_ISSUE_ASSIGNEE_IS_AGENT":
      return "Linear Issue 当前由 Agent 负责，无法持有用户 Profile；请改选“使用我的 Profile”或临时会话。";
    case "PROFILE_ISSUE_UNASSIGNED":
      return "请先为 Linear Issue 指定负责人，或在任务中改选其他 Profile 策略。";
    case "PROFILE_ISSUE_CONTEXT_MISSING":
      return "当前任务缺少 Linear Issue 上下文，请重试 Spec 分析，或改选“使用我的 Profile”。";
    case "PROFILE_NOT_READY_OR_NOT_AUTHORIZED":
      return "请打开任务选择可用 Profile，或由 Profile 所有人完成登录和授权。";
    case "PROFILE_OWNER_DELETED":
      return "原 Profile 已被删除，请打开任务重新选择策略；使用请求人 Profile 时系统会自动重建。";
    case "PROFILE_OWNER_DISABLED":
      return "原 Profile 已停用，请由所有人恢复登录，或在任务中改选其他 Profile 策略。";
    case "PROFILE_OWNER_OFFBOARDED":
      return "Profile 所有人已不在当前团队，请在任务中改选其他 Profile 策略。";
    case "PROFILE_TARGET_REQUIRED":
      return "请打开任务填写可访问的 Deployment URL，然后继续解析 Profile。";
    default:
      return "请打开任务查看等待原因，并完成页面提示的人工操作。";
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
