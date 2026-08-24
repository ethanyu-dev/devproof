import { randomBytes } from "node:crypto";

import {
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "../config/env.js";
import { AuthGuard } from "./auth.guard.js";
import {
  AuthService,
  FEISHU_STATE_COOKIE,
  SESSION_COOKIE,
} from "./auth.service.js";
import type { AuthContext } from "./auth.types.js";
import { CurrentAuth } from "./current-auth.decorator.js";
import {
  TenantAccessDeniedError,
  FeishuOAuthClient,
} from "./feishu-oauth.client.js";

export function redirectFound(reply: FastifyReply, location: string) {
  return reply.status(302).redirect(location);
}

@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly feishu: FeishuOAuthClient,
  ) {}

  @Get("feishu/start")
  start(@Res() reply: FastifyReply) {
    const state = randomBytes(24).toString("base64url");
    reply.setCookie(FEISHU_STATE_COOKIE, state, {
      httpOnly: true,
      maxAge: 600,
      path: "/auth/feishu/callback",
      sameSite: "lax",
      secure: env().NODE_ENV === "production",
    });
    return redirectFound(reply, this.feishu.buildAuthorizationUrl(state));
  }

  @Get("feishu/callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const expectedState = request.cookies[FEISHU_STATE_COOKIE];
    reply.clearCookie(FEISHU_STATE_COOKIE, {
      path: "/auth/feishu/callback",
    });

    if (!code || !state || !expectedState || state !== expectedState) {
      return redirectFound(
        reply,
        env().WEB_ORIGIN + "/login?error=invalid_state",
      );
    }

    try {
      const profile = await this.feishu.exchangeCode(code);
      const session = await this.auth.createTenantSession(profile);
      reply.setCookie(SESSION_COOKIE, session.sessionToken, {
        expires: session.expiresAt,
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: env().NODE_ENV === "production",
      });
      return redirectFound(reply, env().WEB_ORIGIN + "/console/playground");
    } catch (error) {
      if (error instanceof TenantAccessDeniedError) {
        return redirectFound(
          reply,
          env().WEB_ORIGIN + "/login?error=tenant_denied",
        );
      }
      this.logger.error("Feishu SSO callback failed", error);
      return redirectFound(reply, env().WEB_ORIGIN + "/login?error=sso_failed");
    }
  }

  @Get("me")
  @UseGuards(AuthGuard)
  me(@CurrentAuth() current: AuthContext) {
    return current;
  }

  @Post("logout")
  @UseGuards(AuthGuard)
  async logout(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    await this.auth.revoke(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  }
}
