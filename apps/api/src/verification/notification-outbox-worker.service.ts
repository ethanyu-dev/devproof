import { createHmac, randomUUID } from "node:crypto";

import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { FeishuIntegrationService } from "../integrations/feishu-integration.service.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";
import { redactText } from "../observability/observability.service.js";
import { parsePullRequestUrl } from "../specifications/github-pull-request.client.js";
import { GithubAccessService } from "../console/github-access.service.js";

export function signFeishuWebhook(timestamp: string, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`)
    .update("")
    .digest("base64");
}

export function signAgentResumeWebhook(
  timestamp: string,
  body: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export function feishuConsoleUrl(
  webOrigin: string,
  payload: Record<string, unknown>,
): string {
  const origin = webOrigin.replace(/\/$/u, "");
  if (typeof payload.resultRunId === "string") {
    return `${origin}/console/executions/${encodeURIComponent(payload.resultRunId)}`;
  }
  if (typeof payload.taskExecutionId === "string") {
    if (
      typeof payload.profileId === "string" &&
      ["PROFILE_ACCESS_APPROVAL_REQUIRED", "PROFILE_LOGIN_REQUIRED"].includes(
        String(payload.reason ?? ""),
      )
    ) {
      return `${origin}/console/profiles?profile=${encodeURIComponent(payload.profileId)}`;
    }
    return `${origin}/console/runs?task=${encodeURIComponent(payload.taskExecutionId)}`;
  }
  const runId = String(payload.runId ?? "");
  const route =
    payload.runKind === "EXECUTION_RUN" ? "executions" : "verifications";
  return `${origin}/console/${route}/${encodeURIComponent(runId)}`;
}

export function taskCompletionPresentation(payload: Record<string, unknown>) {
  const verdict = typeof payload.verdict === "string" ? payload.verdict : null;
  const lifecycle =
    typeof payload.lifecycle === "string" ? payload.lifecycle : null;
  if (verdict === "PASSED") {
    return { icon: "✅", label: "验证通过", template: "green" } as const;
  }
  if (verdict === "FAILED") {
    return { icon: "❌", label: "验证失败", template: "red" } as const;
  }
  if (lifecycle === "CANCELLED") {
    return { icon: "⏹️", label: "任务已取消", template: "grey" } as const;
  }
  if (lifecycle === "TIMED_OUT") {
    return { icon: "⏱️", label: "验证超时", template: "red" } as const;
  }
  return { icon: "⚠️", label: "未能得出结论", template: "orange" } as const;
}

export function githubTaskResultComment(
  payload: Record<string, unknown>,
  consoleUrl: string,
) {
  const result = taskCompletionPresentation(payload);
  const counts = record(payload.counts);
  const taskExecutionId = String(payload.taskExecutionId ?? "");
  const title = String(payload.goal ?? payload.sourceRef ?? "DevProof task");
  const passed = countValue(counts.passed);
  const failed = countValue(counts.failed);
  const inconclusive = countValue(counts.inconclusive);
  const total = countValue(counts.total);
  return [
    `## ${result.icon} DevProof · ${result.label}`,
    "",
    `**${title.replaceAll("\n", " ").slice(0, 500)}**`,
    "",
    "| 验证场景 | 通过 | 失败 | 未确定 |",
    "| ---: | ---: | ---: | ---: |",
    `| ${total} | ${passed} | ${failed} | ${inconclusive} |`,
    "",
    `[查看完整结果、逐步截图与执行视频](${consoleUrl})`,
    "",
    `<!-- devproof-task:${taskExecutionId} -->`,
  ].join("\n");
}

class GithubWritebackResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubWritebackResponseError";
  }
}

