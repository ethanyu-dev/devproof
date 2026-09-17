import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decryptFeishuPayload,
  extractIssueRef,
  FeishuIntegrationService,
  isTargetBotMentioned,
  normalizeFeishuEvent,
  profileStrategyFromText,
  verifyFeishuSignature,
} from "./feishu-integration.service.js";
import { buildFeishuTaskCard } from "./feishu-task-card.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Feishu integration security and parsing", () => {
  it("verifies the exact raw request and rejects stale or altered requests", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T08:00:00.000Z"));
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const nonce = "nonce-1";
    const encryptKey = "event-encrypt-key";
    const rawBody = Buffer.from('{"encrypt":"payload"}', "utf8");
    const signature = createHash("sha256")
      .update(timestamp)
      .update(nonce)
      .update(encryptKey)
      .update(rawBody)
      .digest("hex");

    expect(
      verifyFeishuSignature({
        encryptKey,
        nonce,
        rawBody,
        signature,
        timestamp,
      }),
    ).toBe(true);
    expect(
      verifyFeishuSignature({
        encryptKey,
        nonce,
        rawBody: Buffer.from('{"encrypt":"tampered"}', "utf8"),
        signature,
        timestamp,
      }),
    ).toBe(false);
    expect(
      verifyFeishuSignature({
        encryptKey,
        nonce,
        rawBody,
        signature,
        timestamp: String(Number(timestamp) - 301),
      }),
    ).toBe(false);
    vi.useRealTimers();
  });

  it("decrypts encrypted event payloads with the configured key", () => {
    const encryptKey = "event-encrypt-key";
    const payload = {
      challenge: "challenge-1",
      token: "verification-token",
    };
    const encrypted =
      "AAECAwQFBgcICQoLDA0OD1ks+PWUf08Cl00NIC1iGc9FQoWtoNkbmg9hX5kkfhNjDquniWCNiWD69NBfSmGd3MF/g/AyOSY0/25ChfGAXQM=";

    expect(decryptFeishuPayload(encrypted, encryptKey)).toEqual(payload);
  });

  it("rejects payloads without a Feishu IV prefix", () => {
    expect(() => decryptFeishuPayload("c2hvcnQ=", "event-encrypt-key")).toThrow(
      "Feishu encrypted payload is too short.",
    );
  });

  it("normalizes sender identity and message metadata without storing raw content", () => {
    expect(
      normalizeFeishuEvent({
        event: {
          message: {
            chat_id: "chat-1",
            chat_type: "group",
            content: JSON.stringify({ text: "@_user_1 ENG-123" }),
            mentions: [
              {
                id: { open_id: "ou_devproof_bot" },
                key: "@_user_1",
                name: "DevProof",
              },
            ],
            message_id: "message-1",
            message_type: "text",
          },
          sender: {
            sender_id: { open_id: "ou_sender", union_id: "on_sender" },
          },
        },
        header: {
          app_id: "cli_app",
          event_id: "event-1",
          event_type: "im.message.receive_v1",
          tenant_key: "tenant-1",
          token: "verification-token",
        },
      }),
    ).toMatchObject({
      eventId: "event-1",
      metadata: {
        appId: "cli_app",
        message: {
          mentions: [
            {
              key: "@_user_1",
              name: "DevProof",
              openId: "ou_devproof_bot",
            },
          ],
          text: "@_user_1 ENG-123",
        },
        sender: { openId: "ou_sender", unionId: "on_sender" },
        tenantKey: "tenant-1",
      },
      token: "verification-token",
    });
  });

  it("requires a group mention to target this bot's stable open id", () => {
    const mentions = [
      { openId: "ou_someone_else" },
      { openId: "ou_devproof_bot" },
    ];
    expect(isTargetBotMentioned(mentions, "ou_devproof_bot")).toBe(true);
    expect(isTargetBotMentioned(mentions, "ou_other_bot")).toBe(false);
    expect(isTargetBotMentioned([{ openId: null }], "ou_devproof_bot")).toBe(
      false,
    );
  });

  it("extracts Linear references and applies explicit profile strategy precedence", () => {
    expect(extractIssueRef("please run ENG-123 now")).toBe("ENG-123");
    expect(
      extractIssueRef(
        "https://linear.app/acme/issue/ENG-123/refund?tab=activity",
      ),
    ).toBe("https://linear.app/acme/issue/ENG-123/refund");
    expect(profileStrategyFromText("ENG-123")).toBe("REQUESTER");
    expect(profileStrategyFromText("ENG-123 --profile")).toBe("REQUESTER");
    expect(profileStrategyFromText("ENG-123 需要登录")).toBe("REQUESTER");
    expect(profileStrategyFromText("ENG-123 不需要登录")).toBe("EPHEMERAL");
    expect(profileStrategyFromText("ENG-123 --owner")).toBe("ISSUE_ASSIGNEE");
    expect(profileStrategyFromText("ENG-123 --owner --ephemeral")).toBe(
      "EPHEMERAL",
    );
  });
});

