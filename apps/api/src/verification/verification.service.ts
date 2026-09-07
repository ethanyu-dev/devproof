import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
  ) {}

  list(current: ToolAuthContext) {
    return this.prisma.verificationRun.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        agentProvider: true,
        createdAt: true,
        finishedAt: true,
        goal: true,
        id: true,
        idempotencyKey: true,
        queuedAt: true,
        status: true,
        updatedAt: true,
      },
      take: 100,
      where: { teamId: current.team.id },
    });
  }

  async detail(current: ToolAuthContext, id: string) {
    const row = await this.prisma.verificationRun.findFirst({
      include: {
        assertions: { orderBy: { createdAt: "asc" } },
        artifacts: { orderBy: { createdAt: "asc" } },
        checkpoints: { orderBy: { requestedAt: "asc" } },
        events: { orderBy: { sequence: "asc" } },
      },
      where: { id, teamId: current.team.id },
    });
    if (!row) {
      throw new NotFoundException("Verification run was not found.");
    }
    return this.serialize({
      ...row,
      artifacts: await Promise.all(
        row.artifacts.map(async (artifact) => ({
          ...artifact,
          downloadUrl: artifact.storageKey
            ? await this.storage.signedDownloadUrl(artifact.storageKey)
            : null,
          evidenceRef: `artifact://${artifact.id}`,
        })),
      ),
    });
  }

  async events(current: ToolAuthContext, id: string, after?: bigint) {
    await this.assertOwned(current.team.id, id);
    const rows = await this.prisma.verificationEvent.findMany({
      orderBy: { sequence: "asc" },
      take: 500,
      where: {
        runId: id,
        teamId: current.team.id,
        ...(after !== undefined ? { sequence: { gt: after } } : {}),
      },
    });
    return rows.map((row) => ({ ...row, sequence: row.sequence.toString() }));
  }

  private async assertOwned(teamId: string, id: string) {
    const row = await this.prisma.verificationRun.findFirst({
      where: { id, teamId },
    });
    if (!row) {
      throw new NotFoundException("Verification run was not found.");
    }
    return row;
  }

  private serialize<T extends { events?: Array<{ sequence: bigint }> }>(
    row: T,
  ) {
    return {
      ...row,
      ...(row.events
        ? {
            events: row.events.map((event) => ({
              ...event,
              sequence: event.sequence.toString(),
            })),
          }
        : {}),
    };
  }
}
