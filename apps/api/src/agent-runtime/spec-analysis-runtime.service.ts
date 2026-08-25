import { createHash, randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  runtimeGeneratedSpecSchema,
  runtimeSpecAnalysisOutcomeSchema,
  runtimeSpecAnalysisToolOutputSchema,
  runtimeSpecSourceRefSchema,
  runtimeTraceEventSchema,
  type RuntimeSpecAnalysisOutcome,
  type RuntimeSpecAnalysisTaskOutcomeInput,
  type RuntimeSpecAnalysisToolInput,
  type RuntimeSpecSourceRef,
} from "@devproof/agent-runtime-protocol";
import {
  specificationIssueContextSchema,
  taskExecutionCreateInputSchema,
  testGenerationContextSchema,
} from "@devproof/contracts";
import {
  generateBusinessTestSpec,
  selectPrimaryPullRequest,
  specificationDefinitionHash,
} from "@devproof/test-domain";
import { z } from "zod";

import { AgentModelConfigurationService } from "../console/agent-model-configuration.service.js";
import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { GithubPullRequestClient } from "../specifications/github-pull-request.client.js";
import { KnowledgeContextClient } from "../specifications/knowledge-context.client.js";
import { LinearContextClient } from "../specifications/linear-context.client.js";

const SPEC_PROTOCOL_MINOR = 3;
const SOURCE_PAGE_SIZE = 20;
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_SOURCE_COUNT = 250;
const MAX_SINGLE_SOURCE_BYTES = 250_000;

const analysisSummarySchema = z.string().trim().min(1).max(4_000);
const githubToolSchema = z.object({
  analysisSummary: analysisSummarySchema,
  pullRequestUrl: z.string().url().max(2_000),
});
const changedFilesToolSchema = githubToolSchema.extend({
  page: z.number().int().min(1).max(15).default(1),
});
const readFileToolSchema = githubToolSchema.extend({
  endLine: z.number().int().positive().optional(),
  path: z.string().trim().min(1).max(2_000),
  startLine: z.number().int().positive().optional(),
});
const searchCodeToolSchema = githubToolSchema.extend({
  pathPrefix: z.string().trim().min(1).max(2_000).optional(),
  query: z.string().trim().min(2).max(500),
});
const knowledgeToolSchema = z.object({
  analysisSummary: analysisSummarySchema,
  query: z.string().trim().min(3).max(20_000),
});

type LeaseInput = {
  fencingToken: string;
  leaseToken: string;
  workerId: string;
};

