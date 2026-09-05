import { createHash, randomBytes } from "node:crypto";

import {
  ConflictException,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import type {
  RuntimeConfigurationInput,
  RuntimePairInput,
} from "@devproof/contracts";
import {
  RUNTIME_PROTOCOL,
  runtimeCommandMinimumMinor,
} from "@devproof/runtime-protocol";
import { readCaseScheduling, caseExecutionPhase } from "@devproof/test-domain";

import type { AuthContext } from "../auth/auth.types.js";
import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../infrastructure/redis.service.js";
import { RuntimeConnectionHub } from "../runtime/runtime-connection-hub.service.js";
import { SessionRecoveryService } from "../runtime/session-recovery.service.js";
import { recoveryEnabled } from "../runtime/session-recovery.enabled.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
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
    @Optional() private readonly recovery?: SessionRecoveryService,
  ) {}

  async list(current: AuthContext) {
    const rows = await this.prisma.browserRuntime.findMany({
      orderBy: { updatedAt: "desc" },
      where: { teamId: current.team.id },
    });
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        connectionGeneration: row.connectionGeneration.toString(),
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
    const [
      slotCounts,
      pinnedWaiting,
      flexibleWaiting,
      waitingExecutions,
      pendingCases,
      quarantinedSessions,
    ] = await Promise.all([
      this.prisma.browserRuntimeSlot.groupBy({
        _count: { _all: true },
        by: ["runtimeId"],
        where: {
          OR: [
            { expiresAt: { gt: now } },
            {
              session: {
                quarantinedAt: { not: null },
                closureVerifiedAt: null,
              },
            },
          ],
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
      this.prisma.browserExecution.findMany({
        select: { runId: true, targetRuntimeId: true, error: true },
        where: {
          run: {
            teamId: current.team.id,
            lifecycle: { notIn: ["COMPLETED", "CANCELLED", "TIMED_OUT"] },
          },
          status: { in: ["REQUESTED", "WAITING_CAPACITY", "ALLOCATING"] },
        },
      }),
      this.prisma.taskCaseExecution.findMany({
        select: {
          taskExecutionId: true,
          caseId: true,
          deploymentId: true,
          executionOrdinal: true,
          dispatchStatus: true,
          dispatchAttempts: true,
          scheduling: true,
          runId: true,
          run: {
            select: {
              lifecycle: true,
              executionDisposition: true,
              verdict: true,
            },
          },
        },
        where: {
          taskExecution: {
            teamId: current.team.id,
            lifecycle: { in: ["RUNNING", "QUEUED", "WAITING_INPUT"] },
          },
        },
      }),
      this.prisma.browserRuntimeSession.groupBy({
        by: ["runtimeId"],
        _count: { _all: true },
        where: {
          teamId: current.team.id,
          quarantinedAt: { not: null },
          closureVerifiedAt: null,
        },
      }),
    ]);
    const upstreamWaitingByReason: Record<string, number> = {};
    const runtimeQueue = new Map<string, number>();
    let flexibleRuntimeWaiting = 0;
    const addUpstream = (reason: string) => {
      upstreamWaitingByReason[reason] =
        (upstreamWaitingByReason[reason] ?? 0) + 1;
    };
    for (const execution of waitingExecutions) {
      const error =
        execution.error &&
        typeof execution.error === "object" &&
        !Array.isArray(execution.error)
          ? execution.error
          : {};
      const code =
        typeof error.code === "string" ? error.code : "BROWSER_ADMISSION";
      if (code === "NO_AVAILABLE_SLOT") {
        if (execution.targetRuntimeId)
          runtimeQueue.set(
            execution.targetRuntimeId,
            (runtimeQueue.get(execution.targetRuntimeId) ?? 0) + 1,
          );
        else flexibleRuntimeWaiting += 1;
      } else
        addUpstream(
          code === "IDENTITY_CAPACITY"
            ? "IDENTITY_LIMIT"
            : code === "NO_MATCHING_RUNNER"
              ? "RUNTIME_OFFLINE"
              : code,
        );
    }
    const latestPending = new Map<string, (typeof pendingCases)[number]>();
    for (const item of pendingCases) {
      const key = `${item.taskExecutionId}:${item.caseId}:${item.deploymentId}`;
      const previous = latestPending.get(key);
      if (!previous || previous.executionOrdinal < item.executionOrdinal)
        latestPending.set(key, item);
    }
    const admissionWaitingRunIds = new Set(
      waitingExecutions.map((item) => item.runId),
    );
    for (const item of latestPending.values()) {
      const scheduling = readCaseScheduling(item.scheduling);
      if (item.runId) {
        // An admitted browser already occupies a slot but can still await an
        // Agent. Deduplicate overlapping admission snapshots by Run identity.
        if (
          !admissionWaitingRunIds.has(item.runId) &&
          scheduling?.state === "ADMITTED" &&
          scheduling.reason === "AGENT_CAPACITY" &&
          caseExecutionPhase(item) === "queued"
        )
          addUpstream("AGENT_CAPACITY");
        continue;
      }
      if (caseExecutionPhase({ ...item, run: null }) !== "terminal")
        addUpstream(scheduling?.reason ?? "SCHEDULER_PENDING");
    }
    const quarantinedByRuntime = new Map(
      quarantinedSessions.map((row) => [row.runtimeId, row._count._all]),
    );
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
          quarantined: quarantinedByRuntime.get(runtime.id) ?? 0,
          runtimeWaiting: runtimeQueue.get(runtime.id) ?? 0,
          waiting: waitingByRuntime.get(runtime.id) ?? 0,
        };
      }),
    );
    return {
      runtimeWaiting:
        flexibleRuntimeWaiting +
        [...runtimeQueue.values()].reduce((total, count) => total + count, 0),
      flexibleRuntimeWaiting,
      upstreamWaitingByReason,
      upstreamWaiting: Object.values(upstreamWaitingByReason).reduce(
        (total, count) => total + count,
        0,
      ),
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
      connectionGeneration: runtime.connectionGeneration.toString(),
      status: online ? "ONLINE" : "OFFLINE",
      tokenHash: undefined,
    };
  }

  async pair(input: RuntimePairInput) {
    const runtimeToken = randomBytes(32).toString("base64url");
    const runtime = await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
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

      const existing = await tx.browserRuntime.findUnique({
        where: {
          teamId_instanceKey: {
            teamId: pairing.teamId,
            instanceKey: input.instanceKey,
          },
        },
        select: { id: true, drainState: true },
      });
      if (existing && existing.drainState !== "NONE")
        throw new ConflictException(
          "A Runtime frozen for drain cannot be paired or re-enabled.",
        );

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
    const sessions = await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
      const now = new Date();
      const result = await tx.browserRuntime.updateMany({
        data: {
          enabled: false,
          gatewayInstanceId: null,
          revokedAt: now,
          status: "REVOKED",
        },
        where: { id, teamId: current.team.id },
      });
      if (result.count !== 1)
        throw new UnauthorizedException("Browser Runtime was not found.");
      const unverified = {
        runtimeId: id,
        closureVerifiedAt: null,
        status: { not: "CLOSED" as const },
      };
      // Revoking a credential removes authority, not proof that its browsers
      // exited. Late revoke callbacks must never overwrite a verified epoch.
      await tx.browserRuntimeSession.updateMany({
        where: unverified,
        data: {
          status: "LOST",
          executionPermitExpiresAt: now,
          humanControlExpiresAt: null,
          humanControllerUserId: null,
          lastError: {
            code: "RUNTIME_REVOKED",
            message:
              "Runtime credential was revoked; browser closure remains unverified.",
          },
        },
      });
      await tx.browserRuntimeSession.updateMany({
        where: { ...unverified, quarantinedAt: null },
        data: { quarantinedAt: now },
      });
      await tx.executionResourceLease.updateMany({
        where: { session: unverified, mode: "WRITE" },
        data: { quarantined: true },
      });
      return recoveryEnabled()
        ? tx.browserRuntimeSession.findMany({
            where: unverified,
            select: { id: true },
          })
        : [];
    });
    this.hub.close(id, 4003, "Runtime credential was revoked.");
    await this.audit.record(current, "runtime.revoked", "browser_runtime", id);
    // Requests own separate transactions and are replayed by periodic discovery
    // if the process stops here. Keep guard materialization behind the rollout barrier.
    if (recoveryEnabled())
      for (const session of sessions)
        await this.recovery?.request(session.id, "RUNTIME_REVOKED", {
          explicitClose: true,
        });
  }
}