describe("Feishu interactive message API", () => {
  it("replies with an interactive card and later updates that exact message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            expire: 7200,
            tenant_access_token: "tenant-token",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { message_id: "card-message-1" } }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const service = new FeishuIntegrationService({} as never, {} as never);
    const createdCard = buildFeishuTaskCard(
      { goal: "ENG-123", notificationKind: "TASK_CREATED" },
      "https://devproof.example.com/console/runs?task=task-1",
    );
    const completedCard = buildFeishuTaskCard(
      {
        goal: "ENG-123",
        notificationKind: "TASK_COMPLETED",
        verdict: "PASSED",
      },
      "https://devproof.example.com/console/runs?task=task-1",
    );

    await expect(
      service.replyCardToMessage("source-message", "delivery-1", createdCard),
    ).resolves.toBe("card-message-1");
    await service.updateCardMessage("card-message-1", completedCard);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/im/v1/messages/source-message/reply",
      expect.objectContaining({
        body: expect.stringContaining('"msg_type":"interactive"'),
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://open.feishu.cn/open-apis/im/v1/messages/card-message-1",
      expect.objectContaining({
        body: expect.stringContaining("DevProof · 验证通过"),
        method: "PATCH",
      }),
    );
  });
});

describe("Feishu task creation", () => {
  function harness(text: string, existingTaskId?: string) {
    const row = {
      id: "inbound-1",
      externalEventId: "event-1",
      attempts: 1,
      team: { id: "team-1", name: "Team", slug: "team" },
      metadata: {
        appId: "cli_app",
        eventType: "im.message.receive_v1",
        tenantKey: "tenant-1",
        sender: { openId: "sender" },
        message: {
          chatId: "chat-1",
          chatType: "p2p",
          messageId: "message-1",
          messageType: "text",
          mentions: [],
          text,
        },
      },
    };
    const events = {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockResolvedValue(row),
    };
    const task = { id: existingTaskId ?? "task-1", title: "订单保存" };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      detail: vi.fn().mockResolvedValue(task),
    };
    const findTask = vi
      .fn()
      .mockResolvedValue(existingTaskId ? { id: existingTaskId } : null);
    const service = new FeishuIntegrationService(
      {
        inboundIntegrationEvent: events,
        taskExecution: { findUnique: findTask },
      } as never,
      tasks as never,
    );
    const internal = service as unknown as {
      process(id: string): Promise<void>;
      resolveSender(): Promise<string>;
      replyBestEffort(...args: unknown[]): Promise<void>;
      replyTaskCardBestEffort(...args: unknown[]): Promise<void>;
    };
    vi.spyOn(internal, "resolveSender").mockResolvedValue("user-1");
    const reply = vi.spyOn(internal, "replyBestEffort").mockResolvedValue();
    const card = vi
      .spyOn(internal, "replyTaskCardBestEffort")
      .mockResolvedValue();
    return { internal, events, tasks, findTask, reply, card };
  }
  it("creates a PR-only task with requester identity and the actual environment", async () => {
    const h = harness(
      "https://github.com/acme/web/pull/42/files --target https://preview.example.com",
    );
    await h.internal.process("inbound-1");
    expect(h.tasks.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "SPEC_TASK",
        idempotencyKey: "feishu-event:event-1",
        pullRequestUrls: ["https://github.com/acme/web/pull/42"],
        profilePolicy: expect.objectContaining({ strategy: "REQUESTER" }),
        deployments: [
          expect.objectContaining({ targetUrl: "https://preview.example.com" }),
        ],
      }),
      expect.objectContaining({ triggerSource: "FEISHU", userId: "user-1" }),
    );
    expect(h.tasks.create.mock.calls[0]![1]).not.toHaveProperty("issueRef");
    expect(h.events.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PROCESSED",
          taskExecutionId: "task-1",
        }),
      }),
    );
    expect(h.card).toHaveBeenCalledOnce();
  });
  it("reuses a task committed before event completion, including legacy tasks", async () => {
    const h = harness("ENG-123 https://preview.example.com", "legacy-task");
    await h.internal.process("inbound-1");
    expect(h.tasks.create).not.toHaveBeenCalled();
    expect(h.tasks.detail).toHaveBeenCalledWith(
      expect.anything(),
      "legacy-task",
    );
    expect(h.card).toHaveBeenCalledWith(
      expect.objectContaining({ taskExecutionId: "legacy-task" }),
    );
  });
  it.each([
    "https://github.com/acme/web/pull/42 --owner",
    "https://github.com/acme/web/pull/42 https://a.example.com https://b.example.com",
  ])(
    "marks invalid commands permanent instead of retrying: %s",
    async (text) => {
      const h = harness(text);
      await h.internal.process("inbound-1");
      expect(h.tasks.create).not.toHaveBeenCalled();
      expect(h.events.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "IGNORED",
            nextAttemptAt: null,
          }),
        }),
      );
      expect(h.reply).toHaveBeenCalledOnce();
    },
  );
});