@Injectable()
export class SpecAnalysisRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly models: AgentModelConfigurationService,
    private readonly linear: LinearContextClient,
    private readonly github: GithubPullRequestClient,
    private readonly knowledge: KnowledgeContextClient,
  ) {}

  async claim(
    teamId: string,
    input: {
      protocol: { minor: number };
      workerId: string;
    },
  ) {
    if (env().SPEC_ANALYSIS_MODE === "DETERMINISTIC") return { task: null };
    if (input.protocol.minor < SPEC_PROTOCOL_MINOR) {
      throw new BadRequestException(
        `Agent Runtime protocol minor ${SPEC_PROTOCOL_MINOR} or newer is required for Spec analysis.`,
      );
    }
    const modelCandidates = await this.models.candidatesForTeam(teamId);
    if (!modelCandidates.length) return { task: null };

    for (let collision = 0; collision < 5; collision += 1) {
      const claimed = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const candidate = await tx.taskStageAttempt.findFirst({
          orderBy: { createdAt: "asc" },
          where: {
            stage: {
              taskExecution: {
                cancelRequestedAt: null,
                deadlineAt: { gt: now },
                lifecycle: { in: ["QUEUED", "RUNNING"] },
                teamId,
              },
              type: "SPEC_ANALYSIS",
            },
            OR: [
              { status: "PENDING" },
              { leaseExpiresAt: { lt: now }, status: "RUNNING" },
            ],
          },
        });
        if (!candidate) return null;
        const leaseToken = randomUUID();
        const leaseExpiresAt = leaseExpiry(now);
        const acquired = await tx.taskStageAttempt.updateMany({
          data: {
            fencingToken: { increment: 1 },
            leaseExpiresAt,
            leaseOwner: input.workerId,
            leaseToken,
            startedAt: candidate.startedAt ?? now,
            status: "RUNNING",
          },
          where: {
            id: candidate.id,
            OR: [
              { status: "PENDING" },
              { leaseExpiresAt: { lt: now }, status: "RUNNING" },
            ],
          },
        });
        if (acquired.count !== 1) return undefined;
        const attempt = await tx.taskStageAttempt.findUniqueOrThrow({
          include: { stage: { include: { taskExecution: true } } },
          where: { id: candidate.id },
        });
        await tx.taskExecutionStage.update({
          data: {
            startedAt: attempt.stage.startedAt ?? now,
            status: "RUNNING",
          },
          where: { id: attempt.stageId },
        });
        await tx.taskExecution.update({
          data: {
            lifecycle: "RUNNING",
            startedAt: attempt.stage.taskExecution.startedAt ?? now,
          },
          where: { id: attempt.stage.taskExecutionId },
        });
        await tx.taskExecutionEvent.create({
          data: taskEvent(
            teamId,
            attempt.stage.taskExecutionId,
            "AGENT_RUNTIME",
            "task.stage.started",
            {
              attemptNumber: attempt.number,
              stage: "SPEC_ANALYSIS",
              stageAttemptId: attempt.id,
            },
          ),
        });
        return attempt;
      });
      if (claimed === undefined) continue;
      if (claimed === null) return { task: null };
      const createInput = taskExecutionCreateInputSchema.parse(
        claimed.stage.taskExecution.inputSnapshot,
      );
      if (createInput.kind !== "ISSUE_SPEC") {
        throw new ConflictException("Only Issue tasks support Spec analysis.");
      }
      return {
        task: {
          fencingToken: claimed.fencingToken.toString(),
          leaseExpiresAt: claimed.leaseExpiresAt!.toISOString(),
          leaseToken: claimed.leaseToken!,
          snapshot: {
            attemptNumber: claimed.number,
            deadlineAt: claimed.stage.taskExecution.deadlineAt.toISOString(),
            issueRef: createInput.issueRef,
            modelCandidates,
            stageAttemptId: claimed.id,
            ...(createInput.targetUrl
              ? { targetUrl: createInput.targetUrl }
              : {}),
            taskExecutionId: claimed.stage.taskExecutionId,
            teamId,
            traceId: claimed.stage.taskExecution.traceId,
          },
          taskId: claimed.id,
        },
      };
    }
    return { task: null };
  }

  async heartbeat(teamId: string, attemptId: string, input: LeaseInput) {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await this.findAttempt(tx, teamId, attemptId);
      this.requireLease(attempt, input);
      const now = new Date();
      const cancelled =
        attempt.stage.taskExecution.cancelRequestedAt !== null ||
        attempt.stage.taskExecution.deadlineAt <= now ||
        ["CANCELLED", "TIMED_OUT"].includes(
          attempt.stage.taskExecution.lifecycle,
        );
      if (cancelled) {
        return {
          deadlineAt: attempt.stage.taskExecution.deadlineAt.toISOString(),
          directive: "CANCEL" as const,
          leaseExpiresAt: (attempt.leaseExpiresAt ?? now).toISOString(),
        };
      }
      if (attempt.status !== "RUNNING") {
        throw new ConflictException("The Spec analysis attempt is terminal.");
      }
      const leaseExpiresAt = leaseExpiry(now);
      await tx.taskStageAttempt.update({
        data: { leaseExpiresAt },
        where: { id: attempt.id },
      });
      return {
        deadlineAt: attempt.stage.taskExecution.deadlineAt.toISOString(),
        directive: "CONTINUE" as const,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      };
    });
  }

  async appendEvent(
    teamId: string,
    attemptId: string,
    input: LeaseInput & {
      event: {
        eventId: string;
        kind: string;
        occurredAt: string;
        payload: Record<string, unknown>;
      };
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await this.findAttempt(tx, teamId, attemptId);
      this.requireLease(attempt, input);
      const trace = runtimeTraceEventSchema.safeParse({
        kind: input.event.kind,
        payload: input.event.payload,
      });
      if (!trace.success) {
        throw new BadRequestException(trace.error.message);
      }
      try {
        const row = await tx.taskExecutionEvent.create({
          data: {
            ...taskEvent(
              teamId,
              attempt.stage.taskExecutionId,
              "AGENT_RUNTIME",
              input.event.kind,
              {
                ...input.event.payload,
                stage: "SPEC_ANALYSIS",
                stageAttemptId: attempt.id,
              },
            ),
            id: input.event.eventId,
            occurredAt: new Date(input.event.occurredAt),
          },
        });
        return { accepted: true, sequence: row.sequence.toString() };
      } catch (error) {
        if (!uniqueConstraint(error)) throw error;
        const row = await tx.taskExecutionEvent.findUnique({
          where: { id: input.event.eventId },
        });
        if (!row || row.taskExecutionId !== attempt.stage.taskExecutionId) {
          throw error;
        }
        return { accepted: true, sequence: row.sequence.toString() };
      }
    });
  }

  async executeTool(
    teamId: string,
    attemptId: string,
    input: RuntimeSpecAnalysisToolInput,
  ) {
    const attempt = await this.prisma.taskStageAttempt.findUnique({
      include: { stage: { include: { taskExecution: true } } },
      where: { id: attemptId },
    });
    if (!attempt || attempt.stage.taskExecution.teamId !== teamId) {
      throw new NotFoundException("Spec analysis attempt was not found.");
    }
    this.requireLease(attempt, input);
    const createInput = taskExecutionCreateInputSchema.parse(
      attempt.stage.taskExecution.inputSnapshot,
    );
    if (createInput.kind !== "ISSUE_SPEC") {
      throw new ConflictException("Only Issue tasks support analysis tools.");
    }

    if (input.name === "linear_get_issue") {
      analysisSummarySchema.parse(input.arguments.analysisSummary);
      const result = await this.linear.getIssue(createInput.issueRef);
      const source = await this.persistSource(attempt, {
        content: result,
        excerpt: result.issue.description.slice(0, 2_000),
        kind: "LINEAR_ISSUE",
        label: `${result.issue.identifier} · ${result.issue.title}`,
        locator: { issueId: result.issue.id },
        revision: null,
        uri: result.issue.url,
      });
      return runtimeSpecAnalysisToolOutputSchema.parse({
        result: { ...result, sourceRef: source.externalId },
        sourceRefs: [source],
      });
    }

    const issueSource = await this.requireIssueSource(attempt.id);
    const issuePayload = sourceContent(issueSource.content);
    const issue = specificationIssueContextSchema.parse(
      record(issuePayload).issue,
    );
    const allowedPullRequests = new Set(
      z.array(z.string().url()).parse(record(issuePayload).pullRequestUrls),
    );

    if (input.name === "github_get_pull_request") {
      const arguments_ = githubToolSchema.parse(input.arguments);
      requireAllowedPullRequest(arguments_.pullRequestUrl, allowedPullRequests);
      const result = await this.github.getPullRequest(
        teamId,
        arguments_.pullRequestUrl,
        [...allowedPullRequests][0] === arguments_.pullRequestUrl,
      );
      const source = await this.persistSource(attempt, {
        content: result,
        excerpt: result.pullRequest.body.slice(0, 2_000),
        kind: "GITHUB_PULL_REQUEST",
        label: `${result.pullRequest.repository}#${result.pullRequest.number} · ${result.pullRequest.title}`,
        locator: { pullRequestNumber: result.pullRequest.number },
        revision: result.pullRequest.headSha,
        uri: result.pullRequest.url,
      });
      return runtimeSpecAnalysisToolOutputSchema.parse({
        result: { ...result, sourceRef: source.externalId },
        sourceRefs: [source],
      });
    }

    if (input.name === "github_list_changed_files") {
      const arguments_ = changedFilesToolSchema.parse(input.arguments);
      requireAllowedPullRequest(arguments_.pullRequestUrl, allowedPullRequests);
      const result = await this.github.changedFiles(
        teamId,
        arguments_.pullRequestUrl,
      );
      const offset = (arguments_.page - 1) * SOURCE_PAGE_SIZE;
      const page = result.files.slice(offset, offset + SOURCE_PAGE_SIZE);
      const sources = await this.persistSources(
        attempt,
        page.map((file) => ({
          content: file,
          excerpt: file.patch.slice(0, 2_000),
          kind: "GITHUB_DIFF" as const,
          label: file.path,
          locator: { path: file.path },
          revision: result.revision,
          uri: `${arguments_.pullRequestUrl}/files#${encodeURIComponent(file.path)}`,
        })),
      );
      return runtimeSpecAnalysisToolOutputSchema.parse({
        result: {
          files: page.map((file, index) => ({
            ...file,
            sourceRef: sources[index]!.externalId,
          })),
          hasMore: offset + page.length < result.files.length,
          page: arguments_.page,
          revision: result.revision,
          total: result.files.length,
        },
        sourceRefs: sources,
      });
    }

    if (input.name === "github_read_file") {
      const arguments_ = readFileToolSchema.parse(input.arguments);
      requireAllowedPullRequest(arguments_.pullRequestUrl, allowedPullRequests);
      const result = await this.github.readPullRequestFile({
        ...(arguments_.endLine ? { endLine: arguments_.endLine } : {}),
        path: arguments_.path,
        pullRequestUrl: arguments_.pullRequestUrl,
        ...(arguments_.startLine ? { startLine: arguments_.startLine } : {}),
        teamId,
      });
      const source = await this.persistSource(attempt, {
        content: result,
        excerpt: result.content.slice(0, 2_000),
        kind: "GITHUB_FILE",
        label: result.path,
        locator: {
          endLine: result.endLine,
          path: result.path,
          startLine: result.startLine,
        },
        revision: result.revision,
        uri: `${arguments_.pullRequestUrl}/files#${encodeURIComponent(result.path)}`,
      });
      return runtimeSpecAnalysisToolOutputSchema.parse({
        result: { ...result, sourceRef: source.externalId },
        sourceRefs: [source],
      });
    }

    if (input.name === "github_search_code") {
      const arguments_ = searchCodeToolSchema.parse(input.arguments);
      requireAllowedPullRequest(arguments_.pullRequestUrl, allowedPullRequests);
      const result = await this.github.searchPullRequestCode({
        ...(arguments_.pathPrefix ? { pathPrefix: arguments_.pathPrefix } : {}),
        pullRequestUrl: arguments_.pullRequestUrl,
        query: arguments_.query,
        teamId,
      });
      const sources = await this.persistSources(
        attempt,
        result.matches.map((match) => ({
          content: match,
          excerpt: match.snippet.slice(0, 2_000),
          kind: "GITHUB_FILE" as const,
          label: match.path,
          locator: {
            endLine: match.endLine,
            path: match.path,
            query: result.query,
            startLine: match.startLine,
          },
          revision: match.revision,
          uri: `${arguments_.pullRequestUrl}/files#${encodeURIComponent(match.path)}`,
        })),
      );
      return runtimeSpecAnalysisToolOutputSchema.parse({
        result: {
          matches: result.matches.map((match, index) => ({
            ...match,
            sourceRef: sources[index]!.externalId,
          })),
          query: result.query,
          revision: result.revision,
        },
        sourceRefs: sources,
      });
    }

    if (input.name === "knowledge_search") {
      const arguments_ = knowledgeToolSchema.parse(input.arguments);
      const result = await this.knowledge.resolve(issue, arguments_.query);
      const sources = await this.persistSources(
        attempt,
        result.items.map((item) => ({
          content: { item, query: arguments_.query },
          excerpt: item.content.slice(0, 2_000),
          kind: "KNOWLEDGE" as const,
          label: item.title,
          locator: { documentId: item.id },
          revision: item.updatedAt,
          uri: item.url ?? `knowledge://${encodeURIComponent(item.id)}`,
        })),
      );
      return runtimeSpecAnalysisToolOutputSchema.parse({
        result: {
          diagnostics: result.diagnostics,
          items: result.items.map((item, index) => ({
            ...item,
            sourceRef: sources[index]!.externalId,
          })),
          query: arguments_.query,
        },
        sourceRefs: sources,
      });
    }

    throw new BadRequestException(
      `Unsupported Spec analysis tool: ${input.name}`,
    );
  }

  async submitOutcome(
    teamId: string,
    attemptId: string,
    input: RuntimeSpecAnalysisTaskOutcomeInput,
  ) {
    const outcome = runtimeSpecAnalysisOutcomeSchema.parse(input.outcome);
    const attempt = await this.prisma.taskStageAttempt.findUnique({
      include: {
        analysisSources: { orderBy: { createdAt: "asc" } },
        stage: { include: { taskExecution: true } },
      },
      where: { id: attemptId },
    });
    if (!attempt || attempt.stage.taskExecution.teamId !== teamId) {
      throw new NotFoundException("Spec analysis attempt was not found.");
    }
    const acknowledged = acknowledgedOutcome(
      attempt.result,
      input.completionId,
    );
    if (acknowledged) return acknowledged;
    this.requireLease(attempt, input);
    if (attempt.status !== "RUNNING") {
      throw new ConflictException("The Spec analysis attempt is terminal.");
    }
    if (outcome.kind !== "SPEC_GENERATED") {
      return this.persistFailure(attempt, input.completionId, outcome);
    }
    return this.persistGeneratedSpec(attempt, input.completionId, outcome);
  }

  private async persistGeneratedSpec(
    attempt: Awaited<ReturnType<SpecAnalysisRuntimeService["loadedAttempt"]>>,
    completionId: string,
    outcome: Extract<RuntimeSpecAnalysisOutcome, { kind: "SPEC_GENERATED" }>,
  ) {
    const spec = runtimeGeneratedSpecSchema.parse(outcome.spec);
    const available = new Map(
      attempt.analysisSources.map((source) => [source.externalId, source]),
    );
    const referenced = specSourceIds(spec);
    for (const sourceRef of [...outcome.sourceRefs, ...referenced]) {
      if (
        !available.has(
          typeof sourceRef === "string" ? sourceRef : sourceRef.externalId,
        )
      ) {
        throw new BadRequestException(
          `Spec references an unavailable analysis source: ${
            typeof sourceRef === "string" ? sourceRef : sourceRef.externalId
          }`,
        );
      }
    }
    const context = buildContext(attempt.analysisSources);
    const primaryPullRequest = selectPrimaryPullRequest(context);
    const createInput = taskExecutionCreateInputSchema.parse(
      attempt.stage.taskExecution.inputSnapshot,
    );
    if (createInput.kind !== "ISSUE_SPEC") {
      throw new ConflictException("Only Issue tasks support generated Specs.");
    }
    const targetUrl =
      createInput.targetUrl ?? primaryPullRequest?.deploymentUrl ?? null;
    const normalizedTarget = targetUrl ? normalizeTargetUrl(targetUrl) : null;
    const target = normalizedTarget ? new URL(normalizedTarget) : null;
    const sourceHash = hashJson(
      attempt.analysisSources.map((source) => ({
        contentHash: source.contentHash,
        externalId: source.externalId,
      })),
    );
    const completeness = context.resolution.completeness;
    const deterministicComparison =
      env().SPEC_ANALYSIS_MODE === "SHADOW"
        ? compareSpecifications(spec, generateBusinessTestSpec(context))
        : null;
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.findAttempt(
        tx,
        attempt.stage.taskExecution.teamId,
        attempt.id,
      );
      this.requireLease(locked, {
        fencingToken: attempt.fencingToken.toString(),
        leaseToken: attempt.leaseToken!,
        workerId: attempt.leaseOwner!,
      });
      requireActiveTask(locked.stage.taskExecution, now);
      const snapshot = await tx.taskSpecificationSnapshot.create({
        data: {
          completeness,
          context: json(context),
          diagnostics: json(context.resolution.diagnostics),
          generatorKind: "AGENT",
          generatorVersion: "agent-spec-v2",
          primaryPullRequestUrl: primaryPullRequest?.url ?? null,
          sourceHash,
          stageAttemptId: attempt.id,
          summary: spec.summary,
          taskExecutionId: attempt.stage.taskExecutionId,
          cases: {
            create: spec.cases.map((definition, position) => ({
              definition: json({
                ...definition,
                schemaVersion: "agent-spec-v2",
              }),
              definitionHash: specificationDefinitionHash(definition),
              name: definition.name,
              position,
            })),
          },
        },
        include: { cases: true },
      });
      await tx.taskCaseExecution.createMany({
        data: snapshot.cases.map((testCase) => ({
          caseId: testCase.id,
          executionOrdinal: 1,
          taskExecutionId: attempt.stage.taskExecutionId,
        })),
      });
      const result = {
        attemptNumber: attempt.number,
        caseCount: spec.cases.length,
        completionId,
        completeness,
        nextAttemptScheduled: false,
        snapshotId: snapshot.id,
        sourceHash,
        stageStatus: "SUCCEEDED",
      };
      await tx.taskStageAttempt.update({
        data: {
          finishedAt: now,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          result: json(result),
          status: "SUCCEEDED",
        },
        where: { id: attempt.id },
      });
      await tx.taskExecutionStage.update({
        data: {
          finishedAt: now,
          lastError: Prisma.JsonNull,
          status: "SUCCEEDED",
        },
        where: { id: attempt.stageId },
      });
      await tx.taskExecutionStage.updateMany({
        data: { startedAt: now, status: "PENDING", waitingReason: null },
        where: {
          taskExecutionId: attempt.stage.taskExecutionId,
          type: "PROFILE_RESOLUTION",
        },
      });
      const previousEnvironment = record(
        attempt.stage.taskExecution.environmentSnapshot,
      );
      await tx.taskExecution.update({
        data: {
          currentStage: "PROFILE_RESOLUTION",
          environmentSnapshot: json({
            ...previousEnvironment,
            ...(target
              ? {
                  allowedHosts: [target.hostname],
                  targetSource: createInput.targetUrl ? "MANUAL" : "GITHUB",
                  targetUrl: normalizedTarget,
                }
              : {}),
            specificationSnapshotId: snapshot.id,
          }),
          lifecycle: "RUNNING",
          projectionNeededAt: null,
          sourceRef: context.issue.identifier,
          title: `${context.issue.identifier} · ${context.issue.title}`,
          waitingReason: null,
        },
        where: { id: attempt.stage.taskExecutionId },
      });
      await tx.taskExecutionEvent.createMany({
        data: [
          taskEvent(
            attempt.stage.taskExecution.teamId,
            attempt.stage.taskExecutionId,
            "AGENT_RUNTIME",
            "task.stage.succeeded",
            {
              attemptNumber: attempt.number,
              caseCount: spec.cases.length,
              snapshotId: snapshot.id,
              stage: "SPEC_ANALYSIS",
              stageAttemptId: attempt.id,
            },
          ),
          taskEvent(
            attempt.stage.taskExecution.teamId,
            attempt.stage.taskExecutionId,
            "CONTROL_PLANE",
            "task.stage.started",
            { stage: "PROFILE_RESOLUTION" },
          ),
          ...(deterministicComparison
            ? [
                taskEvent(
                  attempt.stage.taskExecution.teamId,
                  attempt.stage.taskExecutionId,
                  "CONTROL_PLANE",
                  "task.spec.shadow_compared",
                  deterministicComparison,
                ),
              ]
            : []),
        ],
      });
      return {
        accepted: true,
        attemptNumber: attempt.number,
        nextAttemptScheduled: false,
        stageStatus: "SUCCEEDED" as const,
      };
    });
  }

  private async persistFailure(
    attempt: Awaited<ReturnType<SpecAnalysisRuntimeService["loadedAttempt"]>>,
    completionId: string,
    outcome: Exclude<RuntimeSpecAnalysisOutcome, { kind: "SPEC_GENERATED" }>,
  ) {
    const retry =
      outcome.kind === "RETRYABLE_FAILURE" &&
      attempt.number < attempt.stage.maxAttempts;
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.findAttempt(
        tx,
        attempt.stage.taskExecution.teamId,
        attempt.id,
      );
      this.requireLease(locked, {
        fencingToken: attempt.fencingToken.toString(),
        leaseToken: attempt.leaseToken!,
        workerId: attempt.leaseOwner!,
      });
      requireActiveTask(locked.stage.taskExecution, now);
      const result = {
        attemptNumber: attempt.number,
        completionId,
        nextAttemptScheduled: retry,
        outcome,
        stageStatus: retry ? "PENDING" : "FAILED",
      };
      await tx.taskStageAttempt.update({
        data: {
          error: json(outcome.error),
          finishedAt: now,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          result: json(result),
          status: "FAILED",
        },
        where: { id: attempt.id },
      });
      if (retry) {
        const nextAttempt = attempt.number + 1;
        await tx.taskStageAttempt.create({
          data: {
            inputSnapshot: attempt.inputSnapshot as Prisma.InputJsonValue,
            number: nextAttempt,
            stageId: attempt.stageId,
          },
        });
        await tx.taskExecutionStage.update({
          data: {
            currentAttemptNumber: nextAttempt,
            lastError: json(outcome.error),
            status: "PENDING",
          },
          where: { id: attempt.stageId },
        });
        await tx.taskExecution.update({
          data: { lifecycle: "QUEUED", projectionNeededAt: now },
          where: { id: attempt.stage.taskExecutionId },
        });
        await tx.taskExecutionEvent.create({
          data: taskEvent(
            attempt.stage.taskExecution.teamId,
            attempt.stage.taskExecutionId,
            "AGENT_RUNTIME",
            "task.stage.retry_queued",
            {
              attemptNumber: nextAttempt,
              error: outcome.error,
              stage: "SPEC_ANALYSIS",
              stageAttemptId: attempt.id,
            },
          ),
        });
        return {
          accepted: true,
          attemptNumber: attempt.number,
          nextAttemptScheduled: true,
          stageStatus: "PENDING" as const,
        };
      }
      await tx.taskExecutionStage.update({
        data: {
          finishedAt: now,
          lastError: json(outcome.error),
          status: "FAILED",
        },
        where: { id: attempt.stageId },
      });
      await tx.taskExecutionStage.updateMany({
        data: { finishedAt: now, status: "CANCELLED" },
        where: {
          taskExecutionId: attempt.stage.taskExecutionId,
          type: { in: ["PROFILE_RESOLUTION", "SPEC_EXECUTION"] },
        },
      });
      await tx.taskExecution.update({
        data: {
          executionDisposition: "NOT_RUN",
          finishedAt: now,
          lifecycle: "COMPLETED",
          projectionNeededAt: null,
        },
        where: { id: attempt.stage.taskExecutionId },
      });
      await tx.taskExecutionEvent.create({
        data: taskEvent(
          attempt.stage.taskExecution.teamId,
          attempt.stage.taskExecutionId,
          "AGENT_RUNTIME",
          "task.stage.failed",
          {
            attemptNumber: attempt.number,
            error: outcome.error,
            stage: "SPEC_ANALYSIS",
            stageAttemptId: attempt.id,
          },
        ),
      });
      return {
        accepted: true,
        attemptNumber: attempt.number,
        nextAttemptScheduled: false,
        stageStatus: "FAILED" as const,
      };
    });
  }

  private loadedAttempt() {
    return this.prisma.taskStageAttempt.findFirstOrThrow({
      include: {
        analysisSources: true,
        stage: { include: { taskExecution: true } },
      },
    });
  }

  private async persistSource(
    attempt: {
      id: string;
      stage: { taskExecution: { id: string; teamId: string } };
    },
    input: Omit<RuntimeSpecSourceRef, "contentHash" | "externalId"> & {
      content: unknown;
    },
  ) {
    const externalId = `analysis-source://${attempt.id}/${randomUUID()}`;
    const serialized = canonicalJson(input.content);
    const byteSize = Buffer.byteLength(serialized);
    if (byteSize > MAX_SINGLE_SOURCE_BYTES) {
      throw new BadRequestException(
        `Analysis source exceeds the ${MAX_SINGLE_SOURCE_BYTES} byte per-source limit.`,
      );
    }
    const usage = await this.prisma.taskAnalysisSource.aggregate({
      _count: { _all: true },
      _sum: { byteSize: true },
      where: { stageAttemptId: attempt.id },
    });
    if (
      usage._count._all >= MAX_SOURCE_COUNT ||
      (usage._sum.byteSize ?? 0) + byteSize > MAX_SOURCE_BYTES
    ) {
      throw new BadRequestException(
        "Spec analysis source budget is exhausted; synthesize the Spec from the sources already collected.",
      );
    }
    const contentHash = createHash("sha256").update(serialized).digest("hex");
    const sourceRef = runtimeSpecSourceRefSchema.parse({
      contentHash,
      excerpt: input.excerpt,
      externalId,
      kind: input.kind,
      label: input.label,
      locator: input.locator,
      revision: input.revision,
      uri: input.uri,
    });
    await this.prisma.taskAnalysisSource.create({
      data: {
        byteSize,
        content: json(input.content),
        contentHash,
        externalId,
        kind: input.kind,
        label: input.label,
        locator: json(input.locator),
        revision: input.revision,
        stageAttemptId: attempt.id,
        taskExecutionId: attempt.stage.taskExecution.id,
        teamId: attempt.stage.taskExecution.teamId,
        uri: input.uri,
      },
    });
    return sourceRef;
  }

  private async persistSources(
    attempt: Parameters<SpecAnalysisRuntimeService["persistSource"]>[0],
    inputs: Array<Parameters<SpecAnalysisRuntimeService["persistSource"]>[1]>,
  ) {
    const sources: RuntimeSpecSourceRef[] = [];
    for (const input of inputs) {
      sources.push(await this.persistSource(attempt, input));
    }
    return sources;
  }

  private requireIssueSource(stageAttemptId: string) {
    return this.prisma.taskAnalysisSource.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
      where: { kind: "LINEAR_ISSUE", stageAttemptId },
    });
  }

  private findAttempt(
    tx: Prisma.TransactionClient,
    teamId: string,
    attemptId: string,
  ) {
    return tx.taskStageAttempt
      .findUniqueOrThrow({
        include: { stage: { include: { taskExecution: true } } },
        where: { id: attemptId },
      })
      .then((attempt) => {
        if (attempt.stage.taskExecution.teamId !== teamId) {
          throw new NotFoundException("Spec analysis attempt was not found.");
        }
        return attempt;
      });
  }

  private requireLease(
    attempt: {
      fencingToken: bigint;
      leaseExpiresAt: Date | null;
      leaseOwner: string | null;
      leaseToken: string | null;
    },
    input: LeaseInput,
  ) {
    if (
      attempt.leaseToken !== input.leaseToken ||
      attempt.leaseOwner !== input.workerId ||
      attempt.fencingToken.toString() !== input.fencingToken ||
      !attempt.leaseExpiresAt ||
      attempt.leaseExpiresAt <= new Date()
    ) {
      throw new ConflictException("The Spec analysis lease is stale.");
    }
  }
}

