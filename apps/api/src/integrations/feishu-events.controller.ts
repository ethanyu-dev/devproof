import { createHash } from "node:crypto";

import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { env } from "../config/env.js";
import {
  decryptFeishuPayload,
  FeishuIntegrationService,
  normalizeFeishuEvent,
  verifyFeishuSignature,
} from "./feishu-integration.service.js";

@Controller("integrations/feishu")
export class FeishuEventsController {
  constructor(private readonly feishu: FeishuIntegrationService) {}

  @Post("events")
  @HttpCode(HttpStatus.OK)
  async events(
    @Req() request: FastifyRequest & { rawBody?: Buffer },
    @Body() body: unknown,
    @Headers("x-lark-request-timestamp") timestamp?: string,
    @Headers("x-lark-request-nonce") nonce?: string,
    @Headers("x-lark-signature") signature?: string,
  ) {
    const config = env();
    if (!config.FEISHU_BOT_ENABLED) {
      throw new ForbiddenException("Feishu bot events are disabled.");
    }
    const eventEncryptKey = config.FEISHU_EVENT_ENCRYPT_KEY;
    if (!eventEncryptKey) {
      throw new ForbiddenException(
        "Feishu event encryption is not configured.",
      );
    }
    const outer =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    let payload: unknown;
    try {
      payload =
        typeof outer.encrypt === "string"
          ? decryptFeishuPayload(outer.encrypt, eventEncryptKey)
          : body;
    } catch {
      throw new ForbiddenException("Feishu encrypted payload is invalid.");
    }
    const normalized = normalizeFeishuEvent(payload);
    if (normalized.challenge) {
      if (normalized.token !== config.FEISHU_EVENT_VERIFICATION_TOKEN) {
        throw new ForbiddenException("Feishu verification token is invalid.");
      }
      return { challenge: normalized.challenge };
    }
    const rawBody = request.rawBody;
    if (
      !rawBody ||
      !timestamp ||
      !nonce ||
      !signature ||
      !verifyFeishuSignature({
        encryptKey: eventEncryptKey,
        nonce,
        rawBody,
        signature,
        timestamp,
      })
    ) {
      throw new ForbiddenException("Feishu event signature is invalid.");
    }
    if (normalized.token !== config.FEISHU_EVENT_VERIFICATION_TOKEN) {
      throw new ForbiddenException("Feishu verification token is invalid.");
    }
    if (
      !normalized.eventId ||
      !normalized.metadata ||
      normalized.metadata.appId !== config.FEISHU_APP_ID ||
      normalized.metadata.tenantKey !== config.FEISHU_ALLOWED_TENANT_KEY
    ) {
      throw new ForbiddenException("Feishu event issuer is invalid.");
    }
    return this.feishu.enqueue({
      eventId: normalized.eventId,
      metadata: normalized.metadata,
      payloadHash: createPayloadHash(rawBody),
    });
  }
}

function createPayloadHash(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
