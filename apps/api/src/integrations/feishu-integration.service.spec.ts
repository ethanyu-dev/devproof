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
