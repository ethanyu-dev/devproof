import { BadRequestException, Injectable } from "@nestjs/common";
import { AGENT_RUNTIME_PROTOCOL } from "@devproof/agent-runtime-protocol";
import {
  RUNTIME_PROTOCOL,
  runtimeCommandMinimumMinor,
} from "@devproof/runtime-protocol";

import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../infrastructure/redis.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";

const MAX_ASSIGNED_BROWSER_CONCURRENCY = 1_024;

@Injectable()
export class AgentRuntimeControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async register(
    current: ToolAuthContext,
    input: { protocol: { minor: number }; workerId: string },
  ) {
    if (input.protocol.minor < AGENT_RUNTIME_PROTOCOL.minor) {
      throw new BadRequestException(
        `Agent Runtime protocol minor ${AGENT_RUNTIME_PROTOCOL.minor} or newer is required.`,
      );
    }
    const pool = current.credential.pool ?? "MIXED";
    if (pool === "MIXED") {
      throw new BadRequestException(
        "Legacy MIXED Agent Runtime credentials are disabled; provision separate SPEC_ANALYSIS and BROWSER_EXECUTION credentials.",
      );
    }
    const pools = [pool] as const;
    let browserConcurrency = 0;
    if (pools.includes("BROWSER_EXECUTION")) {
      const runtimes = await this.prisma.browserRuntime.findMany({
        select: { id: true, maxConcurrency: true },
        where: {
          enabled: true,
          protocolMajor: RUNTIME_PROTOCOL.major,
          protocolMinor: {
            gte: runtimeCommandMinimumMinor("page.snapshot"),
          },
          revokedAt: null,
          teamId: current.team.id,
        },
      });
      const online = await Promise.all(
        runtimes.map(async (runtime) => ({
          ...runtime,
          online: await this.redis.isRuntimeOnline(runtime.id),
        })),
      );
      const schedulableConcurrency = Math.min(
        MAX_ASSIGNED_BROWSER_CONCURRENCY,
        online.reduce(
          (total, runtime) =>
            total + (runtime.online ? runtime.maxConcurrency : 0),
          0,
        ),
      );
      browserConcurrency = await this.redis.assignAgentRuntimeConcurrency(
        current.team.id,
        input.workerId,
        schedulableConcurrency,
      );
    }
    return {
      browserConcurrency,
      pools: [...pools],
      refreshAfterMs: 5_000,
      specConcurrency: pools.includes("SPEC_ANALYSIS") ? 1 : 0,
    };
  }
}
