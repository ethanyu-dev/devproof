import {
  generatedTestCaseDefinitionSchema,
  specificationSyncInputSchema,
  testGenerationContextSchema,
  type ExecutionRunCreateInput,
  type GeneratedTestCaseDefinition,
  type TestGenerationContext,
} from "@devproof/contracts";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  generateBusinessTestSpec,
  selectPrimaryPullRequest,
  testGenerationContextHash,
} from "@devproof/test-domain";

import { PrismaService } from "../database/prisma.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { ExecutionRunService } from "../execution-runs/execution-run.service.js";
import { redactText } from "../observability/observability.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { IssueContextResolverService } from "./issue-context-resolver.service.js";

const specificationInclude = {
  cases: {
    include: {
      executionRun: {
        include: {
          attempts: { orderBy: { number: "desc" as const }, take: 1 },
          evidences: { orderBy: { createdAt: "asc" as const } },
        },
      },
    },
    orderBy: [
      { generationVersion: "desc" as const },
      { position: "asc" as const },
    ],
  },
} satisfies Prisma.TestSpecificationInclude;

type SpecificationRow = Prisma.TestSpecificationGetPayload<{
  include: typeof specificationInclude;
}>;

@Injectable()
export class TestSpecificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: ExecutionRunService,
    private readonly resolver: IssueContextResolverService,
  ) {}

  async list(current: ToolAuthContext) {
    const rows = await this.prisma.testSpecification.findMany({
      include: specificationInclude,
      orderBy: { updatedAt: "desc" },
      take: 100,
      where: { teamId: current.team.id },
    });
    return rows.map(toDetail);
  }

  async get(current: ToolAuthContext, id: string) {
    const row = await this.prisma.testSpecification.findFirst({
      include: specificationInclude,
      where: { id, teamId: current.team.id },
    });
    if (!row) throw new NotFoundException(`Specification ${id} was not found.`);
    return toDetail(row);
  }

  async resolve(current: ToolAuthContext, issueRef: string) {
    const resolved = await this.resolver.resolve(issueRef, current.team.id);
    const specification = await this.sync(current, {
      context: resolved.context,
      forceRegeneration: false,
    });
    return { ...resolved, specification };
  }

  async regenerate(current: ToolAuthContext, id: string) {
    const currentSpecification = await this.get(current, id);
    const resolved = await this.resolver.resolve(
      currentSpecification.issueUrl,
      current.team.id,
    );
    const specification = await this.sync(current, {
      context: resolved.context,
      forceRegeneration: true,
    });
    return { ...resolved, specification };
  }

  async sync(current: ToolAuthContext, rawInput: unknown) {
    const input = specificationSyncInputSchema.parse(rawInput);
    const context = input.context;
    const sourceHash = testGenerationContextHash(context);
    const generated = generateBusinessTestSpec(context);
    const parsedCases = generated.cases.map((item) =>
      generatedTestCaseDefinitionSchema.parse(item),
    );
    const primaryPullRequest = selectPrimaryPullRequest(context);
    const generatedAt = new Date();

    const specificationId = await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(
        tx,
        `${current.team.id}:${context.issue.id}`,
      );
      const existing = await tx.testSpecification.findUnique({
        where: {
          teamId_issueId: {
            issueId: context.issue.id,
            teamId: current.team.id,
          },
        },
      });
      if (existing?.sourceHash === sourceHash && !input.forceRegeneration) {
        return existing.id;
      }
      const version = (existing?.currentVersion ?? 0) + 1;
      const discoveredTarget = primaryPullRequest?.deploymentUrl ?? null;
      const acceptDiscoveredTarget = Boolean(
        discoveredTarget && !existing?.targetUrl,
      );
      const common = {
        context: asJson(context),
        currentVersion: version,
        generatedAt,
        issueIdentifier: context.issue.identifier,
        issueState: context.issue.state,
        issueTitle: context.issue.title,
        issueUrl: context.issue.url,
        primaryPullRequestUrl: primaryPullRequest?.url ?? null,
        sourceHash,
        summary: generated.summary,
        targetProvidedAt: acceptDiscoveredTarget
          ? generatedAt
          : (existing?.targetProvidedAt ?? null),
        targetProvidedBy: acceptDiscoveredTarget
          ? "integration:github"
          : (existing?.targetProvidedBy ?? null),
        targetSource: acceptDiscoveredTarget
          ? ("GITHUB" as const)
          : (existing?.targetSource ?? null),
        targetUrl:
          (acceptDiscoveredTarget ? discoveredTarget : existing?.targetUrl) ??
          null,
      };
      const cases = parsedCases.map((definition, position) => ({
        definition: asJson(definition),
        generatedAt,
        generationVersion: version,
        name: definition.name,
        position,
        teamId: current.team.id,
      }));
      if (existing) {
        await tx.testSpecification.update({
          data: { ...common, cases: { create: cases } },
          where: { id: existing.id },
        });
        return existing.id;
      }
      const created = await tx.testSpecification.create({
        data: {
          ...common,
          cases: { create: cases },
          issueId: context.issue.id,
          teamId: current.team.id,
        },
        select: { id: true },
      });
      return created.id;
    });

    await this.executePending(current, specificationId);
    return this.get(current, specificationId);
  }

  async setDeploymentTarget(
    current: ToolAuthContext,
    id: string,
    rawUrl: string,
  ) {
    const url = normalizeTargetUrl(rawUrl);
    const specification = await this.prisma.testSpecification.findFirst({
      where: { id, teamId: current.team.id },
    });
    if (!specification) {
      throw new NotFoundException(`Specification ${id} was not found.`);
    }
    if (specification.targetUrl && specification.targetUrl !== url) {
      throw new ConflictException(
        "This specification already has a deployment target.",
      );
    }
    await this.prisma.testSpecification.update({
      data: {
        targetProvidedAt: new Date(),
        targetProvidedBy: current.credential.id,
        targetSource: "MANUAL",
        targetUrl: url,
      },
      where: { id },
    });
    await this.executePending(current, id);
    return this.get(current, id);
  }

  async reconcilePending(limit = 50) {
    const specifications = await this.prisma.$queryRaw<
      Array<{
        id: string;
        teamId: string;
        teamName: string;
        teamSlug: string;
      }>
    >(Prisma.sql`
      SELECT
        specification."id",
        team."id" AS "teamId",
        team."name" AS "teamName",
        team."slug" AS "teamSlug"
      FROM "test_specifications" specification
      JOIN "teams" team ON team."id" = specification."team_id"
      WHERE specification."target_url" IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM "generated_test_cases" generated_case
          WHERE generated_case."specification_id" = specification."id"
            AND generated_case."generation_version" = specification."current_version"
            AND generated_case."execution_run_id" IS NULL
            AND (
              generated_case."execution_requested_at" IS NULL
              OR generated_case."execution_requested_at" < NOW() - INTERVAL '5 minutes'
            )
        )
      ORDER BY specification."updated_at" ASC
      LIMIT ${Math.max(1, Math.min(limit, 200))}
    `);
    const failures: string[] = [];
    for (const specification of specifications) {
      try {
        await this.executePending(
          {
            credential: {
              id: "system:specification-execution-worker",
              name: "Specification execution worker",
              scopes: ["run:read", "run:write", "run:cancel"],
            },
            team: {
              id: specification.teamId,
              name: specification.teamName,
              slug: specification.teamSlug,
            },
          },
          specification.id,
        );
      } catch (error) {
        failures.push(safeDispatchError(error));
      }
    }
    if (failures.length) {
      throw new Error(
        `Failed to dispatch ${failures.length}/${specifications.length} specification(s): ${failures[0]}`,
      );
    }
    return { inspected: specifications.length };
  }

  private async executePending(
    current: ToolAuthContext,
    specificationId: string,
  ) {
    const specification = await this.prisma.testSpecification.findFirst({
      include: {
        cases: {
          orderBy: { position: "asc" },
          where: { executionRunId: null },
        },
      },
      where: { id: specificationId, teamId: current.team.id },
    });
    if (!specification?.targetUrl) return;
    const target = new URL(specification.targetUrl);
    const failures: string[] = [];
    for (const item of specification.cases.filter(
      (candidate) =>
        candidate.generationVersion === specification.currentVersion,
    )) {
      const claimed = await this.prisma.generatedTestCase.updateMany({
        data: {
          executionAttempts: { increment: 1 },
          executionLastError: Prisma.DbNull,
          executionRequestedAt: new Date(),
        },
        where: {
          executionRunId: null,
          id: item.id,
          OR: [
            { executionRequestedAt: null },
            {
              executionRequestedAt: {
                lt: new Date(Date.now() - 5 * 60_000),
              },
            },
          ],
        },
      });
      if (claimed.count !== 1) continue;
      try {
        const definition = generatedTestCaseDefinitionSchema.parse(
          item.definition,
        );
        const run = await this.runs.create(
          current,
          executionRequest(specification, item.id, definition, target),
        );
        await this.prisma.generatedTestCase.updateMany({
          data: {
            executionLastError: Prisma.DbNull,
            executionRunId: run.id,
          },
          where: { executionRunId: null, id: item.id },
        });
      } catch (error) {
        const message = safeDispatchError(error);
        await this.prisma.generatedTestCase.updateMany({
          data: {
            executionLastError: asJson({
              at: new Date().toISOString(),
              code: "RUN_DISPATCH_FAILED",
              message,
            }),
            executionRequestedAt: new Date(),
          },
          where: { executionRunId: null, id: item.id },
        });
        failures.push(`${item.id}: ${message}`);
      }
    }
    if (failures.length) {
      throw new Error(
        `Failed to dispatch ${failures.length} generated Case(s): ${failures[0]}`,
      );
    }
  }
}

