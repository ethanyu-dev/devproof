import { Controller, Get, Param, UseGuards } from "@nestjs/common";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import { PrismaService } from "../database/prisma.service.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import { summarizeValue } from "../observability/observability.service.js";

@Controller("console/api/verifications")
@UseGuards(AuthGuard)
export class VerificationConsoleController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
  ) {}

  @Get()
  list(@CurrentAuth() current: AuthContext) {
    return this.prisma.verificationRun.findMany({
      select: {
        _count: {
          select: { artifacts: true, checkpoints: true, events: true },
        },
        agentProvider: true,
        createdAt: true,
        goal: true,
        id: true,
        status: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      where: { teamId: current.team.id },
    });
  }

  @Get(":id")
  async detail(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    const run = await this.prisma.verificationRun.findFirstOrThrow({
      include: {
        artifacts: { orderBy: { createdAt: "asc" } },
        assertions: { orderBy: { createdAt: "asc" } },
        callerCredential: {
          select: { id: true, name: true, tokenHint: true },
        },
        checkpoints: { orderBy: { requestedAt: "asc" } },
        events: { orderBy: { sequence: "asc" } },
        notificationOutbox: { orderBy: { createdAt: "asc" } },
        runtimeSession: {
          include: {
            commands: { orderBy: { createdAt: "asc" }, take: 500 },
            events: { orderBy: { occurredAt: "asc" }, take: 500 },
            runtime: { select: { id: true, name: true, status: true } },
          },
        },
        toolInvocations: {
          include: {
            credential: { select: { name: true, tokenHint: true } },
          },
          orderBy: { startedAt: "asc" },
          take: 500,
        },
      },
      where: { id, teamId: current.team.id },
    });
    return {
      ...run,
      artifacts: await Promise.all(
        run.artifacts.map(async (artifact) => ({
          ...artifact,
          downloadUrl: artifact.storageKey
            ? await this.storage.signedDownloadUrl(artifact.storageKey)
            : null,
          evidenceRef: `artifact://${artifact.id}`,
        })),
      ),
      events: run.events.map((event) => ({
        ...event,
        sequence: event.sequence.toString(),
      })),
      runtimeSession: run.runtimeSession
        ? {
            closedAt: run.runtimeSession.closedAt,
            createdAt: run.runtimeSession.createdAt,
            id: run.runtimeSession.id,
            lastError: run.runtimeSession.lastError,
            openedAt: run.runtimeSession.openedAt,
            profileMode: run.runtimeSession.profileMode,
            protocolMajor: run.runtimeSession.protocolMajor,
            protocolMinor: run.runtimeSession.protocolMinor,
            runtime: run.runtimeSession.runtime,
            status: run.runtimeSession.status,
            commands: run.runtimeSession.commands.map((command) => ({
              commandType: command.commandType,
              completedAt: command.completedAt,
              createdAt: command.createdAt,
              deadlineAt: command.deadlineAt,
              dispatchedAt: command.dispatchedAt,
              error: command.error,
              id: command.id,
              inputSummary: summarizeValue(command.payload),
              outputSummary: summarizeValue(command.result),
              source: command.source,
              status: command.status,
            })),
            events: run.runtimeSession.events.map((event) => ({
              createdAt: event.createdAt,
              id: event.id,
              kind: event.kind,
              occurredAt: event.occurredAt,
              payload: event.payload,
            })),
          }
        : null,
    };
  }
}
