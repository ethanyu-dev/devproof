import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { TaskExecutionService } from "../task-executions/task-execution.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";

interface FeishuEventMetadata {
  appId: string;
  eventType: string;
  message: {
    chatId: string;
    chatType: string;
    mentions: Array<{ key: string; name: string; openId: string | null }>;
    messageId: string;
    messageType: string;
    text: string;
  };
  sender: {
    openId: string | null;
    unionId: string | null;
    userId: string | null;
  };
  tenantKey: string;
}

const tokenResponseSchema = {
  parse(value: unknown) {
    const record = asRecord(value);
    if (
      Number(record.code) !== 0 ||
      typeof record.tenant_access_token !== "string"
    ) {
      throw new Error(
        `Feishu tenant token failed: ${String(record.msg ?? record.code ?? "unknown")}`,
      );
    }
    return {
      expiresIn:
        typeof record.expire === "number"
          ? record.expire
          : Number(record.expire),
      token: record.tenant_access_token,
    };
  },
};

@Injectable()
export class FeishuIntegrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeishuIntegrationService.name);
  private timer?: NodeJS.Timeout;
  private polling = false;
  private accessToken?: { expiresAt: number; value: string };

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TaskExecutionService,
  ) {}

  onModuleInit() {
    if (!env().FEISHU_BOT_ENABLED || !env().BACKGROUND_WORKERS_ENABLED) return;
    this.timer = setInterval(
      () =>
        void this.poll().catch((error: Error) =>
          this.logger.error(error.message),
        ),
      env().BACKGROUND_WORKER_POLL_MS,
    );
    this.timer.unref();
    void this.poll();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async enqueue(input: {
    eventId: string;
    metadata: FeishuEventMetadata;
    payloadHash: string;
  }) {
    const existing = await this.prisma.inboundIntegrationEvent.findUnique({
      where: {
        provider_issuerKey_externalEventId: {
          externalEventId: input.eventId,
          issuerKey: input.metadata.appId,
          provider: "FEISHU",
        },
      },
    });
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) {
        throw new Error("Feishu event id was reused with a different payload.");
      }
      return { accepted: true, duplicate: true };
    }
    const team = await this.prisma.team.findUnique({
      where: { feishuTenantKey: input.metadata.tenantKey },
    });
    try {
      await this.prisma.inboundIntegrationEvent.create({
        data: {
          externalEventId: input.eventId,
          issuerKey: input.metadata.appId,
          metadata: json(input.metadata),
          payloadHash: input.payloadHash,
          provider: "FEISHU",
          teamId: team?.id ?? null,
        },
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }
      const collided = await this.prisma.inboundIntegrationEvent.findUnique({
        where: {
          provider_issuerKey_externalEventId: {
            externalEventId: input.eventId,
            issuerKey: input.metadata.appId,
            provider: "FEISHU",
          },
        },
      });
      if (!collided || collided.payloadHash !== input.payloadHash) {
        throw new Error("Feishu event id was reused with a different payload.");
      }
      return { accepted: true, duplicate: true };
    }
    return { accepted: true, duplicate: false };
  }

  async poll(limit = 20) {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.prisma.inboundIntegrationEvent.updateMany({
        data: { nextAttemptAt: null, status: "RECEIVED" },
        where: {
          provider: "FEISHU",
          status: "PROCESSING",
          updatedAt: { lt: new Date(Date.now() - 5 * 60_000) },
        },
      });
      const rows = await this.prisma.inboundIntegrationEvent.findMany({
        orderBy: { receivedAt: "asc" },
        select: { id: true },
        take: limit,
        where: {
          attempts: { lt: 10 },
          provider: "FEISHU",
          OR: [
            { status: "RECEIVED" },
            { nextAttemptAt: { lte: new Date() }, status: "FAILED" },
          ],
        },
      });
      for (const row of rows) await this.process(row.id);
    } finally {
      this.polling = false;
    }
  }

  private async process(id: string) {
    const claimed = await this.prisma.inboundIntegrationEvent.updateMany({
      data: {
        attempts: { increment: 1 },
        nextAttemptAt: null,
        status: "PROCESSING",
      },
      where: { id, status: { in: ["RECEIVED", "FAILED"] } },
    });
    if (claimed.count !== 1) return;
    const row = await this.prisma.inboundIntegrationEvent.findUniqueOrThrow({
      include: { team: true },
      where: { id },
    });
    const metadata = parseMetadata(row.metadata);
    try {
      if (
        metadata.eventType !== "im.message.receive_v1" ||
        metadata.message.messageType !== "text"
      ) {
        await this.finish(row.id, "IGNORED");
        return;
      }
      if (
        metadata.message.chatType === "group" &&
        !isTargetBotMentioned(
          metadata.message.mentions,
          env().FEISHU_BOT_OPEN_ID!,
        )
      ) {
        await this.finish(row.id, "IGNORED");
        return;
      }
      const text = stripMentions(
        metadata.message.text,
        metadata.message.mentions,
      );
      const issueRef = extractIssueRef(text);
      if (!issueRef) {
        await this.finish(row.id, "IGNORED");
        await this.replyBestEffort(
          row.id,
          metadata.message.messageId,
          row.externalEventId,
          "请在 @DevProof 后附上 Linear Issue ID 或 URL，例如：ENG-123。",
        );
        return;
      }
      if (!row.team) {
        throw new Error("The Feishu tenant is not linked to a DevProof team.");
      }
      const userId = await this.resolveSender(row.team.id, metadata);
      if (!userId) {
        await this.finish(row.id, "IGNORED");
        await this.replyBestEffort(
          row.id,
          metadata.message.messageId,
          row.externalEventId,
          `无法识别你的 DevProof 用户，请先登录 ${env().WEB_ORIGIN}/login 后再试。`,
        );
        return;
      }
      const profileStrategy = profileStrategyFromText(text);
      const targetUrl = extractTargetUrl(text, issueRef);
      const context: ToolAuthContext = {
        credential: {
          id: `feishu:${env().FEISHU_APP_ID}`,
          name: "Feishu DevProof bot",
          scopes: ["run:read", "run:write", "run:cancel"],
        },
        team: { id: row.team.id, name: row.team.name, slug: row.team.slug },
      };
      const task = await this.tasks.create(
        context,
        {
          idempotencyKey: `feishu-event:${row.externalEventId}`,
          issueRef,
          kind: "ISSUE_SPEC",
          profilePolicy: {
            onUnavailable: "WAIT_FOR_PROFILE",
            scope: { authRole: "default", environmentKey: "default" },
            strategy: profileStrategy,
          },
          ...(targetUrl ? { targetUrl } : {}),
        },
        {
          kind: "INTEGRATION_EVENT",
          notificationContext: {
            feishu: {
              replyToMessageId: metadata.message.messageId,
            },
          },
          triggerSource: "FEISHU",
          userId,
        },
      );
      await this.prisma.inboundIntegrationEvent.update({
        data: {
          error: Prisma.JsonNull,
          nextAttemptAt: null,
          processedAt: new Date(),
          status: "PROCESSED",
          taskExecutionId: task.id,
        },
        where: { id: row.id },
      });
      await this.replyBestEffort(
        row.id,
        metadata.message.messageId,
        row.externalEventId,
        `DevProof 任务已创建：${task.title}\n策略：${profileStrategy}\n${env().WEB_ORIGIN}/console/runs`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.inboundIntegrationEvent.update({
        data: {
          error: json({ code: "FEISHU_EVENT_PROCESSING_FAILED", message }),
          nextAttemptAt:
            row.attempts < 10
              ? new Date(
                  Date.now() +
                    Math.min(60 * 60_000, 10_000 * 2 ** (row.attempts - 1)),
                )
              : null,
          processedAt: new Date(),
          status: "FAILED",
        },
        where: { id: row.id },
      });
      await this.replyToMessage(
        metadata.message.messageId,
        row.externalEventId,
        `DevProof 创建任务失败：${message.slice(0, 500)}`,
      ).catch(() => undefined);
    }
  }

  private async resolveSender(teamId: string, metadata: FeishuEventMetadata) {
    const candidates = [
      ...(metadata.sender.openId
        ? [
            {
              externalUserId: metadata.sender.openId,
              issuerKey: env().FEISHU_APP_ID,
              provider: "FEISHU_OPEN_ID" as const,
            },
          ]
        : []),
      ...(metadata.sender.unionId
        ? [
            {
              externalUserId: metadata.sender.unionId,
              issuerKey: metadata.tenantKey,
              provider: "FEISHU_UNION_ID" as const,
            },
          ]
        : []),
    ];
    for (const candidate of candidates) {
      const identity = await this.prisma.userExternalIdentity.findUnique({
        include: { user: true },
        where: { provider_issuerKey_externalUserId: candidate },
      });
      if (identity?.teamId === teamId && identity.user.status === "ACTIVE") {
        return identity.userId;
      }
    }
    if (!metadata.sender.openId) return null;
    const legacy = await this.prisma.authIdentity.findUnique({
      include: {
        user: {
          include: { memberships: { where: { teamId } } },
        },
      },
      where: {
        provider_providerUserId: {
          provider: "FEISHU",
          providerUserId: metadata.sender.openId,
        },
      },
    });
    if (!legacy?.user.memberships.length || legacy.user.status !== "ACTIVE") {
      return null;
    }
    await this.prisma.userExternalIdentity.upsert({
      create: {
        externalUserId: metadata.sender.openId,
        issuerKey: env().FEISHU_APP_ID,
        metadata: json({ source: "AUTH_IDENTITY_BACKFILL" }),
        provider: "FEISHU_OPEN_ID",
        teamId,
        userId: legacy.userId,
        verifiedAt: new Date(),
      },
      update: { verifiedAt: new Date() },
      where: {
        provider_issuerKey_externalUserId: {
          externalUserId: metadata.sender.openId,
          issuerKey: env().FEISHU_APP_ID,
          provider: "FEISHU_OPEN_ID",
        },
      },
    });
    return legacy.userId;
  }

  private finish(id: string, status: "IGNORED" | "PROCESSED") {
    return this.prisma.inboundIntegrationEvent.update({
      data: {
        error: Prisma.JsonNull,
        nextAttemptAt: null,
        processedAt: new Date(),
        status,
      },
      where: { id },
    });
  }

  private async replyBestEffort(
    integrationEventId: string,
    messageId: string,
    eventId: string,
    text: string,
  ) {
    try {
      await this.replyToMessage(messageId, eventId, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Feishu reply failed: ${message}`);
      await this.prisma.inboundIntegrationEvent.update({
        data: {
          error: json({ code: "FEISHU_REPLY_FAILED", message }),
        },
        where: { id: integrationEventId },
      });
    }
  }

  async replyToMessage(messageId: string, dedupeKey: string, text: string) {
    const token = await this.tenantAccessToken();
    const url = new URL(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
    );
    url.searchParams.set("uuid", dedupeKey);
    const response = await fetch(url, {
      body: JSON.stringify({
        content: JSON.stringify({ text }),
        msg_type: "text",
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    const result = asRecord(await response.json().catch(() => ({})));
    if (!response.ok || Number(result.code) !== 0) {
      throw new Error(
        `Feishu reply failed: ${String(result.msg ?? response.status)}`,
      );
    }
  }

  private async tenantAccessToken() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    const response = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        body: JSON.stringify({
          app_id: env().FEISHU_APP_ID,
          app_secret: env().FEISHU_APP_SECRET,
        }),
        headers: { "content-type": "application/json; charset=utf-8" },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const token = tokenResponseSchema.parse(await response.json());
    this.accessToken = {
      expiresAt: Date.now() + Math.max(60, token.expiresIn) * 1_000,
      value: token.token,
    };
    return token.token;
  }
}

export function verifyFeishuSignature(input: {
  encryptKey: string;
  nonce: string;
  rawBody: Buffer;
  signature: string;
  timestamp: string;
}) {
  if (!/^\d{10,13}$/u.test(input.timestamp)) return false;
  const seconds = Number(input.timestamp.slice(0, 10));
  if (Math.abs(Date.now() / 1_000 - seconds) > 5 * 60) return false;
  const expected = createHash("sha256")
    .update(input.timestamp)
    .update(input.nonce)
    .update(input.encryptKey)
    .update(input.rawBody)
    .digest("hex");
  const actual = Buffer.from(input.signature.toLowerCase(), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function decryptFeishuPayload(encrypted: string, encryptKey: string) {
  const key = createHash("sha256").update(encryptKey).digest();
  const encryptedBuffer = Buffer.from(encrypted, "base64");
  if (encryptedBuffer.length <= 16) {
    throw new Error("Feishu encrypted payload is too short.");
  }
  const decipher = createDecipheriv(
    "aes-256-cbc",
    key,
    encryptedBuffer.subarray(0, 16),
  );
  return JSON.parse(
    Buffer.concat([
      decipher.update(encryptedBuffer.subarray(16)),
      decipher.final(),
    ]).toString("utf8"),
  ) as unknown;
}

export function normalizeFeishuEvent(value: unknown): {
  challenge: string | null;
  eventId: string | null;
  metadata: FeishuEventMetadata | null;
  token: string | null;
} {
  const root = asRecord(value);
  const header = asRecord(root.header);
  const event = asRecord(root.event);
  const message = asRecord(event.message);
  const sender = asRecord(event.sender);
  const senderId = asRecord(sender.sender_id);
  const content = parseJsonRecord(message.content);
  const mentions = Array.isArray(message.mentions)
    ? message.mentions.map(asRecord).map((mention) => {
        const id = asRecord(mention.id);
        return {
          key: stringValue(mention.key),
          name: stringValue(mention.name),
          openId: stringValue(id.open_id) || null,
        };
      })
    : [];
  const appId = stringValue(header.app_id);
  const tenantKey = stringValue(header.tenant_key || sender.tenant_key);
  const eventId = stringValue(header.event_id);
  const eventType = stringValue(header.event_type);
  const messageId = stringValue(message.message_id);
  return {
    challenge: stringValue(root.challenge) || null,
    eventId: eventId || null,
    metadata:
      appId && tenantKey && eventId && eventType && messageId
        ? {
            appId,
            eventType,
            message: {
              chatId: stringValue(message.chat_id),
              chatType: stringValue(message.chat_type),
              mentions,
              messageId,
              messageType: stringValue(message.message_type),
              text: stringValue(content.text),
            },
            sender: {
              openId: stringValue(senderId.open_id) || null,
              unionId: stringValue(senderId.union_id) || null,
              userId: stringValue(senderId.user_id) || null,
            },
            tenantKey,
          }
        : null,
    token: stringValue(root.token || header.token) || null,
  };
}

function parseMetadata(value: Prisma.JsonValue) {
  const normalized = normalizeFeishuEventMetadata(value);
  if (!normalized) throw new Error("Stored Feishu event metadata is invalid.");
  return normalized;
}

function normalizeFeishuEventMetadata(
  value: unknown,
): FeishuEventMetadata | null {
  const record = asRecord(value);
  return typeof record.appId === "string" &&
    typeof record.eventType === "string"
    ? (value as FeishuEventMetadata)
    : null;
}

function stripMentions(text: string, mentions: Array<{ key: string }>) {
  return mentions
    .reduce((current, mention) => current.replaceAll(mention.key, ""), text)
    .trim();
}

export function isTargetBotMentioned(
  mentions: Array<{ openId: string | null }>,
  botOpenId: string,
) {
  return mentions.some((mention) => mention.openId === botOpenId);
}

export function extractIssueRef(text: string) {
  const url = text.match(
    /https:\/\/linear\.app\/[^\s]+\/issue\/[^\s?#]+/iu,
  )?.[0];
  return url ?? text.match(/\b[A-Z][A-Z0-9]{1,20}-\d+\b/u)?.[0] ?? null;
}

export function profileStrategyFromText(text: string) {
  return /(?:^|\s)--ephemeral(?:\s|$)|临时会话/iu.test(text)
    ? ("EPHEMERAL" as const)
    : /(?:^|\s)--owner(?:\s|$)|issue\s*owner|负责人/iu.test(text)
      ? ("ISSUE_ASSIGNEE" as const)
      : ("REQUESTER" as const);
}

function extractTargetUrl(text: string, issueRef: string) {
  const urls = text.match(/https?:\/\/[^\s<>]+/giu) ?? [];
  return urls.find((url) => url !== issueRef && !url.includes("linear.app/"));
}

function parseJsonRecord(value: unknown) {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
