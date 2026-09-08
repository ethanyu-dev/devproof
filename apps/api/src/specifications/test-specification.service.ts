import {
  generatedTestCaseDefinitionSchema,
  testGenerationContextSchema,
} from "@devproof/contracts";
import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../database/prisma.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";

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
  constructor(private readonly prisma: PrismaService) {}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
