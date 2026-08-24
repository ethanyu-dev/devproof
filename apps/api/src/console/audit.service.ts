import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { PrismaService } from "../database/prisma.service.js";
import type { AuthContext } from "../auth/auth.types.js";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    current: AuthContext,
    action: string,
    entityType: string,
    entityId?: string,
    metadata: Record<string, unknown> = {},
  ) {
    await this.prisma.auditEvent.create({
      data: {
        action,
        actorUserId: current.user.id,
        entityId: entityId ?? null,
        entityType,
        metadata: metadata as Prisma.InputJsonValue,
        teamId: current.team.id,
      },
    });
  }
}
