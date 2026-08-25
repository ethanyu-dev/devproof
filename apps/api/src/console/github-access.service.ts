import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  GithubAccessCredentialCreateInput,
  GithubAccessCredentialUpdateInput,
} from "@devproof/contracts";

import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { CredentialCipherService } from "../security/credential-cipher.service.js";
import { AuditService } from "./audit.service.js";

const publicCredentialSelect = {
  createdAt: true,
  enabled: true,
  id: true,
  name: true,
  organizations: true,
  priority: true,
  repositories: true,
  tokenHint: true,
  updatedAt: true,
} satisfies Prisma.GithubAccessCredentialSelect;

export interface GithubCredentialCandidate {
  id: string;
  name: string;
  token: string;
}

@Injectable()
export class GithubAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipherService,
    private readonly audit: AuditService,
  ) {}

  list(current: AuthContext) {
    return this.prisma.githubAccessCredential.findMany({
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      select: publicCredentialSelect,
      where: { teamId: current.team.id },
    });
  }

  async create(current: AuthContext, input: GithubAccessCredentialCreateInput) {
    const tokenEncrypted = this.cipher.encrypt(input.personalAccessToken);
    const tokenHint = this.cipher.hint(input.personalAccessToken);
    const row = await this.prisma.githubAccessCredential
      .create({
        data: {
          configuredByUserId: current.user.id,
          enabled: input.enabled,
          name: input.name,
          organizations: input.organizations,
          priority: input.priority,
          repositories: input.repositories,
          teamId: current.team.id,
          tokenEncrypted,
          tokenHint,
        },
        select: publicCredentialSelect,
      })
      .catch((error: unknown) => throwCredentialNameConflict(error));
    await this.audit.record(
      current,
      "github.credential.created",
      "github_access_credential",
      row.id,
      auditMetadata(row),
    );
    return row;
  }

  async update(
    current: AuthContext,
    id: string,
    input: GithubAccessCredentialUpdateInput,
  ) {
    const owned = await this.prisma.githubAccessCredential.findFirst({
      select: { id: true },
      where: { id, teamId: current.team.id },
    });
    if (!owned) throw new NotFoundException("GitHub credential was not found.");

    const secret = input.personalAccessToken
      ? {
          tokenEncrypted: this.cipher.encrypt(input.personalAccessToken),
          tokenHint: this.cipher.hint(input.personalAccessToken),
        }
      : {};
    const row = await this.prisma.githubAccessCredential
      .update({
        data: {
          configuredByUserId: current.user.id,
          enabled: input.enabled,
          name: input.name,
          organizations: input.organizations,
          priority: input.priority,
          repositories: input.repositories,
          ...secret,
        },
        select: publicCredentialSelect,
        where: { id },
      })
      .catch((error: unknown) => throwCredentialNameConflict(error));
    await this.audit.record(
      current,
      "github.credential.updated",
      "github_access_credential",
      row.id,
      {
        ...auditMetadata(row),
        tokenReplaced: Boolean(input.personalAccessToken),
      },
    );
    return row;
  }

  async remove(current: AuthContext, id: string) {
    const removed = await this.prisma.githubAccessCredential.deleteMany({
      where: { id, teamId: current.team.id },
    });
    if (removed.count !== 1) {
      throw new NotFoundException("GitHub credential was not found.");
    }
    await this.audit.record(
      current,
      "github.credential.deleted",
      "github_access_credential",
      id,
    );
  }

  async configured(teamId: string) {
    return (
      (await this.prisma.githubAccessCredential.count({
        where: { enabled: true, teamId },
      })) > 0
    );
  }

  async candidatesForRepository(
    teamId: string,
    ownerValue: string,
    repositoryValue: string,
  ): Promise<GithubCredentialCandidate[]> {
    const owner = ownerValue.toLowerCase();
    const repository = repositoryValue.toLowerCase();
    const fullName = `${owner}/${repository}`;
    const rows = await this.prisma.githubAccessCredential.findMany({
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      select: {
        createdAt: true,
        id: true,
        name: true,
        organizations: true,
        priority: true,
        repositories: true,
        tokenEncrypted: true,
      },
      where: { enabled: true, teamId },
    });
    return rows
      .map((row) => ({
        row,
        specificity: routingSpecificity(row, owner, fullName),
      }))
      .filter((item) => item.specificity >= 0)
      .sort(
        (left, right) =>
          right.specificity - left.specificity ||
          right.row.priority - left.row.priority ||
          left.row.createdAt.getTime() - right.row.createdAt.getTime(),
      )
      .map(({ row }) => ({
        id: row.id,
        name: row.name,
        token: this.cipher.decrypt(row.tokenEncrypted),
      }));
  }

  async hasCandidateForRepository(
    teamId: string,
    ownerValue: string,
    repositoryValue: string,
  ) {
    const owner = ownerValue.toLowerCase();
    const fullName = `${owner}/${repositoryValue.toLowerCase()}`;
    const rows = await this.prisma.githubAccessCredential.findMany({
      select: { organizations: true, repositories: true },
      where: { enabled: true, teamId },
    });
    return rows.some((row) => routingSpecificity(row, owner, fullName) >= 0);
  }
}

function routingSpecificity(
  row: { organizations: string[]; repositories: string[] },
  owner: string,
  fullName: string,
) {
  if (row.repositories.includes(fullName)) return 2;
  if (row.organizations.includes(owner)) return 1;
  if (row.organizations.length === 0 && row.repositories.length === 0) return 0;
  return -1;
}

function auditMetadata(row: {
  enabled: boolean;
  name: string;
  organizations: string[];
  priority: number;
  repositories: string[];
  tokenHint: string;
}) {
  return {
    enabled: row.enabled,
    name: row.name,
    organizations: row.organizations,
    priority: row.priority,
    repositories: row.repositories,
    tokenHint: row.tokenHint,
  };
}

function throwCredentialNameConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new ConflictException(
      "A GitHub credential with this name already exists.",
    );
  }
  throw error;
}
