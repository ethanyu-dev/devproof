import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  AgentModelConfigurationCreateInput,
  AgentModelConfigurationOrderInput,
  AgentModelConfigurationUpdateInput,
  AgentModelPool,
} from "@devproof/contracts";

import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { CredentialCipherService } from "../security/credential-cipher.service.js";
import { AuditService } from "./audit.service.js";

const publicModelSelect = {
  apiKeyHint: true,
  baseUrl: true,
  createdAt: true,
  displayName: true,
  id: true,
  modelId: true,
  pool: true,
  position: true,
  updatedAt: true,
} satisfies Prisma.AgentModelConfigurationSelect;

export interface AgentModelCandidate {
  apiKey: string;
  baseUrl: string;
  displayName: string;
  modelId: string;
}

@Injectable()
export class AgentModelConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipherService,
    private readonly audit: AuditService,
  ) {}

  list(current: AuthContext) {
    return this.prisma.agentModelConfiguration.findMany({
      orderBy: [{ pool: "asc" }, { position: "asc" }, { createdAt: "asc" }],
      select: publicModelSelect,
      where: { teamId: current.team.id },
    });
  }

  async create(
    current: AuthContext,
    input: AgentModelConfigurationCreateInput,
  ) {
    const [count, last] = await Promise.all([
      this.prisma.agentModelConfiguration.count({
        where: { pool: input.pool, teamId: current.team.id },
      }),
      this.prisma.agentModelConfiguration.aggregate({
        _max: { position: true },
        where: { pool: input.pool, teamId: current.team.id },
      }),
    ]);
    if (count >= 10) {
      throw new BadRequestException(
        `At most 10 models can be configured for the ${input.pool} pool.`,
      );
    }
    const row = await this.prisma.agentModelConfiguration
      .create({
        data: {
          apiKeyEncrypted: this.cipher.encrypt(input.apiKey),
          apiKeyHint: this.cipher.hint(input.apiKey),
          baseUrl: input.baseUrl,
          configuredByUserId: current.user.id,
          displayName: input.displayName,
          modelId: input.modelId,
          pool: input.pool,
          position: (last._max.position ?? -1) + 1,
          teamId: current.team.id,
        },
        select: publicModelSelect,
      })
      .catch((error: unknown) => throwModelConflict(error));
    await this.audit.record(
      current,
      "agent_model.created",
      "agent_model_configuration",
      row.id,
      auditMetadata(row),
    );
    return row;
  }

  async update(
    current: AuthContext,
    id: string,
    input: AgentModelConfigurationUpdateInput,
  ) {
    const existing = await this.requireOwned(current.team.id, id);
    if (existing.baseUrl !== input.baseUrl && !input.apiKey) {
      throw new BadRequestException(
        "Replacing the Base URL also requires a replacement API key.",
      );
    }
    const secret = input.apiKey
      ? {
          apiKeyEncrypted: this.cipher.encrypt(input.apiKey),
          apiKeyHint: this.cipher.hint(input.apiKey),
        }
      : {};
    const row = await this.prisma.agentModelConfiguration
      .update({
        data: {
          baseUrl: input.baseUrl,
          configuredByUserId: current.user.id,
          displayName: input.displayName,
          modelId: input.modelId,
          ...secret,
        },
        select: publicModelSelect,
        where: {
          id,
          teamId: current.team.id,
          ...(!input.apiKey ? { baseUrl: input.baseUrl } : {}),
        },
      })
      .catch((error: unknown) => throwModelConflict(error));
    await this.audit.record(
      current,
      "agent_model.updated",
      "agent_model_configuration",
      row.id,
      { ...auditMetadata(row), apiKeyReplaced: Boolean(input.apiKey) },
    );
    return row;
  }

  async remove(current: AuthContext, id: string) {
    const removed = await this.prisma.agentModelConfiguration.deleteMany({
      where: { id, teamId: current.team.id },
    });
    if (removed.count !== 1) {
      throw new NotFoundException("Agent model was not found.");
    }
    await this.audit.record(
      current,
      "agent_model.deleted",
      "agent_model_configuration",
      id,
    );
  }

  async reorder(
    current: AuthContext,
    input: AgentModelConfigurationOrderInput,
  ) {
    const rows = await this.prisma.agentModelConfiguration.findMany({
      select: { id: true },
      where: { pool: input.pool, teamId: current.team.id },
    });
    const ownedIds = new Set(rows.map((row) => row.id));
    if (
      rows.length !== input.ids.length ||
      input.ids.some((id) => !ownedIds.has(id))
    ) {
      throw new BadRequestException(
        `Model order must contain every model in the ${input.pool} pool exactly once.`,
      );
    }
    await this.prisma.$transaction(
      input.ids.map((id, position) =>
        this.prisma.agentModelConfiguration.update({
          data: { position },
          where: { id },
        }),
      ),
    );
    await this.audit.record(
      current,
      "agent_model.reordered",
      "agent_model_configuration",
      current.team.id,
      { ids: input.ids, pool: input.pool },
    );
    return this.list(current);
  }

  async candidatesForPool(
    teamId: string,
    pool: AgentModelPool,
  ): Promise<AgentModelCandidate[]> {
    const rows = await this.prisma.agentModelConfiguration.findMany({
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: {
        apiKeyEncrypted: true,
        baseUrl: true,
        displayName: true,
        modelId: true,
      },
      where: { pool, teamId },
    });
    return rows.map((row) => ({
      apiKey: this.cipher.decrypt(row.apiKeyEncrypted),
      baseUrl: row.baseUrl,
      displayName: row.displayName,
      modelId: row.modelId,
    }));
  }

  private async requireOwned(teamId: string, id: string) {
    const row = await this.prisma.agentModelConfiguration.findFirst({
      select: { baseUrl: true, id: true },
      where: { id, teamId },
    });
    if (!row) throw new NotFoundException("Agent model was not found.");
    return row;
  }
}

function auditMetadata(row: {
  apiKeyHint: string;
  baseUrl: string;
  displayName: string;
  modelId: string;
  pool: string;
  position: number;
}) {
  return {
    apiKeyHint: row.apiKeyHint,
    baseUrl: row.baseUrl,
    displayName: row.displayName,
    modelId: row.modelId,
    pool: row.pool,
    position: row.position,
  };
}

function throwModelConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new ConflictException(
      "An Agent model with this display name already exists in this Runtime pool.",
    );
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  ) {
    throw new BadRequestException(
      "The Agent model changed while it was being saved. Reload and try again.",
    );
  }
  throw error;
}