function leaseExpiry(now: Date) {
  return new Date(
    now.getTime() + env().AGENT_RUNTIME_TASK_LEASE_SECONDS * 1_000,
  );
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sourceContent(value: Prisma.JsonValue) {
  return value as unknown;
}

function hashJson(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalValue));
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function requireAllowedPullRequest(url: string, allowed: ReadonlySet<string>) {
  if (!allowed.has(url)) {
    throw new BadRequestException(
      "GitHub tools may read only pull requests linked from the Linear Issue.",
    );
  }
}

function requireActiveTask(
  task: {
    cancelRequestedAt: Date | null;
    deadlineAt: Date;
    lifecycle: string;
  },
  now: Date,
) {
  if (
    task.cancelRequestedAt ||
    task.deadlineAt <= now ||
    ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(task.lifecycle)
  ) {
    throw new ConflictException("The Task no longer accepts Spec outcomes.");
  }
}

function buildContext(
  sources: Array<{ content: Prisma.JsonValue; kind: string }>,
) {
  const issueSource = [...sources]
    .reverse()
    .find((source) => source.kind === "LINEAR_ISSUE");
  if (!issueSource)
    throw new BadRequestException(
      "Spec analysis did not read the Linear Issue.",
    );
  const issuePayload = record(sourceContent(issueSource.content));
  const issue = issuePayload.issue;
  const pullRequests = sources
    .filter((source) => source.kind === "GITHUB_PULL_REQUEST")
    .map((source) => record(sourceContent(source.content)).pullRequest)
    .filter(Boolean);
  const knowledge = sources
    .filter((source) => source.kind === "KNOWLEDGE")
    .map((source) => record(sourceContent(source.content)).item)
    .filter(Boolean);
  const expectedPullRequests = z
    .array(z.string().url())
    .parse(issuePayload.pullRequestUrls ?? []);
  const resolvedUrls = new Set(
    pullRequests
      .map((value) => record(value).url)
      .filter((value): value is string => typeof value === "string"),
  );
  const diagnostics = expectedPullRequests
    .filter((url) => !resolvedUrls.has(url))
    .map((url) => ({
      code: "GITHUB_PR_NOT_ANALYZED",
      level: "WARNING" as const,
      message:
        "Agent did not load this linked pull request before generating the Spec.",
      reference: url,
      source: "GITHUB" as const,
    }));
  return testGenerationContextSchema.parse({
    issue,
    knowledge,
    pullRequests,
    resolution: {
      completeness: diagnostics.length ? "PARTIAL" : "COMPLETE",
      diagnostics,
    },
  });
}