function executionRequest(
  specification: {
    context: Prisma.JsonValue;
    id: string;
    issueIdentifier: string;
    issueTitle: string;
    targetUrl: string | null;
  },
  caseId: string,
  definition: GeneratedTestCaseDefinition,
  target: URL,
): ExecutionRunCreateInput {
  const references = specificationBusinessReferences(specification);
  return {
    businessReferences: references,
    browserPolicy: {
      availabilityPolicy: "WAIT",
      profile: { mode: "EPHEMERAL" },
      requiredCapabilities: ["browser"],
    },
    criteria: definition.expected.map((expected, index) => ({
      description: expected,
      id: `expected-${index + 1}`,
      required: true,
      requiredEvidenceKinds: definition.evidence.map(
        (evidence) => evidence.kind,
      ),
    })),
    deadlineSeconds: 900,
    deadlinePolicy: { mode: "FIXED" },
    environment: {
      allowedHosts: [target.hostname],
      authRole: definition.authRole,
      specificationId: specification.id,
      targetUrl: specification.targetUrl,
    },
    goal: [
      `${specification.issueIdentifier} · ${specification.issueTitle}`,
      definition.name,
      "Preconditions:",
      ...definition.preconditions.map((value) => `- ${value}`),
      "Steps:",
      ...definition.steps.map((step) => `${step.order}. ${step.action}`),
      "Expected:",
      ...definition.expected.map((value) => `- ${value}`),
    ].join("\n"),
    hitlPolicy: {
      enabled: true,
      notificationChannels: ["FEISHU"],
      onTimeout: "INCONCLUSIVE",
      timeoutSeconds: 3600,
    },
    idempotencyKey: `spec-case:${caseId}`,
    retryPolicy: {
      maxAttempts: 3,
      retryOn: [
        "TOOL_EXECUTION",
        "PROVIDER",
        "LIFECYCLE_PROTOCOL",
        "BROWSER_RUNTIME",
        "RUNTIME_LOST",
      ],
    },
    source: { id: caseId, kind: "SPEC_CASE" },
  };
}

