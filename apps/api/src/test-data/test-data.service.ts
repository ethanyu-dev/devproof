import { createHash } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  TestCaseInput,
  TestCaseVersionInput,
  TestEnvironmentInput,
  TestProjectInput,
  TestRunArtifactLinkInput,
  TestRunCheckpointCreateInput,
  TestRunCheckpointResolveInput,
  TestRunCreateInput,
  TestTraceEventAppendInput,
} from "@devproof/contracts";

import type { AuthContext } from "../auth/auth.types.js";
import { AuditService } from "../console/audit.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { PrismaService } from "../database/prisma.service.js";
import { CredentialCipherService } from "../security/credential-cipher.service.js";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function redactTracePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactTracePayload);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      /(authorization|cookie|password|secret|token|api[_-]?key)/iu.test(key)
        ? "••••redacted••••"
        : redactTracePayload(child),
    ]),
  );
}

function secretKeys(secrets: Record<string, string>): string[] {
  return Object.keys(secrets).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function isRetryableTransactionError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

@Injectable()
export class TestDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipherService,
    private readonly audit: AuditService,
  ) {}

  listProjects(current: AuthContext) {
    return this.prisma.testProject.findMany({
      include: {
        _count: {
          select: { environments: true, testCases: true, testRuns: true },
        },
      },
      orderBy: { updatedAt: "desc" },
      where: { teamId: current.team.id },
    });
  }

  async createProject(current: AuthContext, input: TestProjectInput) {
    let created;
    try {
      created = await this.prisma.testProject.create({
        data: { ...input, teamId: current.team.id },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException("A project with this slug already exists.");
      }
      throw error;
    }
    await this.audit.record(
      current,
      "test.project.created",
      "test_project",
      created.id,
    );
    return created;
  }

  async updateProject(
    current: AuthContext,
    projectId: string,
    input: TestProjectInput,
  ) {
    await this.requireProject(current.team.id, projectId);
    try {
      await this.prisma.testProject.update({
        data: input,
        where: { id: projectId },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException("A project with this slug already exists.");
      }
      throw error;
    }
    await this.audit.record(
      current,
      "test.project.updated",
      "test_project",
      projectId,
    );
    return this.requireProject(current.team.id, projectId);
  }

  async listEnvironments(current: AuthContext, projectId: string) {
    await this.requireProject(current.team.id, projectId);
    const rows = await this.prisma.testEnvironment.findMany({
      orderBy: { updatedAt: "desc" },
      where: { projectId, teamId: current.team.id },
    });
    return rows.map((row) => this.publicEnvironment(row));
  }

  async createEnvironment(
    current: AuthContext,
    projectId: string,
    input: TestEnvironmentInput,
  ) {
    const project = await this.requireProject(current.team.id, projectId);
    if (project.status === "ARCHIVED") {
      throw new ConflictException(
        "Archived projects cannot accept new environments.",
      );
    }
    const secrets = input.secrets ?? {};
    let created;
    try {
      created = await this.prisma.testEnvironment.create({
        data: {
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          name: input.name,
          projectId,
          secretKeys: json(secretKeys(secrets)),
          secretsEnc:
            Object.keys(secrets).length > 0
              ? this.cipher.encrypt(JSON.stringify(secrets))
              : null,
          slug: input.slug,
          teamId: current.team.id,
          variables: json(input.variables),
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          "An environment with this slug already exists.",
        );
      }
      throw error;
    }
    await this.audit.record(
      current,
      "test.environment.created",
      "test_environment",
      created.id,
      { projectId, secretKeys: secretKeys(secrets) },
    );
    return this.publicEnvironment(created);
  }

  async updateEnvironment(
    current: AuthContext,
    environmentId: string,
    input: TestEnvironmentInput,
  ) {
    const existing = await this.requireEnvironment(
      current.team.id,
      environmentId,
    );
    const secretUpdate =
      input.secrets === undefined
        ? {}
        : {
            secretKeys: json(secretKeys(input.secrets)),
            secretsEnc:
              Object.keys(input.secrets).length > 0
                ? this.cipher.encrypt(JSON.stringify(input.secrets))
                : null,
          };
    let updated;
    try {
      updated = await this.prisma.testEnvironment.update({
        data: {
          ...secretUpdate,
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          name: input.name,
          slug: input.slug,
          variables: json(input.variables),
        },
        where: { id: existing.id },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          "An environment with this slug already exists.",
        );
      }
      throw error;
    }
    await this.audit.record(
      current,
      "test.environment.updated",
      "test_environment",
      environmentId,
      {
        projectId: existing.projectId,
        secretsReplaced: input.secrets !== undefined,
      },
    );
    return this.publicEnvironment(updated);
  }

  async listCases(current: AuthContext, projectId: string) {
    await this.requireProject(current.team.id, projectId);
    return this.prisma.testCase.findMany({
      include: { _count: { select: { testRuns: true, versions: true } } },
      orderBy: { updatedAt: "desc" },
      where: { projectId, teamId: current.team.id },
    });
  }

  async createCase(
    current: AuthContext,
    projectId: string,
    input: TestCaseInput,
  ) {
    const project = await this.requireProject(current.team.id, projectId);
    if (project.status === "ARCHIVED") {
      throw new ConflictException(
        "Archived projects cannot accept new test cases.",
      );
    }
    let created;
    try {
      created = await this.prisma.testCase.create({
        data: { ...input, projectId, teamId: current.team.id },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          "A test case with this slug already exists.",
        );
      }
      throw error;
    }
    await this.audit.record(
      current,
      "test.case.created",
      "test_case",
      created.id,
      {
        projectId,
      },
    );
    return created;
  }

  async updateCase(current: AuthContext, caseId: string, input: TestCaseInput) {
    await this.requireCase(current.team.id, caseId);
    let updated;
    try {
      updated = await this.prisma.testCase.update({
        data: input,
        where: { id: caseId },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          "A test case with this slug already exists.",
        );
      }
      throw error;
    }
    await this.audit.record(current, "test.case.updated", "test_case", caseId);
    return updated;
  }

  async caseDetail(current: AuthContext, caseId: string) {
    const row = await this.prisma.testCase.findFirst({
      include: {
        project: { select: { id: true, name: true, slug: true, status: true } },
        versions: { orderBy: { version: "desc" } },
      },
      where: { id: caseId, teamId: current.team.id },
    });
    if (!row) {
      throw new NotFoundException("Test case was not found.");
    }
    return row;
  }

  async createCaseVersion(
    current: AuthContext,
    caseId: string,
    input: TestCaseVersionInput,
  ) {
    const definitionHash = sha256Json(input.definition);
    let created: { id: string; version: number } | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        created = await this.prisma.$transaction(
          async (tx) => {
            const testCase = await tx.testCase.findFirst({
              where: { id: caseId, teamId: current.team.id },
            });
            if (!testCase) {
              throw new NotFoundException("Test case was not found.");
            }
            if (testCase.status === "ARCHIVED") {
              throw new ConflictException(
                "Archived test cases cannot be versioned.",
              );
            }
            const latest =
              testCase.latestVersionNumber === 0
                ? null
                : await tx.testCaseVersion.findUnique({
                    where: {
                      caseId_version: {
                        caseId,
                        version: testCase.latestVersionNumber,
                      },
                    },
                  });
            if (latest?.definitionSha256 === definitionHash) {
              throw new ConflictException(
                "The definition is identical to the latest case version.",
              );
            }
            const nextVersion = testCase.latestVersionNumber + 1;
            const claimed = await tx.testCase.updateMany({
              data: { latestVersionNumber: nextVersion },
              where: {
                id: caseId,
                latestVersionNumber: testCase.latestVersionNumber,
                teamId: current.team.id,
              },
            });
            if (claimed.count !== 1) {
              throw new VersionRaceError();
            }
            return tx.testCaseVersion.create({
              data: {
                caseId,
                changeSummary: input.changeSummary,
                createdByUserId: current.user.id,
                definition: json(input.definition),
                definitionSha256: definitionHash,
                teamId: current.team.id,
                version: nextVersion,
              },
              select: { id: true, version: true },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        if (
          error instanceof VersionRaceError ||
          isRetryableTransactionError(error)
        ) {
          continue;
        }
        throw error;
      }
    }
    if (!created) {
      throw new ConflictException(
        "The case was updated concurrently; please retry.",
      );
    }
    await this.audit.record(
      current,
      "test.case.version.created",
      "test_case_version",
      created.id,
      { caseId, definitionSha256: definitionHash, version: created.version },
    );
    return this.prisma.testCaseVersion.findUniqueOrThrow({
      where: { id: created.id },
    });
  }

  async createRun(current: AuthContext, input: TestRunCreateInput) {
    if (input.idempotencyKey) {
      const existing = await this.prisma.testRun.findUnique({
        where: {
          teamId_idempotencyKey: {
            idempotencyKey: input.idempotencyKey,
            teamId: current.team.id,
          },
        },
      });
      if (existing) {
        return this.runDetail(current, existing.id);
      }
    }

    const testCase = await this.prisma.testCase.findFirst({
      include: { project: true },
      where: { id: input.caseId, teamId: current.team.id },
    });
    if (!testCase) {
      throw new NotFoundException("Test case was not found.");
    }
    if (
      testCase.status === "ARCHIVED" ||
      testCase.project.status === "ARCHIVED"
    ) {
      throw new ConflictException("Archived projects or cases cannot be run.");
    }
    if (testCase.latestVersionNumber === 0) {
      throw new ConflictException("The test case has no published version.");
    }
    const version = input.caseVersionId
      ? await this.prisma.testCaseVersion.findFirst({
          where: {
            caseId: testCase.id,
            id: input.caseVersionId,
            teamId: current.team.id,
          },
        })
      : await this.prisma.testCaseVersion.findUnique({
          where: {
            caseId_version: {
              caseId: testCase.id,
              version: testCase.latestVersionNumber,
            },
          },
        });
    if (!version) {
      throw new BadRequestException("The selected case version is invalid.");
    }
    const environment = await this.prisma.testEnvironment.findFirst({
      where: {
        enabled: true,
        id: input.environmentId,
        projectId: testCase.projectId,
        teamId: current.team.id,
      },
    });
    if (!environment) {
      throw new BadRequestException("The selected environment is unavailable.");
    }

    let created;
    try {
      created = await this.prisma.testRun.create({
        data: {
          caseId: testCase.id,
          caseVersionId: version.id,
          definitionSnapshot: json(version.definition),
          environmentId: environment.id,
          environmentSnapshot: json({
            baseUrl: environment.baseUrl,
            environmentId: environment.id,
            name: environment.name,
            secretKeys: environment.secretKeys,
            slug: environment.slug,
            variables: environment.variables,
          }),
          idempotencyKey: input.idempotencyKey ?? null,
          projectId: testCase.projectId,
          requestedByUserId: current.user.id,
          teamId: current.team.id,
          trigger: input.trigger,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error) && input.idempotencyKey) {
        const existing = await this.prisma.testRun.findUnique({
          where: {
            teamId_idempotencyKey: {
              idempotencyKey: input.idempotencyKey,
              teamId: current.team.id,
            },
          },
        });
        if (existing) {
          return this.runDetail(current, existing.id);
        }
      }
      throw error;
    }
    await this.audit.record(
      current,
      "test.run.queued",
      "test_run",
      created.id,
      {
        caseId: testCase.id,
        caseVersion: version.version,
        environmentId: environment.id,
        trigger: input.trigger,
      },
    );
    return this.runDetail(current, created.id);
  }

  listRuns(current: AuthContext) {
    return this.prisma.testRun.findMany({
      include: {
        environment: { select: { id: true, name: true, slug: true } },
        project: { select: { id: true, name: true, slug: true } },
        testCase: { select: { id: true, name: true, slug: true } },
        caseVersion: { select: { id: true, version: true } },
        _count: {
          select: { artifacts: true, checkpoints: true, traceEvents: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      where: { teamId: current.team.id },
    });
  }

  async runDetail(current: AuthContext, runId: string) {
    const row = await this.prisma.testRun.findFirst({
      include: {
        artifacts: { orderBy: { createdAt: "asc" } },
        caseVersion: {
          select: { definitionSha256: true, id: true, version: true },
        },
        checkpoints: { orderBy: { requestedAt: "asc" } },
        environment: { select: { id: true, name: true, slug: true } },
        project: { select: { id: true, name: true, slug: true } },
        testCase: { select: { id: true, name: true, slug: true } },
        traceEvents: { orderBy: { sequence: "asc" } },
      },
      where: { id: runId, teamId: current.team.id },
    });
    if (!row) {
      throw new NotFoundException("Test run was not found.");
    }
    return {
      ...row,
      traceEvents: row.traceEvents.map((event) => ({
        ...event,
        sequence: event.sequence.toString(),
      })),
    };
  }

  async appendTraceEvent(
    teamId: string,
    runId: string,
    input: TestTraceEventAppendInput,
  ) {
    await this.requireRun(teamId, runId);
    const created = await this.prisma.testRunTraceEvent.create({
      data: {
        actor: input.actor,
        durationMs: input.durationMs ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        inputRef: input.inputRef ?? null,
        kind: input.kind,
        occurredAt: input.occurredAt ?? new Date(),
        outputRef: input.outputRef ?? null,
        payload: json(redactTracePayload(input.payload)),
        runId,
        status: input.status,
        stepId: input.stepId ?? null,
        teamId,
      },
    });
    return { ...created, sequence: created.sequence.toString() };
  }

  async linkArtifact(
    teamId: string,
    runId: string,
    input: TestRunArtifactLinkInput,
  ) {
    const run = await this.requireRun(teamId, runId);
    if (input.traceEventId) {
      const event = await this.prisma.testRunTraceEvent.findFirst({
        where: { id: input.traceEventId, runId, teamId },
      });
      if (!event) {
        throw new BadRequestException(
          "Trace event does not belong to this run.",
        );
      }
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        let storageKey = input.storageKey;
        if (input.runtimeArtifactId) {
          const [runtimeArtifact] = await tx.$queryRaw<
            Array<{
              sessionId: string;
              storageKey: string;
              teamId: string;
            }>
          >`
            SELECT
              artifact."session_id" AS "sessionId",
              artifact."storage_key" AS "storageKey",
              session."team_id" AS "teamId"
            FROM "browser_runtime_artifacts" AS artifact
            JOIN "browser_runtime_sessions" AS session
              ON session."id" = artifact."session_id"
            WHERE artifact."id" = ${input.runtimeArtifactId}::uuid
            FOR KEY SHARE OF artifact
          `;
          if (!runtimeArtifact || runtimeArtifact.teamId !== teamId) {
            throw new BadRequestException("Runtime artifact is unavailable.");
          }
          if (
            run.runtimeSessionId &&
            runtimeArtifact.sessionId !== run.runtimeSessionId
          ) {
            throw new BadRequestException(
              "Runtime artifact belongs to another session.",
            );
          }
          if (storageKey && storageKey !== runtimeArtifact.storageKey) {
            throw new BadRequestException(
              "storageKey does not match the selected Runtime artifact.",
            );
          }
          storageKey = runtimeArtifact.storageKey;
        } else if (storageKey) {
          await acquireAdvisoryTransactionLock(tx, storageKey);
          const pendingDeletion = await tx.objectStorageDeletionTask.findUnique(
            {
              select: { id: true },
              where: { storageKey },
            },
          );
          if (pendingDeletion) {
            throw new BadRequestException(
              "Artifact storage is pending deletion and cannot be linked.",
            );
          }
        }
        return tx.testRunArtifact.create({
          data: {
            kind: input.kind,
            label: input.label,
            metadata: json(input.metadata),
            runId,
            runtimeArtifactId: input.runtimeArtifactId ?? null,
            storageKey: storageKey ?? null,
            teamId,
            traceEventId: input.traceEventId ?? null,
          },
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          "This runtime artifact is already linked to the run.",
        );
      }
      throw error;
    }
  }

  async createCheckpoint(
    teamId: string,
    runId: string,
    input: TestRunCheckpointCreateInput,
  ) {
    await this.requireRun(teamId, runId);
    if (input.traceEventId) {
      const event = await this.prisma.testRunTraceEvent.findFirst({
        where: { id: input.traceEventId, runId, teamId },
      });
      if (!event) {
        throw new BadRequestException(
          "Trace event does not belong to this run.",
        );
      }
    }
    return this.prisma.testRunHumanCheckpoint.create({
      data: {
        context: json(input.context),
        expiresAt: input.expiresAt ?? null,
        prompt: input.prompt,
        runId,
        stepId: input.stepId,
        teamId,
        traceEventId: input.traceEventId ?? null,
      },
    });
  }

  async resolveCheckpoint(
    current: AuthContext,
    runId: string,
    checkpointId: string,
    input: TestRunCheckpointResolveInput,
  ) {
    const checkpoint = await this.prisma.testRunHumanCheckpoint.findFirst({
      where: { id: checkpointId, runId, teamId: current.team.id },
    });
    if (!checkpoint) {
      throw new NotFoundException("Human checkpoint was not found.");
    }
    if (checkpoint.status !== "PENDING") {
      throw new ConflictException("Human checkpoint is no longer pending.");
    }
    if (checkpoint.expiresAt && checkpoint.expiresAt <= new Date()) {
      await this.prisma.testRunHumanCheckpoint.updateMany({
        data: { status: "EXPIRED" },
        where: { id: checkpointId, status: "PENDING" },
      });
      throw new ConflictException("Human checkpoint has expired.");
    }
    const resolvedAt = new Date();
    const updated = await this.prisma.testRunHumanCheckpoint.updateMany({
      data: {
        resolvedAt,
        resolvedByUserId: current.user.id,
        response: json(input.response),
        status: "RESOLVED",
      },
      where: { id: checkpointId, status: "PENDING", teamId: current.team.id },
    });
    if (updated.count !== 1) {
      throw new ConflictException(
        "Human checkpoint was resolved concurrently.",
      );
    }
    await this.audit.record(
      current,
      "test.run.checkpoint.resolved",
      "test_run_human_checkpoint",
      checkpointId,
      { runId },
    );
    return this.prisma.testRunHumanCheckpoint.findUniqueOrThrow({
      where: { id: checkpointId },
    });
  }

  async decryptEnvironmentSecrets(teamId: string, environmentId: string) {
    const environment = await this.requireEnvironment(teamId, environmentId);
    if (!environment.secretsEnc) {
      return {};
    }
    return JSON.parse(this.cipher.decrypt(environment.secretsEnc)) as Record<
      string,
      string
    >;
  }

  private publicEnvironment<T extends { secretsEnc: string | null }>(row: T) {
    const { secretsEnc: _secretsEnc, ...publicRow } = row;
    return publicRow;
  }

  private async requireProject(teamId: string, projectId: string) {
    const row = await this.prisma.testProject.findFirst({
      where: { id: projectId, teamId },
    });
    if (!row) {
      throw new NotFoundException("Test project was not found.");
    }
    return row;
  }

  private async requireEnvironment(teamId: string, environmentId: string) {
    const row = await this.prisma.testEnvironment.findFirst({
      where: { id: environmentId, teamId },
    });
    if (!row) {
      throw new NotFoundException("Test environment was not found.");
    }
    return row;
  }

  private async requireCase(teamId: string, caseId: string) {
    const row = await this.prisma.testCase.findFirst({
      where: { id: caseId, teamId },
    });
    if (!row) {
      throw new NotFoundException("Test case was not found.");
    }
    return row;
  }

  private async requireRun(teamId: string, runId: string) {
    const row = await this.prisma.testRun.findFirst({
      where: { id: runId, teamId },
    });
    if (!row) {
      throw new NotFoundException("Test run was not found.");
    }
    return row;
  }
}

class VersionRaceError extends Error {}