@Injectable()
export class NotificationOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationOutboxWorker.name);
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly feishu: FeishuIntegrationService,
    private readonly githubAccess: GithubAccessService,
    @Optional() private readonly monitor?: WorkerMonitorService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor?.register(
      "notification-outbox",
      env().BACKGROUND_WORKER_POLL_MS,
    );
    this.timer = setInterval(
      () => this.trigger(),
      env().BACKGROUND_WORKER_POLL_MS,
    );
    this.timer.unref();
    this.trigger();
  }

  private trigger() {
    const operation = () => this.poll();
    const running = this.monitor
      ? this.monitor.run("notification-outbox", operation)
      : operation();
    void running.catch((error: Error) => {
      this.logger.error(`Notification outbox poll failed: ${error.message}`);
    });
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.prisma.notificationOutbox.updateMany({
        data: {
          lastError:
            "Notification worker lease expired before acknowledgement.",
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: new Date(),
          status: "FAILED",
        },
        where: {
          leaseExpiresAt: { lte: new Date() },
          status: "PROCESSING",
        },
      });
      const rows = await this.prisma.notificationOutbox.findMany({
        orderBy: { createdAt: "asc" },
        take: 20,
        where: {
          attempts: { lt: 10 },
          nextAttemptAt: { lte: new Date() },
          status: { in: ["PENDING", "FAILED"] },
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: new Date() } },
          ],
        },
      });
      for (const row of rows) await this.deliver(row.id);
    } finally {
      this.polling = false;
    }
  }

  private async deliver(id: string) {
    const started = Date.now();
    const leaseToken = randomUUID();
    const claimed = await this.prisma.notificationOutbox.updateMany({
      data: {
        attempts: { increment: 1 },
        leaseExpiresAt: new Date(Date.now() + 30_000),
        leaseToken,
        status: "PROCESSING",
      },
      where: {
        id,
        status: { in: ["PENDING", "FAILED"] },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
      },
    });
    if (claimed.count !== 1) return;
    const row = await this.prisma.notificationOutbox.findUniqueOrThrow({
      include: {
        executionRun: { select: { traceId: true } },
        run: { select: { traceId: true } },
        taskExecution: { select: { traceId: true } },
      },
      where: { id },
    });
    const traceId =
      row.run?.traceId ??
      row.executionRun?.traceId ??
      row.taskExecution?.traceId;
    if (!traceId) {
      throw new Error("Notification outbox has no owning run or task.");
    }
    try {
      if (row.channel === "AGENT_WEBHOOK") {
        await this.sendAgentResumeWebhook(row.id, row.payload);
      } else if (row.channel === "GITHUB") {
        await this.sendGithub(row.teamId, row.payload);
      } else {
        await this.sendFeishu(row.id, row.payload);
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.notificationOutbox.update({
          data: {
            deliveredAt: new Date(),
            lastError: null,
            leaseExpiresAt: null,
            leaseToken: null,
            status: "DELIVERED",
          },
          where: { id },
        });
        if (row.executionRunId) {
          await tx.runEvent.create({
            data: {
              actor: "SYSTEM",
              kind: "notification.delivered",
              payload: { channel: row.channel, outboxId: row.id },
              runId: row.executionRunId,
              teamId: row.teamId,
            },
          });
        } else if (row.runId) {
          await tx.verificationEvent.create({
            data: {
              actor: "SYSTEM",
              durationMs: Date.now() - started,
              kind: "notification.delivered",
              payload: { channel: row.channel, outboxId: row.id },
              status: "SUCCEEDED",
              traceId,
              runId: row.runId,
              teamId: row.teamId,
            },
          });
        } else if (row.taskExecutionId) {
          await tx.taskExecutionEvent.create({
            data: {
              actor: "SYSTEM",
              kind: "notification.delivered",
              payload: { channel: row.channel, outboxId: row.id },
              taskExecutionId: row.taskExecutionId,
              teamId: row.teamId,
            },
          });
        }
      });
    } catch (error) {
      const message = redactText(
        error instanceof Error ? error.message : String(error),
      );
      const backoffSeconds = Math.min(3600, 2 ** row.attempts * 5);
      await this.prisma.$transaction(async (tx) => {
        await tx.notificationOutbox.update({
          data: {
            lastError: message.slice(0, 4000),
            leaseExpiresAt: null,
            leaseToken: null,
            nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000),
            status: "FAILED",
          },
          where: { id },
        });
        if (row.executionRunId) {
          await tx.runEvent.create({
            data: {
              actor: "SYSTEM",
              kind: "notification.failed",
              payload: {
                channel: row.channel,
                errorCode: "NOTIFICATION_DELIVERY_FAILED",
                message,
                outboxId: row.id,
              },
              runId: row.executionRunId,
              teamId: row.teamId,
            },
          });
        } else if (row.runId) {
          await tx.verificationEvent.create({
            data: {
              actor: "SYSTEM",
              durationMs: Date.now() - started,
              errorCode: "NOTIFICATION_DELIVERY_FAILED",
              errorMessage: message.slice(0, 4_000),
              kind: "notification.failed",
              payload: { channel: row.channel, message, outboxId: row.id },
              status: "FAILED",
              traceId,
              runId: row.runId,
              teamId: row.teamId,
            },
          });
        } else if (row.taskExecutionId) {
          await tx.taskExecutionEvent.create({
            data: {
              actor: "SYSTEM",
              kind: "notification.failed",
              payload: {
                channel: row.channel,
                errorCode: "NOTIFICATION_DELIVERY_FAILED",
                message,
                outboxId: row.id,
              },
              taskExecutionId: row.taskExecutionId,
              teamId: row.teamId,
            },
          });
        }
      });
      this.logger.warn(`Notification outbox ${id} delivery failed: ${message}`);
    }
  }

  private async sendFeishu(deliveryId: string, payloadValue: Prisma.JsonValue) {
    const config = env();
    const payload = payloadValue as Record<string, unknown>;
    const checkpointId = String(
      payload.checkpointId ??
        payload.interventionId ??
        payload.taskExecutionId ??
        "",
    );
    const consoleUrl = feishuConsoleUrl(config.WEB_ORIGIN, payload);
    const isCompletion = payload.notificationKind === "TASK_COMPLETED";
    const completion = taskCompletionPresentation(payload);
    const title = isCompletion
      ? `DevProof · ${completion.label}`
      : payload.notificationKind === "TASK_WAITING_INPUT"
        ? "DevProof 任务等待输入"
        : "DevProof 人工检查点";
    const prompt = String(payload.prompt ?? "");
    const goal = String(payload.goal ?? "");
    const counts = record(payload.counts);
    const completionSummary = `场景 ${countValue(counts.total)} · 通过 ${countValue(counts.passed)} · 失败 ${countValue(counts.failed)} · 未确定 ${countValue(counts.inconclusive)}`;
    if (typeof payload.feishuReplyToMessageId === "string") {
      await this.feishu.replyToMessage(
        payload.feishuReplyToMessageId,
        deliveryId,
        isCompletion
          ? `【${title}】\n任务：${goal}\n${completionSummary}\n查看逐步截图与执行视频：${consoleUrl}`
          : `【${title}】\n任务：${goal}\n需要处理：${prompt}\n${consoleUrl}`,
      );
      return;
    }
    if (!config.FEISHU_NOTIFICATION_WEBHOOK_URL) {
      throw new Error("FEISHU_NOTIFICATION_WEBHOOK_URL is not configured.");
    }
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = config.FEISHU_NOTIFICATION_WEBHOOK_SECRET
      ? signFeishuWebhook(timestamp, config.FEISHU_NOTIFICATION_WEBHOOK_SECRET)
      : undefined;
    const body = {
      ...(signature ? { sign: signature, timestamp } : {}),
      card: {
        elements: [
          {
            tag: "div",
            text: {
              content: isCompletion
                ? `**任务**\n${goal}\n\n**结果**\n${completionSummary}`
                : `**目标**\n${goal}\n\n**需要人工处理**\n${prompt}\n\n编号：${checkpointId}`,
              tag: "lark_md",
            },
          },
          {
            actions: [
              {
                tag: "button",
                text: {
                  content: isCompletion ? "查看完整结果" : "打开 DevProof 处理",
                  tag: "plain_text",
                },
                type: "primary",
                url: consoleUrl,
              },
            ],
            tag: "action",
          },
        ],
        header: {
          template: isCompletion ? completion.template : "orange",
          title: { content: title, tag: "plain_text" },
        },
      },
      msg_type: "interactive",
    };
    const response = await fetch(config.FEISHU_NOTIFICATION_WEBHOOK_URL, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json; charset=utf-8" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`Feishu returned HTTP ${response.status}: ${text}`);
    const result = JSON.parse(text) as {
      code?: number;
      StatusCode?: number;
      msg?: string;
    };
    if ((result.code ?? result.StatusCode ?? 0) !== 0) {
      throw new Error(`Feishu rejected notification: ${result.msg ?? text}`);
    }
  }

  private async sendGithub(teamId: string, payloadValue: Prisma.JsonValue) {
    const configuration = env();
    const payload = payloadValue as Record<string, unknown>;
    const pullRequestUrl = String(payload.primaryPullRequestUrl ?? "");
    const reference = parsePullRequestUrl(pullRequestUrl);
    const candidates = await this.githubAccess.candidatesForRepository(
      teamId,
      reference.owner,
      reference.repository,
    );
    if (candidates.length === 0) {
      throw new Error(
        `No GitHub credential matches ${reference.owner}/${reference.repository}.`,
      );
    }
    const apiOrigin = configuration.GITHUB_API_URL.replace(/\/$/u, "");
    const prefix = `${apiOrigin}/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}`;
    const consoleUrl = feishuConsoleUrl(configuration.WEB_ORIGIN, payload);
    const body = githubTaskResultComment(payload, consoleUrl);
    const marker = `<!-- devproof-task:${String(payload.taskExecutionId ?? "")} -->`;
    for (const [index, candidate] of candidates.entries()) {
      try {
        const headers = {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${candidate.token}`,
          "content-type": "application/json; charset=utf-8",
          "x-github-api-version": configuration.GITHUB_API_VERSION,
        };
        const commentsResponse = await fetch(
          `${prefix}/issues/${reference.number}/comments?per_page=100`,
          {
            headers,
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!commentsResponse.ok) {
          throw new GithubWritebackResponseError(
            commentsResponse.status,
            `GitHub comments lookup returned HTTP ${commentsResponse.status}.`,
          );
        }
        const comments = (await commentsResponse.json()) as unknown;
        const existing = Array.isArray(comments)
          ? comments.find((comment) => {
              const row = record(comment);
              return (
                typeof row.body === "string" &&
                row.body.includes(marker) &&
                typeof row.id === "number"
              );
            })
          : undefined;
        const existingId = record(existing).id;
        const response = await fetch(
          typeof existingId === "number"
            ? `${prefix}/issues/comments/${existingId}`
            : `${prefix}/issues/${reference.number}/comments`,
          {
            body: JSON.stringify({ body }),
            headers,
            method: typeof existingId === "number" ? "PATCH" : "POST",
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!response.ok) {
          throw new GithubWritebackResponseError(
            response.status,
            `GitHub PR writeback returned HTTP ${response.status}.`,
          );
        }
        return;
      } catch (error) {
        if (
          index === candidates.length - 1 ||
          !(error instanceof GithubWritebackResponseError) ||
          ![401, 403, 404, 429].includes(error.status)
        ) {
          throw error;
        }
      }
    }
  }

  private async sendAgentResumeWebhook(
    deliveryId: string,
    payloadValue: Prisma.JsonValue,
  ) {
    const config = env();
    if (
      !config.AGENT_RESUME_WEBHOOK_URL ||
      !config.AGENT_RESUME_WEBHOOK_SECRET
    ) {
      throw new Error("Agent resume webhook is not configured.");
    }
    const body = JSON.stringify({
      deliveryId,
      event: "devproof.hitl.resolved",
      payload: payloadValue,
      sentAt: new Date().toISOString(),
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signAgentResumeWebhook(
      timestamp,
      body,
      config.AGENT_RESUME_WEBHOOK_SECRET,
    );
    const response = await fetch(config.AGENT_RESUME_WEBHOOK_URL, {
      body,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-devproof-delivery": deliveryId,
        "x-devproof-signature": `sha256=${signature}`,
        "x-devproof-timestamp": timestamp,
      },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(
        `Agent resume webhook returned HTTP ${response.status}: ${await response.text()}`,
      );
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function countValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
