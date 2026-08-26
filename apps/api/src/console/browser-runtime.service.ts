import { createHash, randomBytes } from "node:crypto";

import { Injectable, UnauthorizedException } from "@nestjs/common";
import type {
  RuntimeConfigurationInput,
  RuntimePairInput,
} from "@devproof/contracts";
import {
  RUNTIME_PROTOCOL,
  runtimeCommandMinimumMinor,
} from "@devproof/runtime-protocol";

import type { AuthContext } from "../auth/auth.types.js";
import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../infrastructure/redis.service.js";
import { RuntimeConnectionHub } from "../runtime/runtime-connection-hub.service.js";
import { AuditService } from "./audit.service.js";

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

@Injectable()
export class BrowserRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly hub: RuntimeConnectionHub,
  ) {}

  async list(current: AuthContext) {
    const rows = await this.prisma.browserRuntime.findMany({
      orderBy: { updatedAt: "desc" },
      where: { teamId: current.team.id },
    });
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        status:
          row.status === "REVOKED"
            ? "REVOKED"
            : row.enabled && (await this.redis.isRuntimeOnline(row.id))
              ? "ONLINE"
              : "OFFLINE",
        tokenHash: undefined,
      })),
    );
  }

  async capacity(current: AuthContext) {
    const now = new Date();
    const runtimes = await this.prisma.browserRuntime.findMany({
      select: { id: true, maxConcurrency: true, name: true },
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
    const [slotCounts, pinnedWaiting, flexibleWaiting] = await Promise.all([
      this.prisma.browserRuntimeSlot.groupBy({
        _count: { _all: true },
        by: ["runtimeId"],
        where: {
          expiresAt: { gt: now },
          runtimeId: { in: runtimes.map((runtime) => runtime.id) },
        },
      }),
      this.prisma.browserExecution.groupBy({
        _count: { _all: true },
        by: ["targetRuntimeId"],
        where: {
          run: { teamId: current.team.id },
          status: { in: ["REQUESTED", "WAITING_CAPACITY", "ALLOCATING"] },
          targetRuntimeId: {
            in: runtimes.map((runtime) => runtime.id),
          },
        },
      }),
      this.prisma.browserExecution.count({
        where: {
          run: { teamId: current.team.id },
          status: { in: ["REQUESTED", "WAITING_CAPACITY", "ALLOCATING"] },
          targetRuntimeId: null,
        },
      }),
    ]);
    const occupiedByRuntime = new Map(
      slotCounts.map((row) => [row.runtimeId, row._count._all]),
    );
    const waitingByRuntime = new Map(
      pinnedWaiting.flatMap((row) =>
        row.targetRuntimeId
          ? [[row.targetRuntimeId, row._count._all] as const]
          : [],
      ),
    );
    const nodes = await Promise.all(
      runtimes.map(async (runtime) => {
        const occupied = occupiedByRuntime.get(runtime.id) ?? 0;
        const online = await this.redis.isRuntimeOnline(runtime.id);
        return {
          available: online
            ? Math.max(0, runtime.maxConcurrency - occupied)
            : 0,
          configured: runtime.maxConcurrency,
          draining: Math.max(0, occupied - runtime.maxConcurrency),
          id: runtime.id,
          name: runtime.name,
          occupied,
          online,
          waiting: waitingByRuntime.get(runtime.id) ?? 0,
        };
      }),
    );
    return {
      availableCapacity: nodes.reduce(
        (total, node) => total + node.available,
        0,
      ),
      configuredCapacity: nodes.reduce(
        (total, node) => total + node.configured,
        0,
      ),
      drainingCapacity: nodes.reduce((total, node) => total + node.draining, 0),
      flexibleWaiting,
      nodes,
      occupiedCapacity: nodes.reduce((total, node) => total + node.occupied, 0),
      schedulableCapacity: nodes.reduce(
        (total, node) => total + (node.online ? node.configured : 0),
        0,
      ),
    };
  }

  async createPairingToken(current: AuthContext) {
    const pairingToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await this.prisma.browserRuntimePairingToken.create({
      data: {
        expiresAt,
        teamId: current.team.id,
        tokenHash: hashToken(pairingToken),
      },
    });
    await this.audit.record(
      current,
      "runtime.pairing_token.created",
      "browser_runtime_pairing_token",
    );
    return { expiresAt, pairingToken };
  }

  async updateConfiguration(
    current: AuthContext,
    id: string,
    input: RuntimeConfigurationInput,
  ) {
    const owned = await this.prisma.browserRuntime.findFirst({
      select: { id: true },
      where: {
        enabled: true,
        id,
        revokedAt: null,
        teamId: current.team.id,
      },
    });
    if (!owned) {
      throw new UnauthorizedException("Browser Runtime was not found.");
    }

    const runtime = await this.prisma.browserRuntime.update({
      data: {
        maxConcurrency: input.maxConcurrency,
        networkAllowlist: input.networkAllowlist,
      },
      where: { id },
    });
    await this.audit.record(
      current,
      "runtime.configuration.updated",
      "browser_runtime",
      runtime.id,
      {
        maxConcurrency: runtime.maxConcurrency,
        networkAllowlist: runtime.networkAllowlist,
      },
    );

    const online = await this.redis.isRuntimeOnline(runtime.id);
    if (online && (runtime.protocolMinor ?? 0) >= 4) {
      await this.hub.send(runtime.id, {
        networkAllowlist: runtime.networkAllowlist,
        type: "runtime.network_policy.updated",
      });
    }
    return {
      ...runtime,
      status: online ? "ONLINE" : "OFFLINE",
      tokenHash: undefined,
    };
  }

  async pair(input: RuntimePairInput) {
    const runtimeToken = randomBytes(32).toString("base64url");
    const runtime = await this.prisma.$transaction(async (tx) => {
      const pairing = await tx.browserRuntimePairingToken.findUnique({
        where: { tokenHash: hashToken(input.pairingToken) },
      });
      if (
        !pairing ||
        pairing.usedAt ||
        pairing.expiresAt.getTime() <= Date.now()
      ) {
        throw new UnauthorizedException(
          "Pairing token is invalid, expired, or already used.",
        );
      }

      const claimed = await tx.browserRuntimePairingToken.updateMany({
        data: { usedAt: new Date() },
        where: {
          expiresAt: { gt: new Date() },
          id: pairing.id,
          usedAt: null,
        },
      });
      if (claimed.count !== 1) {
        throw new UnauthorizedException("Pairing token was already claimed.");
      }

      return tx.browserRuntime.upsert({
        create: {
          capabilities: input.capabilities,
          connectedAt: new Date(),
          deviceInfo: input.deviceInfo,
          instanceKey: input.instanceKey,
          lastSeenAt: new Date(),
          maxConcurrency: input.maxConcurrency,
          name: input.name,
          status: "ONLINE",
          teamId: pairing.teamId,
          tokenHash: hashToken(runtimeToken),
          tokenHint: "••••" + runtimeToken.slice(-4),
          version: input.version,
        },
        update: {
          capabilities: input.capabilities,
          connectedAt: new Date(),
          deviceInfo: input.deviceInfo,
          enabled: true,
          lastSeenAt: new Date(),
          name: input.name,
          revokedAt: null,
          status: "ONLINE",
          tokenHash: hashToken(runtimeToken),
          tokenHint: "••••" + runtimeToken.slice(-4),
          version: input.version,
        },
        where: {
          teamId_instanceKey: {
            instanceKey: input.instanceKey,
            teamId: pairing.teamId,
          },
        },
      });
    });

    this.hub.close(runtime.id, 4001, "Runtime credential was rotated.");
    return {
      gatewayUrl: env().RUNTIME_GATEWAY_WS_URL,
      protocol: RUNTIME_PROTOCOL,
      runtimeId: runtime.id,
      runtimeToken,
    };
  }

  async revoke(current: AuthContext, id: string) {
    const result = await this.prisma.browserRuntime.updateMany({
      data: {
        enabled: false,
        gatewayInstanceId: null,
        revokedAt: new Date(),
        status: "REVOKED",
      },
      where: { id, teamId: current.team.id },
    });
    if (result.count !== 1) {
      throw new UnauthorizedException("Browser Runtime was not found.");
    }
    this.hub.close(id, 4003, "Runtime credential was revoked.");
    await this.prisma.$transaction([
      this.prisma.browserRuntimeSession.updateMany({
        data: {
          lastError: {
            code: "RUNTIME_REVOKED",
            message: "Runtime credential was revoked.",
          },
          status: "LOST",
        },
        where: {
          runtimeId: id,
          status: { in: ["OPENING", "ACTIVE", "HUMAN_CONTROL", "CLOSING"] },
        },
      }),
      this.prisma.browserRuntimeSlot.deleteMany({ where: { runtimeId: id } }),
      this.prisma.browserRuntimeProfileLease.deleteMany({
        where: { runtimeId: id },
      }),
    ]);
    await this.audit.record(current, "runtime.revoked", "browser_runtime", id);
  }
}
