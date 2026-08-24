import { createCipheriv, createHash } from "node:crypto";

import { ForbiddenException } from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvForTests } from "../config/env.js";
import { FeishuEventsController } from "./feishu-events.controller.js";
import type { FeishuIntegrationService } from "./feishu-integration.service.js";

const encryptKey = "event-encrypt-key";
const verificationToken = "verification-token";

beforeEach(() => {
  vi.stubEnv(
    "CREDENTIAL_ENCRYPTION_KEY",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  );
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://devproof:devproof@localhost/devproof",
  );
  vi.stubEnv("FEISHU_ALLOWED_TENANT_KEY", "tenant-1");
  vi.stubEnv("FEISHU_APP_ID", "cli_app");
  vi.stubEnv("FEISHU_APP_SECRET", "ci-test-secret");
  vi.stubEnv("FEISHU_BOT_ENABLED", "true");
  vi.stubEnv("FEISHU_BOT_OPEN_ID", "ou_devproof_bot");
  vi.stubEnv("FEISHU_EVENT_ENCRYPT_KEY", encryptKey);
  vi.stubEnv("FEISHU_EVENT_VERIFICATION_TOKEN", verificationToken);
  vi.stubEnv(
    "FEISHU_REDIRECT_URI",
    "http://localhost:3344/auth/feishu/callback",
  );
  vi.stubEnv("NODE_ENV", "test");
  resetEnvForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("FeishuEventsController", () => {
  it("returns an unsigned plaintext URL verification challenge", async () => {
    const { controller, enqueue } = createController();

    await expect(
      controller.events(request(), {
        challenge: "challenge-1",
        token: verificationToken,
        type: "url_verification",
      }),
    ).resolves.toEqual({ challenge: "challenge-1" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("decrypts and returns an unsigned encrypted URL verification challenge", async () => {
    const { controller } = createController();
    const payload = encrypt({
      challenge: "challenge-2",
      token: verificationToken,
      type: "url_verification",
    });

    await expect(controller.events(request(), payload)).resolves.toEqual({
      challenge: "challenge-2",
    });
  });

  it("rejects a URL verification challenge with the wrong token", async () => {
    const { controller } = createController();

    await expect(
      controller.events(request(), {
        challenge: "challenge-3",
        token: "wrong-token",
        type: "url_verification",
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("rejects malformed encrypted payloads without enqueueing them", async () => {
    const { controller, enqueue } = createController();

    await expect(
      controller.events(request(), { encrypt: "not-a-feishu-payload" }),
    ).rejects.toThrow("Feishu encrypted payload is invalid.");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("continues to require a valid signature for ordinary events", async () => {
    const { controller, enqueue } = createController();
    const body = eventBody();

    await expect(
      controller.events(request(Buffer.from(JSON.stringify(body))), body),
    ).rejects.toThrow("Feishu event signature is invalid.");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("accepts a signed ordinary event and returns HTTP 200 metadata", async () => {
    const { controller, enqueue } = createController();
    const body = eventBody();
    const rawBody = Buffer.from(JSON.stringify(body));
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const nonce = "nonce-1";
    const signature = createHash("sha256")
      .update(timestamp)
      .update(nonce)
      .update(encryptKey)
      .update(rawBody)
      .digest("hex");

    await expect(
      controller.events(request(rawBody), body, timestamp, nonce, signature),
    ).resolves.toEqual({ accepted: true });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        FeishuEventsController.prototype.events,
      ),
    ).toBe(200);
  });
});

function createController() {
  const enqueue = vi.fn().mockResolvedValue({ accepted: true });
  const controller = new FeishuEventsController({
    enqueue,
  } as unknown as FeishuIntegrationService);
  return { controller, enqueue };
}

function request(rawBody?: Buffer) {
  return { rawBody } as FastifyRequest & { rawBody?: Buffer };
}

function encrypt(payload: unknown) {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return {
    encrypt: Buffer.concat([
      iv,
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]).toString("base64"),
  };
}

function eventBody() {
  return {
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
      token: verificationToken,
    },
  };
}
