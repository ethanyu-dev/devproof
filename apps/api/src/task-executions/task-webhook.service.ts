import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { taskWebhookCreateInputSchema } from "@devproof/contracts";
import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { CredentialCipherService } from "../security/credential-cipher.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { parseBody } from "../common/validation.js";

const webhookSelect = {
  id: true,
  taskId: true,
  url: true,
  events: true,
  disabledAt: true,
  createdAt: true,
} as const;
export function webhookSignature(
  secret: string,
  timestamp: string,
  body: string,
) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}
export function assertWebhookOrigin(value: string, allowedOrigins: string) {
  const url = new URL(value);
  // Empty configuration allows all HTTP(S) destinations, including local and private networks.
  const allowed = allowedOrigins
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (allowed.length > 0 && !allowed.includes(url.origin))
  ) {
    throw new BadRequestException(
      "Webhook URL must use HTTP(S) without credentials or fragments and match TASK_WEBHOOK_ALLOWED_ORIGINS when configured.",
    );
  }
}

@Injectable()
export class TaskWebhookService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private polling = false;
  private readonly logger = new Logger(TaskWebhookService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipherService,
  ) {}

  async create(current: ToolAuthContext, taskId: string, body: unknown) {
    const input = parseBody(taskWebhookCreateInputSchema, body);
    assertWebhookOrigin(input.url, env().TASK_WEBHOOK_ALLOWED_ORIGINS);
    await this.ownedTask(current, taskId);
    const credential = await this.prisma.toolCredential.findFirst({
      where: { id: current.credential.id, teamId: current.team.id },
    });
    if (!credential)
      throw new BadRequestException("A service access token is required.");
    const secret = randomBytes(32).toString("base64url");
    // Upsert does not rotate the secret on a transport retry. A disabled subscription must be recreated with a different URL.
    const row = await this.prisma.taskWebhook.upsert({
      where: {
        taskId_credentialId_url: {
          taskId,
          credentialId: credential.id,
          url: input.url,
        },
      },
      create: {
        taskId,
        credentialId: credential.id,
        url: input.url,
        events: input.events,
        secretEnvelope: this.cipher.encrypt(secret),
      },
      update: {},
    });
    if (row.disabledAt)
      throw new ConflictException(
        "This subscription is disabled; use a new callback URL to create a new subscription.",
      );
    if (
      [...new Set(row.events)].sort().join() !==
      [...new Set(input.events)].sort().join()
    )
      throw new ConflictException(
        "This callback URL is already subscribed with different events.",
      );
    return {
      ...publicWebhook(row),
      signingSecret: this.cipher.decrypt(row.secretEnvelope),
    };
  }
  async list(current: ToolAuthContext, taskId: string) {
    await this.ownedTask(current, taskId);
    return this.prisma.taskWebhook.findMany({
      where: { taskId, credentialId: current.credential.id },
      select: webhookSelect,
    });
  }
  async disable(current: ToolAuthContext, taskId: string, id: string) {
    await this.ownedTask(current, taskId);
    const updated = await this.prisma.taskWebhook.updateMany({
      where: { id, taskId, credentialId: current.credential.id },
      data: { disabledAt: new Date() },
    });
    if (!updated.count) throw new NotFoundException("Webhook was not found.");
    return { ok: true };
  }
  async deliveries(current: ToolAuthContext, taskId: string, id: string) {
    await this.ownedTask(current, taskId);
    const hook = await this.prisma.taskWebhook.findFirst({
      where: { id, taskId, credentialId: current.credential.id },
      select: { id: true },
    });
    if (!hook) throw new NotFoundException("Webhook was not found.");
    return this.prisma.taskWebhookDelivery.findMany({
      where: { webhookId: id },
      take: 100,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        eventId: true,
        status: true,
        attempts: true,
        nextAttemptAt: true,
        lastError: true,
        deliveredAt: true,
      },
    });
  }
  async retryDelivery(
    current: ToolAuthContext,
    taskId: string,
    webhookId: string,
    deliveryId: string,
  ) {
    await this.ownedTask(current, taskId);
    const updated = await this.prisma.taskWebhookDelivery.updateMany({
      where: {
        id: deliveryId,
        webhookId,
        status: "FAILED",
        webhook: {
          taskId,
          credentialId: current.credential.id,
          disabledAt: null,
        },
      },
      data: {
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: null,
      },
    });
    if (!updated.count)
      throw new ConflictException(
        "No failed delivery for this active subscription was found.",
      );
    return { ok: true };
  }
  private async ownedTask(current: ToolAuthContext, taskId: string) {
    if (
      !(await this.prisma.taskExecution.findFirst({
        where: { id: taskId, teamId: current.team.id },
        select: { id: true },
      }))
    )
      throw new NotFoundException("Task was not found.");
  }
  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.timer = setInterval(() => {
      void this.poll().catch(() =>
        this.logger.error("Task webhook polling failed."),
      );
    }, env().BACKGROUND_WORKER_POLL_MS);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      // Event relations, rather than a global sequence cursor, avoid skipping late-committing transactions.
      // Replay matching existing events on subscription so a fast task cannot finish before subscription registration.
      let cursor: string | undefined;
      for (;;) {
        const hooks = await this.prisma.taskWebhook.findMany({
          where: {
            disabledAt: null,
            credential: {
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
          },
          take: 100,
          orderBy: { id: "asc" },
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const hook of hooks) {
          const events = await this.prisma.taskExecutionEvent.findMany({
            where: {
              taskExecutionId: hook.taskId,
              kind: { in: hook.events },
              webhookDeliveries: { none: { webhookId: hook.id } },
            },
            take: 100,
            orderBy: { sequence: "asc" },
            select: { id: true },
          });
          if (events.length)
            await this.prisma.taskWebhookDelivery.createMany({
              data: events.map((event) => ({
                webhookId: hook.id,
                eventId: event.id,
              })),
              skipDuplicates: true,
            });
        }
        if (hooks.length < 100) break;
        cursor = hooks.at(-1)!.id;
      }
      const due = await this.prisma.taskWebhookDelivery.findMany({
        where: {
          status: "PENDING",
          nextAttemptAt: { lte: new Date() },
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lt: new Date() } },
          ],
          webhook: {
            disabledAt: null,
            credential: {
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
          },
        },
        take: 20,
        orderBy: { nextAttemptAt: "asc" },
        select: { id: true },
      });
      await Promise.all(due.map((delivery) => this.deliver(delivery.id)));
    } finally {
      this.polling = false;
    }
  }

  async deliver(id: string) {
    const leaseToken = randomUUID();
    const now = new Date();
    const claimed = await this.prisma.taskWebhookDelivery.updateMany({
      where: {
        id,
        status: "PENDING",
        nextAttemptAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: {
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        attempts: { increment: 1 },
      },
    });
    if (!claimed.count) return;
    const row = await this.prisma.taskWebhookDelivery.findUniqueOrThrow({
      where: { id },
      include: {
        webhook: {
          include: {
            credential: true,
            task: { select: { externalId: true, externalSource: true } },
          },
        },
        event: true,
      },
    });
    const fenced = { id, leaseToken };
    const credential = row.webhook.credential;
    if (
      row.webhook.disabledAt ||
      credential.revokedAt ||
      (credential.expiresAt && credential.expiresAt <= now)
    ) {
      await this.prisma.taskWebhookDelivery.updateMany({
        where: fenced,
        data: { status: "CANCELLED", leaseToken: null, leaseExpiresAt: null },
      });
      return;
    }
    try {
      assertWebhookOrigin(row.webhook.url, env().TASK_WEBHOOK_ALLOWED_ORIGINS);
      const timestamp = String(Math.floor(Date.now() / 1000));
      // Do not send raw event payloads (which can contain account input or internal evidence).
      const body = JSON.stringify({
        id: row.eventId,
        deliveryId: row.id,
        type: row.event.kind,
        taskId: row.webhook.taskId,
        sequence: String(row.event.sequence),
        occurredAt: row.event.occurredAt.toISOString(),
        externalReference: row.webhook.task.externalSource
          ? {
              source: row.webhook.task.externalSource,
              externalId: row.webhook.task.externalId,
            }
          : null,
      });
      const response = await fetch(row.webhook.url, {
        method: "POST",
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "X-DevProof-Event-Id": row.eventId,
          "X-DevProof-Timestamp": timestamp,
          "X-DevProof-Signature": `sha256=${webhookSignature(this.cipher.decrypt(row.webhook.secretEnvelope), timestamp, body)}`,
        },
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await this.prisma.taskWebhookDelivery.updateMany({
        where: fenced,
        data: {
          status: "DELIVERED",
          deliveredAt: new Date(),
          lastError: null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error && /^HTTP \d{3}$/u.test(error.message)
          ? error.message
          : "Delivery failed (network, timeout, or destination policy).";
      await this.prisma.taskWebhookDelivery.updateMany({
        where: fenced,
        data: {
          status: row.attempts >= 8 ? "FAILED" : "PENDING",
          nextAttemptAt: new Date(
            Date.now() + Math.min(3_600_000, 5_000 * 2 ** row.attempts),
          ),
          lastError: message,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
    }
  }
}
function publicWebhook(row: Prisma.TaskWebhookGetPayload<{}>) {
  return {
    id: row.id,
    taskId: row.taskId,
    url: row.url,
    events: row.events,
    disabledAt: row.disabledAt,
    createdAt: row.createdAt,
  };
}
