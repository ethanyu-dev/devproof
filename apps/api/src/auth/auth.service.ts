import { createHash, randomBytes } from "node:crypto";

import { Injectable, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import type { FeishuProfile } from "./feishu-oauth.client.js";
import type { AuthContext } from "./auth.types.js";

export const SESSION_COOKIE = "devproof_session";
export const FEISHU_STATE_COOKIE = "devproof_feishu_state";

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async createTenantSession(profile: FeishuProfile) {
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.now() + env().SESSION_TTL_HOURS * 60 * 60 * 1000,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const team = await tx.team.upsert({
        create: {
          feishuTenantKey: profile.tenantKey,
          name: env().TEAM_NAME,
          slug: "default",
        },
        update: {
          name: env().TEAM_NAME,
        },
        where: {
          feishuTenantKey: profile.tenantKey,
        },
      });

      const identity = await tx.authIdentity.findUnique({
        include: { user: true },
        where: {
          provider_providerUserId: {
            provider: "FEISHU",
            providerUserId: profile.openId,
          },
        },
      });

      const rawProfile = {
        avatarUrl: profile.avatarUrl,
        email: profile.email,
        name: profile.name,
        openId: profile.openId,
        tenantKey: profile.tenantKey,
        unionId: profile.unionId,
      };

      const user = identity
        ? await tx.user.update({
            data: {
              avatarUrl: profile.avatarUrl,
              email: profile.email,
              name: profile.name,
            },
            where: { id: identity.userId },
          })
        : await tx.user.create({
            data: {
              avatarUrl: profile.avatarUrl,
              email: profile.email,
              identities: {
                create: {
                  provider: "FEISHU",
                  providerUserId: profile.openId,
                  rawProfile,
                  tenantKey: profile.tenantKey,
                },
              },
              name: profile.name,
            },
          });

      if (identity) {
        await tx.authIdentity.update({
          data: {
            rawProfile,
            tenantKey: profile.tenantKey,
          },
          where: { id: identity.id },
        });
      }

      await tx.teamMembership.upsert({
        create: {
          teamId: team.id,
          userId: user.id,
        },
        update: {},
        where: {
          teamId_userId: {
            teamId: team.id,
            userId: user.id,
          },
        },
      });

      const normalizedEmail = profile.email?.trim().toLowerCase() ?? null;
      const externalIdentities = [
        {
          externalUserId: profile.openId,
          issuerKey: env().FEISHU_APP_ID,
          provider: "FEISHU_OPEN_ID" as const,
        },
        ...(profile.unionId
          ? [
              {
                externalUserId: profile.unionId,
                issuerKey: profile.tenantKey,
                provider: "FEISHU_UNION_ID" as const,
              },
            ]
          : []),
      ];
      for (const externalIdentity of externalIdentities) {
        await tx.userExternalIdentity.upsert({
          create: {
            ...externalIdentity,
            metadata: rawProfile,
            normalizedEmail,
            teamId: team.id,
            userId: user.id,
            verifiedAt: new Date(),
          },
          update: {
            metadata: rawProfile,
            normalizedEmail,
            teamId: team.id,
            verifiedAt: new Date(),
          },
          where: {
            provider_issuerKey_externalUserId: externalIdentity,
          },
        });
      }

      const session = await tx.session.create({
        data: {
          expiresAt,
          tokenHash: hashToken(sessionToken),
          userId: user.id,
        },
      });

      return { session, team, user };
    });

    return {
      context: {
        sessionId: result.session.id,
        team: {
          id: result.team.id,
          name: result.team.name,
          slug: result.team.slug,
        },
        user: {
          avatarUrl: result.user.avatarUrl,
          email: result.user.email,
          id: result.user.id,
          name: result.user.name,
        },
      } satisfies AuthContext,
      expiresAt,
      sessionToken,
    };
  }

  async authenticate(request: FastifyRequest): Promise<AuthContext> {
    const rawToken = request.cookies[SESSION_COOKIE];
    if (!rawToken) {
      throw new UnauthorizedException("Sign in with Feishu.");
    }

    const session = await this.prisma.session.findUnique({
      include: {
        user: {
          include: {
            memberships: {
              include: { team: true },
            },
          },
        },
      },
      where: { tokenHash: hashToken(rawToken) },
    });
    const membership = session?.user.memberships.find(
      (item) => item.team.feishuTenantKey === env().FEISHU_ALLOWED_TENANT_KEY,
    );
    if (
      !session ||
      !membership ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.user.status !== "ACTIVE"
    ) {
      throw new UnauthorizedException("Session is invalid or expired.");
    }

    return {
      sessionId: session.id,
      team: {
        id: membership.team.id,
        name: membership.team.name,
        slug: membership.team.slug,
      },
      user: {
        avatarUrl: session.user.avatarUrl,
        email: session.user.email,
        id: session.user.id,
        name: session.user.name,
      },
    };
  }

  async revoke(rawToken: string | undefined) {
    if (!rawToken) {
      return;
    }

    await this.prisma.session.updateMany({
      data: { revokedAt: new Date() },
      where: {
        revokedAt: null,
        tokenHash: hashToken(rawToken),
      },
    });
  }
}