function specSourceIds(spec: z.infer<typeof runtimeGeneratedSpecSchema>) {
  return Array.from(
    new Set(
      spec.cases.flatMap((testCase) => [
        ...testCase.sourceRefs,
        ...testCase.criteria.flatMap((criterion) => criterion.sourceRefs),
      ]),
    ),
  );
}

function normalizeTargetUrl(value: string) {
  const target = new URL(value);
  target.hash = "";
  target.username = "";
  target.password = "";
  return target.toString();
}

function taskEvent(
  teamId: string,
  taskExecutionId: string,
  actor: string,
  kind: string,
  payload: Record<string, unknown>,
): Prisma.TaskExecutionEventUncheckedCreateInput {
  return {
    actor,
    kind,
    payload: json(payload),
    taskExecutionId,
    teamId,
  };
}

function uniqueConstraint(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function acknowledgedOutcome(
  value: Prisma.JsonValue | null,
  completionId: string,
) {
  const result = record(value);
  if (result.completionId !== completionId) return null;
  const nextAttemptScheduled = Boolean(result.nextAttemptScheduled);
  const stageStatus =
    result.stageStatus === "FAILED" || result.stageStatus === "PENDING"
      ? result.stageStatus
      : "SUCCEEDED";
  return {
    accepted: true,
    attemptNumber:
      typeof result.attemptNumber === "number" ? result.attemptNumber : 1,
    nextAttemptScheduled,
    stageStatus,
  };
}

function compareSpecifications(
  agent: z.infer<typeof runtimeGeneratedSpecSchema>,
  deterministic: { cases: Array<{ name: string }>; summary: string },
) {
  const deterministicNames = new Set(
    deterministic.cases.map((testCase) => testCase.name.toLocaleLowerCase()),
  );
  const overlappingNames = agent.cases.filter((testCase) =>
    deterministicNames.has(testCase.name.toLocaleLowerCase()),
  ).length;
  return {
    agentCaseCount: agent.cases.length,
    deterministicCaseCount: deterministic.cases.length,
    overlappingNames,
    stage: "SPEC_ANALYSIS",
  };
}
