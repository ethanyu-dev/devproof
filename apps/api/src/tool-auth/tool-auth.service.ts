import { createHash, randomBytes } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  ToolCredentialCreateInput,
  ToolCredentialScope,
} from "@devproof/contracts";

import type { AuthContext } from "../auth/auth.types.js";
import { AuditService } from "../console/audit.service.js";
import { PrismaService } from "../database/prisma.service.js";
import type { ToolAuthContext } from "./tool-auth.types.js";

const TOKEN_PREFIX = "dvp_sk_";
export const AGENT_RUNTIME_TOKEN_PREFIX = "dvp_rt_";

export function hashToolToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function extractBearerToken(header: string | undefined): string {
  const match = header?.match(/^Bearer\s+(dvp_(?:rt|sk)_[A-Za-z0-9_-]+)$/u);
  if (!match?.[1]) {
    throw new UnauthorizedException("A valid DevProof tool token is required.");
  }
  return match[1];
}

@Injectable()
export class ToolAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(current: AuthContext) {
    return this.prisma.toolCredential.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        createdAt: true,
        expiresAt: true,
        id: true,
        lastUsedAt: true,
        name: true,
        revokedAt: true,
        scopes: true,
        tokenHint: true,
      },
      where: { teamId: current.team.id },
    });
  }

  async create(current: AuthContext, input: ToolCredentialCreateInput) {
    if ((input.scopes as readonly string[]).includes("runtime:lease")) {
      throw new ForbiddenException(
        "Agent Runtime credentials must be provisioned by an operator.",
      );
    }
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        "Tool credential expiry must be in the future.",
      );
    }

    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    let row;
    try {
      row = await this.prisma.toolCredential.create({
        data: {
          createdByUserId: current.user.id,
          expiresAt: input.expiresAt,
          name: input.name,
          scopes: input.scopes,
          teamId: current.team.id,
          tokenHash: hashToolToken(token),
          tokenHint: TOKEN_PREFIX + "••••" + token.slice(-4),
        },
        select: {
          createdAt: true,
          expiresAt: true,
          id: true,
          name: true,
          scopes: true,
          tokenHint: true,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "A tool credential with this name already exists.",
        );
      }
      throw error;
    }
    await this.audit.record(
      current,
      "tool.credential.created",
      "tool_credential",
      row.id,
      { name: row.name, scopes: row.scopes },
    );
    return { ...row, token };
  }

  async revoke(current: AuthContext, id: string) {
    const result = await this.prisma.toolCredential.updateMany({
      data: { revokedAt: new Date() },
      where: { id, revokedAt: null, teamId: current.team.id },
    });
    if (result.count === 0) {
      throw new NotFoundException(
        "Tool credential was not found or is revoked.",
      );
    }
    await this.audit.record(
      current,
      "tool.credential.revoked",
      "tool_credential",
      id,
    );
  }

  async authenticate(
    authorization: string | undefined,
  ): Promise<ToolAuthContext> {
    const token = extractBearerToken(authorization);
    if (token.startsWith(AGENT_RUNTIME_TOKEN_PREFIX)) {
      return this.authenticateAgentRuntime(token);
    }
    const credential = await this.prisma.toolCredential.findUnique({
      include: { team: true },
      where: { tokenHash: hashToolToken(token) },
    });
    if (
      !credential ||
      credential.revokedAt ||
      (credential.expiresAt && credential.expiresAt.getTime() <= Date.now())
    ) {
      throw new UnauthorizedException("Tool credential is invalid or expired.");
    }

    await this.prisma.toolCredential.update({
      data: { lastUsedAt: new Date() },
      where: { id: credential.id },
    });
    return {
      credential: {
        id: credential.id,
        kind: "TOOL",
        name: credential.name,
        scopes: credential.scopes as ToolCredentialScope[],
      },
      team: {
        id: credential.team.id,
        name: credential.team.name,
        slug: credential.team.slug,
      },
    };
  }

  private async authenticateAgentRuntime(
    token: string,
  ): Promise<ToolAuthContext> {
    const credential = await this.prisma.agentRuntimeCredential.findUnique({
      include: { team: true },
      where: { tokenHash: hashToolToken(token) },
    });
    if (
      !credential ||
      credential.revokedAt ||
      (credential.expiresAt && credential.expiresAt.getTime() <= Date.now())
    ) {
      throw new UnauthorizedException(
        "Agent Runtime credential is invalid or expired.",
      );
    }

    await this.prisma.agentRuntimeCredential.update({
      data: { lastUsedAt: new Date() },
      where: { id: credential.id },
    });
    return {
      credential: {
        id: credential.id,
        kind: "AGENT_RUNTIME",
        name: credential.name,
        scopes: ["runtime:lease"],
      },
      team: {
        id: credential.team.id,
        name: credential.team.name,
        slug: credential.team.slug,
      },
    };
  }
}