function specificationBusinessReferences(specification: {
  context: Prisma.JsonValue;
  id: string;
}) {
  const context = testGenerationContextSchema.parse(specification.context);
  const prefix = `reference://spec/${specification.id}`;
  const references: ExecutionRunCreateInput["businessReferences"] = [
    {
      externalId: `${prefix}/issue`,
      kind: "BUSINESS_REFERENCE",
      label: `${context.issue.identifier} · ${context.issue.title}`,
      metadata: {
        excerpt: referenceExcerpt(context.issue.description),
        source: "LINEAR",
        state: context.issue.state,
        title: context.issue.title,
        url: safeReferenceUrl(context.issue.url),
      },
    },
  ];
  context.pullRequests.slice(0, 25).forEach((pullRequest, index) => {
    references.push({
      externalId: `${prefix}/pull-request/${index + 1}`,
      kind: "BUSINESS_REFERENCE",
      label: `${pullRequest.repository}#${pullRequest.number} · ${pullRequest.title}`,
      metadata: {
        changedFiles: pullRequest.changedFiles.slice(0, 100),
        excerpt: referenceExcerpt(pullRequest.body),
        repository: pullRequest.repository,
        source: "GITHUB",
        title: pullRequest.title,
        url: safeReferenceUrl(pullRequest.url),
      },
    });
  });
  context.knowledge.slice(0, 25).forEach((knowledge, index) => {
    references.push({
      externalId: `${prefix}/knowledge/${index + 1}`,
      kind: "BUSINESS_REFERENCE",
      label: knowledge.title,
      metadata: {
        excerpt: referenceExcerpt(knowledge.content),
        source: "KNOWLEDGE",
        title: knowledge.title,
        ...(knowledge.url ? { url: safeReferenceUrl(knowledge.url) } : {}),
      },
    });
  });
  return references;
}

function referenceExcerpt(value: string) {
  return redactText(value)
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/\S+/gu, "[link]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
}

