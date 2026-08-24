import { ForbiddenException, Injectable } from "@nestjs/common";
import { z } from "zod";

import { env } from "../config/env.js";

const tokenResponseSchema = z.object({
  code: z.number(),
  access_token: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const userResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      avatar_url: z.string().optional(),
      email: z.string().optional(),
      enterprise_email: z.string().optional(),
      name: z.string().optional(),
      open_id: z.string(),
      tenant_key: z.string(),
      union_id: z.string().optional(),
    })
    .optional(),
});

export interface FeishuProfile {
  avatarUrl: string | null;
  email: string | null;
  name: string | null;
  openId: string;
  tenantKey: string;
  unionId: string | null;
}

export class TenantAccessDeniedError extends ForbiddenException {
  constructor() {
    super("Only members of the configured Feishu tenant can sign in.");
  }
}

export function assertAllowedTenant(actual: string, allowed: string) {
  if (!actual || actual !== allowed) {
    throw new TenantAccessDeniedError();
  }
}

@Injectable()
export class FeishuOAuthClient {
  buildAuthorizationUrl(state: string): string {
    const config = env();
    const url = new URL(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    url.searchParams.set("client_id", config.FEISHU_APP_ID);
    url.searchParams.set("redirect_uri", config.FEISHU_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<FeishuProfile> {
    const config = env();
    const tokenResponse = await fetch(
      "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      {
        body: JSON.stringify({
          client_id: config.FEISHU_APP_ID,
          client_secret: config.FEISHU_APP_SECRET,
          code,
          grant_type: "authorization_code",
          redirect_uri: config.FEISHU_REDIRECT_URI,
        }),
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        method: "POST",
      },
    );
    const token = tokenResponseSchema.parse(await tokenResponse.json());
    if (!tokenResponse.ok || token.code !== 0 || !token.access_token) {
      throw new Error(
        "Feishu token exchange failed: " +
          (token.error_description ?? token.error ?? String(token.code)),
      );
    }

    const profileResponse = await fetch(
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
      {
        headers: {
          authorization: "Bearer " + token.access_token,
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
    const profileResult = userResponseSchema.parse(
      await profileResponse.json(),
    );
    if (
      !profileResponse.ok ||
      profileResult.code !== 0 ||
      !profileResult.data
    ) {
      throw new Error(
        "Feishu user info request failed: " +
          (profileResult.msg ?? String(profileResult.code)),
      );
    }

    assertAllowedTenant(
      profileResult.data.tenant_key,
      config.FEISHU_ALLOWED_TENANT_KEY,
    );

    return {
      avatarUrl: profileResult.data.avatar_url ?? null,
      email:
        profileResult.data.enterprise_email ?? profileResult.data.email ?? null,
      name: profileResult.data.name ?? null,
      openId: profileResult.data.open_id,
      tenantKey: profileResult.data.tenant_key,
      unionId: profileResult.data.union_id ?? null,
    };
  }
}
