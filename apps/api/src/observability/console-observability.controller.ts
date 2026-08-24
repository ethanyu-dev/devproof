import { Controller, Get, UseGuards } from "@nestjs/common";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import { PrismaService } from "../database/prisma.service.js";
import { HealthService } from "./health.service.js";

@Controller("console/api/observability")
@UseGuards(AuthGuard)
export class ConsoleObservabilityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly health: HealthService,
  ) {}

  @Get("overview")
  async overview(@CurrentAuth() current: AuthContext) {
    const [
      health,
      taskStatuses,
      taskStageStatuses,
      verificationStatuses,
      commandStatuses,
      outboxStatuses,
      runtimes,
    ] = await Promise.all([
      this.health.readiness(),
      this.prisma.taskExecution.groupBy({
        _count: true,
        by: ["lifecycle"],
        where: { teamId: current.team.id },
      }),
      this.prisma.taskExecutionStage.groupBy({
        _count: true,
        by: ["status"],
        where: { taskExecution: { teamId: current.team.id } },
      }),
      this.prisma.verificationRun.groupBy({
        _count: true,
        by: ["status"],
        where: { teamId: current.team.id },
      }),
      this.prisma.browserRuntimeCommand.groupBy({
        _count: true,
        by: ["status"],
        where: { session: { teamId: current.team.id } },
      }),
      this.prisma.notificationOutbox.groupBy({
        _count: true,
        by: ["status"],
        where: { teamId: current.team.id },
      }),
      this.prisma.browserRuntime.groupBy({
        _count: true,
        by: ["status"],
        where: { teamId: current.team.id },
      }),
    ]);
    return {
      commandStatuses,
      health,
      outboxStatuses,
      runtimes,
      taskStageStatuses,
      taskStatuses: taskStatuses.map((row) => ({
        _count: row._count,
        status: row.lifecycle,
      })),
      verificationStatuses,
    };
  }

  @Get("tool-invocations")
  toolInvocations(@CurrentAuth() current: AuthContext) {
    return this.prisma.toolInvocation.findMany({
      include: {
        credential: { select: { name: true, tokenHint: true } },
        run: { select: { goal: true } },
      },
      orderBy: { startedAt: "desc" },
      take: 200,
      where: { teamId: current.team.id },
    });
  }

  @Get("audit-events")
  auditEvents(@CurrentAuth() current: AuthContext) {
    return this.prisma.auditEvent.findMany({
      include: {
        actor: { select: { email: true, id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      where: { teamId: current.team.id },
    });
  }
}