function safeReferenceUrl(value: string) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function toDetail(row: SpecificationRow) {
  const context = testGenerationContextSchema.parse(row.context);
  const cases = row.cases
    .filter((item) => item.generationVersion === row.currentVersion)
    .map((item) => {
      const definition = generatedTestCaseDefinitionSchema.parse(
        item.definition,
      );
      const run = item.executionRun;
      const latestAttempt = run?.attempts[0];
      const result = isRecord(latestAttempt?.result)
        ? latestAttempt.result
        : null;
      return {
        ...definition,
        dispatch: {
          attempts: item.executionAttempts,
          lastError: isRecord(item.executionLastError)
            ? item.executionLastError
            : null,
          requestedAt: item.executionRequestedAt?.toISOString() ?? null,
          status: run
            ? "LINKED"
            : item.executionLastError
              ? "FAILED"
              : item.executionRequestedAt
                ? "DISPATCHING"
                : "WAITING",
        },
        execution: run
          ? {
              evidenceRefs: run.evidences.map(
                (evidence) => evidence.externalId,
              ),
              executionDisposition: run.executionDisposition,
              lifecycle: run.lifecycle,
              runId: run.id,
              summary:
                result && typeof result.summary === "string"
                  ? result.summary
                  : null,
              verdict: run.verdict,
            }
          : null,
        generationVersion: item.generationVersion,
        id: item.id,
        position: item.position,
      };
    });
  const counts = {
    cancelled: cases.filter((item) => item.execution?.lifecycle === "CANCELLED")
      .length,
    dispatchFailed: cases.filter((item) => item.dispatch.status === "FAILED")
      .length,
    failed: cases.filter((item) => item.execution?.verdict === "FAILED").length,
    inconclusive: cases.filter(
      (item) =>
        item.execution?.verdict === "INCONCLUSIVE" ||
        (item.execution?.lifecycle === "COMPLETED" &&
          item.execution.verdict === null),
    ).length,
    passed: cases.filter((item) => item.execution?.verdict === "PASSED").length,
    running: cases.filter((item) =>
      ["PREPARING", "RUNNING", "WAITING_HUMAN"].includes(
        item.execution?.lifecycle ?? "",
      ),
    ).length,
    timedOut: cases.filter((item) => item.execution?.lifecycle === "TIMED_OUT")
      .length,
    total: cases.length,
    waiting: cases.filter(
      (item) => !item.execution || item.execution.lifecycle === "QUEUED",
    ).length,
  };
  return {
    cases,
    context,
    counts,
    currentVersion: row.currentVersion,
    generatedAt: row.generatedAt.toISOString(),
    id: row.id,
    issueId: row.issueId,
    issueIdentifier: row.issueIdentifier,
    issueState: row.issueState,
    issueTitle: row.issueTitle,
    issueUrl: row.issueUrl,
    pullRequestCount: context.pullRequests.length,
    primaryPullRequestUrl: row.primaryPullRequestUrl,
    sourceHash: row.sourceHash,
    status: specificationStatus(Boolean(row.targetUrl), cases, counts),
    summary: row.summary,
    targetProvidedAt: row.targetProvidedAt?.toISOString() ?? null,
    targetProvidedBy: row.targetProvidedBy,
    targetSource: row.targetSource,
    targetUrl: row.targetUrl,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function specificationStatus(
  hasTarget: boolean,
  cases: Array<{
    dispatch: { status: string };
    execution: { lifecycle: string; verdict: string | null } | null;
  }>,
  counts: {
    cancelled: number;
    dispatchFailed: number;
    failed: number;
    inconclusive: number;
    passed: number;
    running: number;
    timedOut: number;
  },
) {
  if (!hasTarget) return "WAITING_DEPLOYMENT";
  if (counts.dispatchFailed) return "DISPATCH_FAILED";
  if (!cases.length || cases.some((item) => !item.execution)) return "READY";
  if (
    cases.some((item) =>
      ["QUEUED", "PREPARING", "RUNNING", "WAITING_HUMAN"].includes(
        item.execution?.lifecycle ?? "",
      ),
    )
  ) {
    return "RUNNING";
  }
  if (counts.failed) return "FAILED";
  if (counts.cancelled === cases.length) return "CANCELLED";
  if (counts.inconclusive || counts.cancelled || counts.timedOut) {
    return "INCONCLUSIVE";
  }
  if (counts.passed === cases.length) return "PASSED";
  return "INCONCLUSIVE";
}

function normalizeTargetUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    url.hash = "";
    return url.toString();
  } catch {
    throw new BadRequestException("Deployment target must be an HTTP(S) URL.");
  }
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeDispatchError(error: unknown) {
  return redactText(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 4_000);
}
