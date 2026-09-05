import { createHmac, randomUUID } from "node:crypto";

import { Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { FeishuIntegrationService } from "../integrations/feishu-integration.service.js";
import { buildFeishuTaskCard } from "../integrations/feishu-task-card.js";
import { WorkerMonitorService } from "../observability/worker-monitor.service.js";
import { redactText } from "../observability/observability.service.js";
import { parsePullRequestUrl } from "../specifications/github-pull-request.client.js";
import { GithubAccessService } from "../console/github-access.service.js";
import { taskNotificationContext } from "../task-executions/task-waiting-notification.js";

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
    const owner = await this.prisma.notificationOutbox.findUniqueOrThrow({
      select: {
        taskExecutionId: true,
        runId: true,
        executionRun: { select: { taskExecutionId: true } },
      },
      where: { id },
    });
    // Keep updates to the same external task card/comment ordered across replicas
    // and rerun generations. Claims and acknowledgements remain durable separately.
    await this.prisma.$transaction(
      async (tx) => {
        const key = `notification:${owner.taskExecutionId ?? owner.executionRun?.taskExecutionId ?? owner.runId ?? id}`;
        const locked = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS "locked"
      `;
        if (locked[0]?.locked) await this.deliverLocked(id);
      },
      { timeout: 120_000 },
    );
  }

  private async deliverLocked(id: string) {
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
        attempts: { lt: 10 },
        nextAttemptAt: { lte: new Date() },
        status: { in: ["PENDING", "FAILED"] },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
      },
    });
    if (claimed.count !== 1) return;
    const row = await this.prisma.notificationOutbox.findUniqueOrThrow({
      include: {
        executionRun: {
          select: {
            taskExecutionId: true,
            traceId: true,
            taskExecution: {
              select: { notificationContext: true, title: true },
            },
          },
        },
        run: { select: { traceId: true } },
        taskExecution: {
          select: {
            notificationContext: true,
            postRunAnalysisGeneration: true,
            lifecycle: true,
            title: true,
            traceId: true,
          },
        },
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
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(90_000),
    ]);
    const ownedWhere = () => ({
      id,
      leaseToken,
      status: "PROCESSING" as const,
      leaseExpiresAt: { gt: new Date() },
    });
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || signal.aborted) return;
      renewing = true;
      void this.prisma.notificationOutbox
        .updateMany({
          where: ownedWhere(),
          data: { leaseExpiresAt: new Date(Date.now() + 30_000) },
        })
        .then((result) => {
          if (result.count !== 1) controller.abort();
        })
        .catch(() => controller.abort())
        .finally(() => {
          renewing = false;
        });
    }, 10_000);
    timer.unref();
    try {
      const payload = record(row.payload);
      const generation =
        typeof payload.generation === "number" ? payload.generation : 1;
      if (
        row.taskExecution &&
        payload.notificationKind === "TASK_COMPLETED" &&
        (generation !== row.taskExecution.postRunAnalysisGeneration ||
          !["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(
            row.taskExecution.lifecycle,
          ))
      ) {
        await this.prisma.notificationOutbox.updateMany({
          where: ownedWhere(),
          data: {
            status: "DELIVERED",
            deliveredAt: new Date(),
            lastError: "Superseded by a newer task state.",
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        return;
      }
      if (row.channel === "AGENT_WEBHOOK") {
        await this.sendAgentResumeWebhook(row.id, row.payload, signal);
      } else if (row.channel === "GITHUB") {
        await this.sendGithub(row.teamId, row.payload, signal);
      } else {
        const taskExecution =
          row.taskExecution ?? row.executionRun?.taskExecution;
        await this.sendFeishu(
          row.id,
          row.payload,
          taskExecution
            ? {
                notificationContext: taskExecution.notificationContext,
                taskExecutionId:
                  row.taskExecutionId ?? row.executionRun?.taskExecutionId,
                taskTitle: taskExecution.title,
              }
            : undefined,
          signal,
        );
      }
      signal.throwIfAborted();
      await this.prisma.$transaction(async (tx) => {
        const acknowledged = await tx.notificationOutbox.updateMany({
          data: {
            deliveredAt: new Date(),
            lastError: null,
            leaseExpiresAt: null,
            leaseToken: null,
            status: "DELIVERED",
          },
          where: ownedWhere(),
        });
        if (acknowledged.count !== 1) return;
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
        const acknowledged = await tx.notificationOutbox.updateMany({
          data: {
            lastError: message.slice(0, 4000),
            leaseExpiresAt: null,
            leaseToken: null,
            nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000),
            status: "FAILED",
          },
          where: ownedWhere(),
        });
        if (acknowledged.count !== 1) return;
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
    } finally {
      clearInterval(timer);
      controller.abort();
    }
  }

  private async sendFeishu(
    deliveryId: string,
    payloadValue: Prisma.JsonValue,
    task?: {
      notificationContext: Prisma.JsonValue;
      taskExecutionId: string | null | undefined;
      taskTitle: string;
    },
    signal: AbortSignal = new AbortController().signal,
  ) {
    const config = env();
    const payload = payloadValue as Record<string, unknown>;
    const consoleUrl = feishuConsoleUrl(config.WEB_ORIGIN, payload);
    const card = buildFeishuTaskCard(payload, consoleUrl, task?.taskTitle);
    const context = taskNotificationContext(task?.notificationContext);
    const cardMessageId =
      context.feishu?.cardMessageId ?? stringValue(payload.feishuCardMessageId);
    if (cardMessageId) {
      await this.feishu.updateCardMessage(cardMessageId, card, signal);
      return;
    }
    const replyToMessageId =
      context.feishu?.replyToMessageId ??
      stringValue(payload.feishuReplyToMessageId);
    if (replyToMessageId) {
      const createdCardMessageId = await this.feishu.replyCardToMessage(
        replyToMessageId,
        deliveryId,
        card,
        signal,
      );
      if (task?.taskExecutionId) {
        await this.rememberTaskCard(
          task.taskExecutionId,
          replyToMessageId,
          createdCardMessageId,
        );
      }
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
      card,
      msg_type: "interactive",
    };
    const response = await fetch(config.FEISHU_NOTIFICATION_WEBHOOK_URL, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json; charset=utf-8" },
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
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

  private async rememberTaskCard(
    taskExecutionId: string,
    replyToMessageId: string,
    cardMessageId: string,
  ) {
    const task = await this.prisma.taskExecution.findUnique({
      select: { notificationContext: true },
      where: { id: taskExecutionId },
    });
    if (!task) return;
    const notificationContext = record(task.notificationContext);
    const feishu = record(notificationContext.feishu);
    await this.prisma.taskExecution.update({
      data: {
        notificationContext: json({
          ...notificationContext,
          feishu: { ...feishu, cardMessageId, replyToMessageId },
        }),
      },
      where: { id: taskExecutionId },
    });
  }

  private async sendGithub(
    teamId: string,
    payloadValue: Prisma.JsonValue,
    signal: AbortSignal = new AbortController().signal,
  ) {
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
      signal.throwIfAborted();
      try {
        const headers = {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${candidate.token}`,
          "content-type": "application/json; charset=utf-8",
          "x-github-api-version": configuration.GITHUB_API_VERSION,
        };
        let existingId: number | undefined;
        for (let page = 1; ; page++) {
          const commentsResponse = await fetch(
            `${prefix}/issues/${reference.number}/comments?per_page=100&page=${page}`,
            {
              headers,
              signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            },
          );
          if (!commentsResponse.ok)
            throw new GithubWritebackResponseError(
              commentsResponse.status,
              `GitHub comments lookup returned HTTP ${commentsResponse.status}.`,
            );
          const comments: unknown = await commentsResponse.json();
          if (!Array.isArray(comments))
            throw new Error("GitHub comments response is invalid.");
          const existing = comments.find((comment) => {
            const row = record(comment);
            return (
              typeof row.body === "string" &&
              row.body.includes(marker) &&
              typeof row.id === "number"
            );
          });
          if (existing) {
            existingId = record(existing).id as number;
            break;
          }
          if (comments.length < 100) break;
          if (page >= 100)
            throw new Error(
              "GitHub comments lookup exceeded its page budget; refusing to create a duplicate result comment.",
            );
        }
        const response = await fetch(
          typeof existingId === "number"
            ? `${prefix}/issues/comments/${existingId}`
            : `${prefix}/issues/${reference.number}/comments`,
          {
            body: JSON.stringify({ body }),
            headers,
            method: typeof existingId === "number" ? "PATCH" : "POST",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
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
    signal: AbortSignal = new AbortController().signal,
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
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
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

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
