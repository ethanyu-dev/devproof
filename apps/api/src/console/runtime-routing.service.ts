import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RuntimeRoutingRuleInput } from "@devproof/contracts";

import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "./audit.service.js";

const runtimeSelect = {
  id: true,
  name: true,
  revokedAt: true,
} as const;

@Injectable()
export class RuntimeRoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(current: AuthContext) {
    return this.prisma.runtimeRoutingRule.findMany({
      include: { runtime: { select: runtimeSelect } },
      orderBy: [{ priority: "desc" }, { hostnamePattern: "asc" }],
      where: { teamId: current.team.id },
    });
  }

  async create(current: AuthContext, input: RuntimeRoutingRuleInput) {
    await this.assertRuntime(current.team.id, input.runtimeId);
    try {
      const rule = await this.prisma.runtimeRoutingRule.create({
        data: { ...input, teamId: current.team.id },
        include: { runtime: { select: runtimeSelect } },
      });
      await this.audit.record(
        current,
        "runtime.routing_rule.created",
        "runtime_routing_rule",
        rule.id,
        {
          fallbackPolicy: rule.fallbackPolicy,
          hostnamePattern: rule.hostnamePattern,
          runtimeId: rule.runtimeId,
        },
      );
      return rule;
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  async update(
    current: AuthContext,
    id: string,
    input: RuntimeRoutingRuleInput,
  ) {
    await this.assertOwned(current.team.id, id);
    await this.assertRuntime(current.team.id, input.runtimeId);
    try {
      const rule = await this.prisma.runtimeRoutingRule.update({
        data: input,
        include: { runtime: { select: runtimeSelect } },
        where: { id },
      });
      await this.audit.record(
        current,
        "runtime.routing_rule.updated",
        "runtime_routing_rule",
        rule.id,
        {
          enabled: rule.enabled,
          fallbackPolicy: rule.fallbackPolicy,
          hostnamePattern: rule.hostnamePattern,
          priority: rule.priority,
          runtimeId: rule.runtimeId,
        },
      );
      return rule;
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  async remove(current: AuthContext, id: string) {
    const rule = await this.assertOwned(current.team.id, id);
    await this.prisma.runtimeRoutingRule.delete({ where: { id } });
    await this.audit.record(
      current,
      "runtime.routing_rule.deleted",
      "runtime_routing_rule",
      id,
      { hostnamePattern: rule.hostnamePattern, runtimeId: rule.runtimeId },
    );
  }

  private async assertRuntime(teamId: string, runtimeId: string) {
    const runtime = await this.prisma.browserRuntime.findFirst({
      select: { id: true },
      where: {
        enabled: true,
        id: runtimeId,
        revokedAt: null,
        teamId,
      },
    });
    if (!runtime) {
      throw new BadRequestException("Selected Runtime is unavailable.");
    }
  }

  private async assertOwned(teamId: string, id: string) {
    const rule = await this.prisma.runtimeRoutingRule.findFirst({
      where: { id, teamId },
    });
    if (!rule) {
      throw new NotFoundException("Runtime routing rule was not found.");
    }
    return rule;
  }

  private rethrowConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictException(
        "A routing rule already exists for this hostname pattern.",
      );
    }
    throw error;
  }
}
