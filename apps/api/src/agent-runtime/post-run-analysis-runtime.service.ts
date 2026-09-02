import { createHash, randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  runtimePostRunAnalysisCheckpointSchema,
  runtimePostRunAnalysisOutcomeSchema,
  runtimePostRunAnalysisReportSchema,
  type RuntimePostRunAnalysisOutcome,
  type RuntimePostRunAnalysisTaskOutcomeInput,
  type RuntimePostRunAnalysisToolInput,
} from "@devproof/agent-runtime-protocol";

import { AgentModelConfigurationService } from "../console/agent-model-configuration.service.js";
import { env } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import { redactText } from "../observability/observability.service.js";
import { findingFingerprint } from "../post-run-analysis/post-run-analysis.service.js";
import {
  postRunAnalysisAttemptDeadline,
  postRunAnalysisRetryAt,
} from "../post-run-analysis/post-run-analysis-scheduling.js";
import {
  POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD,
  POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD,
  sanitizeLogBundleValue,
  type StructuredEvidenceIndexEntry,
} from "../post-run-analysis/task-log-bundle.service.js";

const POST_RUN_ANALYSIS_PROTOCOL_MINOR = 9;
const INLINE_MANIFEST_MAX_BYTES = 64_000;
const CHUNK_SOURCE_CACHE_MAX_BYTES = 64 * 1_024 * 1_024;
const CHUNK_SOURCE_CACHE_TTL_MS = 5 * 60 * 1_000;

type CachedChunkSource = {
  body: Buffer;
  contentType: string;
  expiresAt: number;
  sha256: string;
};

type LeaseInput = {
  fencingToken: string;
  leaseToken: string;
  workerId: string;
};

type FindingRuntimeLocation = {
  attemptNumber: number | null;
  evidenceRefs: string[];
  runId: string | null;
  runtimeId: string | null;
  title: string;
};

type PostRunAnalysisOutcomeJob = Omit<
  Prisma.PostRunAnalysisJobGetPayload<Record<string, never>>,
  "inputManifest"
>;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

@Injectable()
export class PostRunAnalysisRuntimeService {
  private readonly chunkSourceCache = new Map<string, CachedChunkSource>();
  private chunkSourceCacheBytes = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly models: AgentModelConfigurationService,
    private readonly storage: ObjectStorageService,
  ) {}

  async claim(
    teamId: string,
    input: { protocol: { minor: number }; workerId: string },
  ) {
    if (!env().POST_RUN_ANALYSIS_ENABLED) return { task: null };
    if (input.protocol.minor < POST_RUN_ANALYSIS_PROTOCOL_MINOR) {
      throw new BadRequestException(
        `Agent Runtime protocol minor ${POST_RUN_ANALYSIS_PROTOCOL_MINOR} or newer is required for post-run analysis.`,
      );
    }
    const modelCandidates = await this.models.candidatesForPool(
      teamId,
      "POST_RUN_ANALYSIS",
    );

    for (let collision = 0; collision < 5; collision += 1) {
      const claimed = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const candidate = await tx.postRunAnalysisJob.findFirst({
          orderBy: [
            { attemptNumber: "asc" },
            { readyAt: "asc" },
            { createdAt: "asc" },
          ],
          select: {
            hardDeadlineAt: true,
            id: true,
            leaseExpiresAt: true,
            readyAt: true,
            startedAt: true,
            status: true,
          },
          where: {
            attemptNumber: {
              lt: tx.postRunAnalysisJob.fields.maxAttempts,
            },
            hardDeadlineAt: { gt: now },
            teamId,
            ...(modelCandidates.length
              ? {}
              : {
                  AND: [
                    {
                      inputManifest: {
                        equals: true,
                        path: ["analysisSynopsis", "cleanPass"],
                      },
                    },
                    {
                      inputManifest: {
                        equals: true,
                        path: ["analysisSynopsis", "completenessSufficient"],
                      },
                    },
                  ],
                }),
            OR: [
              {
                status: "READY",
                OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
              },
              {
                deadlineAt: { gt: now },
                leaseExpiresAt: { lt: now },
                status: "RUNNING",
              },
            ],
          },
        });
        if (!candidate) return null;
        const leaseToken = randomUUID();
        const leaseExpiresAt = leaseExpiry(now);
        const deadlineAt = postRunAnalysisAttemptDeadline(
          candidate.hardDeadlineAt,
          now,
        );
        const acquired = await tx.postRunAnalysisJob.updateMany({
          data: {
            attemptNumber: { increment: 1 },
            deadlineAt,
            error: Prisma.JsonNull,
            fencingToken: { increment: 1 },
            leaseExpiresAt,
            leaseOwner: input.workerId,
            leaseToken,
            nextAttemptAt: null,
            startedAt: candidate.startedAt ?? now,
            status: "RUNNING",
          },
          where: {
            attemptNumber: {
              lt: tx.postRunAnalysisJob.fields.maxAttempts,
            },
            hardDeadlineAt: { gt: now },
            id: candidate.id,
            OR: [
              {
                status: "READY",
                OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
              },
              {
                deadlineAt: { gt: now },
                leaseExpiresAt: { lt: now },
                status: "RUNNING",
              },
            ],
          },
        });
        if (acquired.count !== 1) return undefined;
        const job = await tx.postRunAnalysisJob.findUniqueOrThrow({
          select: {
            analysisCheckpoint: true,
            analyzerVersion: true,
            attemptNumber: true,
            deadlineAt: true,
            fencingToken: true,
            hardDeadlineAt: true,
            id: true,
            inputByteSize: true,
            inputCompleteness: true,
            inputSha256: true,
            inputStorageKey: true,
            leaseExpiresAt: true,
            leaseToken: true,
            taskExecution: {
              select: { sourceRef: true, title: true, traceId: true },
            },
            taskExecutionId: true,
          },
          where: { id: candidate.id },
        });
        await tx.postRunAnalysisEvent.createMany({
          data: [
            ...(candidate.status === "RUNNING" && candidate.leaseExpiresAt
              ? [
                  {
                    actor: "CONTROL_PLANE" as const,
                    analysisId: job.id,
                    kind: "analysis.lease_recovered",
                    payload: json({
                      attemptNumber: job.attemptNumber - 1,
                      previousLeaseExpiredAt:
                        candidate.leaseExpiresAt.toISOString(),
                    }),
                    teamId,
                  },
                ]
              : []),
            {
              actor: "AGENT_RUNTIME",
              analysisId: job.id,
              kind: "analysis.started",
              payload: json({
                attemptNumber: job.attemptNumber,
                deadlineAt: job.deadlineAt.toISOString(),
                hardDeadlineAt: job.hardDeadlineAt.toISOString(),
                queueWaitMs:
                  candidate.status === "READY" && candidate.readyAt
                    ? Math.max(0, now.getTime() - candidate.readyAt.getTime())
                    : null,
              }),
              teamId,
            },
          ],
        });
        return job;
      });
      if (claimed === undefined) continue;
      if (claimed === null) {
        if (!modelCandidates.length) await this.failUnconfiguredJob(teamId);
        return { task: null };
      }
      if (
        !claimed.inputStorageKey ||
        !claimed.inputSha256 ||
        claimed.inputByteSize === null
      ) {
        throw new ConflictException(
          "The analysis input bundle is unavailable.",
        );
      }
      const inlineManifest = await this.inlineManifestForJob(
        teamId,
        claimed.id,
      );
      return {
        task: {
          fencingToken: claimed.fencingToken.toString(),
          leaseExpiresAt: claimed.leaseExpiresAt!.toISOString(),
          leaseToken: claimed.leaseToken!,
          snapshot: {
            analysisId: claimed.id,
            analyzerVersion: claimed.analyzerVersion,
            attemptNumber: claimed.attemptNumber,
            checkpoint: runtimePostRunAnalysisCheckpointSchema.parse(
              claimed.analysisCheckpoint ?? {},
            ),
            deadlineAt: claimed.deadlineAt.toISOString(),
            input: {
              byteSize: claimed.inputByteSize,
              completeness: record(claimed.inputCompleteness),
              manifest: inlineManifest,
              schemaVersion: "devproof.task-logs.v2" as const,
              sha256: claimed.inputSha256,
            },
            modelCandidates,
            sourceRef: claimed.taskExecution.sourceRef,
            taskExecutionId: claimed.taskExecutionId,
            teamId,
            title: claimed.taskExecution.title,
            traceId: claimed.taskExecution.traceId,
          },
          taskId: claimed.id,
        },
      };
    }
    return { task: null };
  }

  async heartbeat(teamId: string, id: string, input: LeaseInput) {
    return this.prisma.$transaction(async (tx) => {
      const job = await this.findJob(tx, teamId, id);
      this.requireLease(job, input);
      const now = new Date();
      if (job.deadlineAt <= now || job.status === "CANCELLED") {
        return {
          deadlineAt: job.deadlineAt.toISOString(),
          directive: "CANCEL" as const,
          leaseExpiresAt: (job.leaseExpiresAt ?? now).toISOString(),
        };
      }
      if (job.status !== "RUNNING") {
        throw new ConflictException("The post-run analysis job is terminal.");
      }
      const leaseExpiresAt = leaseExpiry(now);
      const renewed = await tx.postRunAnalysisJob.updateMany({
        data: { leaseExpiresAt },
        where: {
          fencingToken: job.fencingToken,
          id,
          leaseExpiresAt: { gt: now },
          leaseOwner: input.workerId,
          leaseToken: input.leaseToken,
          status: "RUNNING",
          teamId,
        },
      });
      if (renewed.count !== 1) {
        throw new ConflictException("The post-run analysis lease is stale.");
      }
      return {
        deadlineAt: job.deadlineAt.toISOString(),
        directive: "CONTINUE" as const,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      };
    });
  }

  async appendEvent(
    teamId: string,
    id: string,
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
      const job = await this.findJob(tx, teamId, id);
      this.requireLease(job, input);
      if (job.status !== "RUNNING") {
        throw new ConflictException("The post-run analysis job is terminal.");
      }
      await tx.postRunAnalysisEvent.createMany({
        data: [
          {
            actor: "AGENT_RUNTIME",
            analysisId: id,
            id: input.event.eventId,
            kind: input.event.kind,
            occurredAt: new Date(input.event.occurredAt),
            payload: json(sanitizeLogBundleValue(input.event.payload)),
            teamId,
          },
        ],
        skipDuplicates: true,
      });
      return { accepted: true };
    });
  }

  async executeTool(
    teamId: string,
    id: string,
    input: RuntimePostRunAnalysisToolInput,
  ) {
    const job = await this.prisma.postRunAnalysisJob.findFirst({
      select: {
        analysisCheckpoint: true,
        fencingToken: true,
        inputByteSize: true,
        inputSha256: true,
        inputStorageKey: true,
        leaseExpiresAt: true,
        leaseOwner: true,
        leaseToken: true,
        status: true,
        taskExecutionId: true,
      },
      where: { id, teamId },
    });
    if (!job)
      throw new NotFoundException("Post-run analysis job was not found.");
    this.requireLease(job, input);
    if (job.status !== "RUNNING" || !job.inputStorageKey || !job.inputSha256) {
      throw new ConflictException("The analysis bundle is not readable.");
    }
    if (input.name === "read_analysis_manifest") {
      const inputManifest = await this.inputManifestForJob(
        teamId,
        id,
        embeddedInputManifest(job),
      );
      const source = await this.cachedChunkSource(
        `manifest:${id}:${job.fencingToken.toString()}`,
        async () => ({
          body: Buffer.from(
            JSON.stringify(publicAnalysisManifest(inputManifest)),
          ),
          contentType: "application/vnd.devproof.execution-manifest+json",
        }),
      );
      const output = await this.readObjectChunk({
        body: source.body,
        contentType: source.contentType,
        cursor: input.cursor,
        maxBytes: input.maxBytes,
        sha256: source.sha256,
        storageKey: job.inputStorageKey,
        totalBytes: source.body.byteLength,
      });
      await this.saveAnalysisCheckpoint(teamId, id, job, input, output);
      return output;
    }
    if (input.name === "read_analysis_evidence") {
      const structuredEvidence = await this.structuredEvidenceForJob(
        teamId,
        id,
        input.evidenceRef,
        embeddedInputManifest(job),
      );
      if (!structuredEvidence) {
        throw new NotFoundException(
          `Evidence ${input.evidenceRef} is not present in the execution manifest.`,
        );
      }
      const evidence = await this.prisma.runEvidence.findFirst({
        include: { runtimeArtifact: true },
        where: {
          externalId: input.evidenceRef,
          run: { taskExecutionId: job.taskExecutionId },
          teamId,
        },
      });
      if (
        evidence?.runtimeArtifact &&
        isTextualContentType(evidence.runtimeArtifact.contentType)
      ) {
        const source = await this.cachedChunkSource(
          `artifact:${evidence.runtimeArtifact.storageKey}:${evidence.runtimeArtifact.sha256}`,
          async () => {
            const stored = await this.storage.get(
              evidence.runtimeArtifact!.storageKey,
            );
            return {
              body: redactArtifactBody(
                stored.body,
                evidence.runtimeArtifact!.contentType,
              ),
              contentType: evidence.runtimeArtifact!.contentType,
            };
          },
        );
        const output = await this.readObjectChunk({
          body: source.body,
          contentType: source.contentType,
          cursor: input.cursor,
          evidenceRef: input.evidenceRef,
          maxBytes: input.maxBytes,
          sha256: source.sha256,
          storageKey: evidence.runtimeArtifact.storageKey,
          totalBytes: source.body.byteLength,
        });
        await this.recordEvidenceRead(
          teamId,
          id,
          job.fencingToken,
          input,
          output,
        );
        await this.saveAnalysisCheckpoint(teamId, id, job, input, output);
        return output;
      }

      const output = await this.readObjectChunk({
        contentType: "application/vnd.devproof.evidence+json",
        cursor: input.cursor,
        evidenceRef: input.evidenceRef,
        maxBytes: input.maxBytes,
        sha256: structuredEvidence.entry.sha256,
        storageKey: structuredEvidence.storageKey,
        storageOffset: structuredEvidence.entry.offset,
        totalBytes: structuredEvidence.entry.byteSize,
      });
      await this.recordEvidenceRead(
        teamId,
        id,
        job.fencingToken,
        input,
        output,
      );
      await this.saveAnalysisCheckpoint(teamId, id, job, input, output);
      return output;
    }
    const output = await this.readObjectChunk({
      contentType: "application/json",
      cursor: input.cursor,
      maxBytes: input.maxBytes,
      sha256: job.inputSha256,
      storageKey: job.inputStorageKey,
      totalBytes: job.inputByteSize ?? 0,
    });
    await this.saveAnalysisCheckpoint(teamId, id, job, input, output);
    return output;
  }

  private async saveAnalysisCheckpoint(
    teamId: string,
    analysisId: string,
    job: {
      analysisCheckpoint: unknown;
      fencingToken: bigint;
      leaseOwner: string | null;
      leaseToken: string | null;
    },
    input: RuntimePostRunAnalysisToolInput,
    _output: { nextCursor: number | null; totalBytes: number },
  ) {
    const current = runtimePostRunAnalysisCheckpointSchema.parse(
      job.analysisCheckpoint ?? {},
    );
    const sanitizedSummary = sanitizeLogBundleValue(input.analysisSummary);
    const checkpoint = runtimePostRunAnalysisCheckpointSchema.parse({
      ...current,
      analysisSummary:
        typeof sanitizedSummary === "string"
          ? sanitizedSummary
          : "分析断点摘要已被安全过滤。",
      ...(input.name === "read_analysis_bundle"
        ? {
            // The summary was produced before this chunk was returned. Persist
            // the requested cursor as the last acknowledged position so a
            // connection loss can at worst replay one chunk, never skip one.
            bundleComplete: false,
            bundleCursor: Math.max(current.bundleCursor, input.cursor),
          }
        : {}),
      evidenceRefs:
        input.name === "read_analysis_evidence"
          ? [...current.evidenceRefs, input.evidenceRef]
          : current.evidenceRefs,
      updatedAt: new Date().toISOString(),
    });
    const now = new Date();
    const saved = await this.prisma.postRunAnalysisJob.updateMany({
      data: { analysisCheckpoint: json(checkpoint) },
      where: {
        fencingToken: job.fencingToken,
        id: analysisId,
        leaseExpiresAt: { gt: now },
        leaseOwner: job.leaseOwner,
        leaseToken: job.leaseToken,
        status: "RUNNING",
        teamId,
      },
    });
    if (saved.count !== 1) {
      throw new ConflictException("The post-run analysis lease is stale.");
    }
    job.analysisCheckpoint = checkpoint;
  }

  private async inputManifestForJob(
    teamId: string,
    analysisId: string,
    embedded: Record<string, unknown> | null,
  ) {
    if (embedded) return publicAnalysisManifest(embedded);
    const rows = await this.prisma.$queryRaw<
      Array<{ manifest: Prisma.JsonValue | null }>
    >(Prisma.sql`
      SELECT
        "input_manifest"
          - ${POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD}
          - ${POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD} AS "manifest"
      FROM "post_run_analysis_jobs"
      WHERE "id" = ${analysisId}::uuid
        AND "team_id" = ${teamId}::uuid
      LIMIT 1
    `);
    if (!rows[0]) {
      throw new NotFoundException("Post-run analysis job was not found.");
    }
    return record(rows[0].manifest);
  }

  private async inlineManifestForJob(teamId: string, analysisId: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{ manifest: Prisma.JsonValue | null }>
    >(Prisma.sql`
      WITH source AS (
        SELECT
          "input_manifest"
            - ${POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD}
            - ${POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD} AS "publicManifest"
        FROM "post_run_analysis_jobs"
        WHERE "id" = ${analysisId}::uuid
          AND "team_id" = ${teamId}::uuid
        LIMIT 1
      )
      SELECT
        CASE
          WHEN octet_length("publicManifest"::text) <= ${INLINE_MANIFEST_MAX_BYTES}
            THEN "publicManifest"
          ELSE jsonb_build_object(
            'analysisSynopsis', "publicManifest" -> 'analysisSynopsis',
            'eventCounts', "publicManifest" -> 'eventCounts',
            'evidenceLocationCount', COALESCE(jsonb_array_length("publicManifest" -> 'evidenceLocations'), 0),
            'evidenceRefCount', COALESCE(jsonb_array_length("publicManifest" -> 'evidenceRefs'), 0),
            'manifestByteSize', octet_length("publicManifest"::text),
            'runCount', COALESCE(jsonb_array_length("publicManifest" -> 'runs'), 0),
            'schemaVersion', "publicManifest" -> 'schemaVersion',
            'stageCount', COALESCE(jsonb_array_length("publicManifest" -> 'stages'), 0),
            'task', "publicManifest" -> 'task',
            'truncated', true
          )
        END AS "manifest"
      FROM source
    `);
    if (!rows[0]) {
      throw new NotFoundException("Post-run analysis job was not found.");
    }
    return compactInlineManifest(record(rows[0].manifest));
  }

  private async structuredEvidenceForJob(
    teamId: string,
    analysisId: string,
    evidenceRef: string,
    embedded: Record<string, unknown> | null,
  ) {
    if (embedded) return structuredEvidenceSource(embedded, evidenceRef);
    const rows = await this.prisma.$queryRaw<
      Array<{ entry: Prisma.JsonValue | null; storageKey: string | null }>
    >(Prisma.sql`
      SELECT
        "input_manifest" -> ${POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD} -> ${evidenceRef} AS "entry",
        "input_manifest" ->> ${POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD} AS "storageKey"
      FROM "post_run_analysis_jobs"
      WHERE "id" = ${analysisId}::uuid
        AND "team_id" = ${teamId}::uuid
      LIMIT 1
    `);
    return structuredEvidenceRow(rows[0]);
  }

  private async readObjectChunk(input: {
    body?: Buffer;
    contentType: string;
    cursor: number;
    evidenceRef?: string;
    maxBytes: number;
    sha256: string;
    storageKey: string;
    storageOffset?: number;
    totalBytes: number;
  }) {
    if (input.totalBytes === 0 && input.cursor === 0) {
      return {
        body: "",
        contentType: input.contentType,
        ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
        nextCursor: null,
        sha256: input.sha256,
        totalBytes: 0,
        truncated: false,
      };
    }
    if (input.cursor >= input.totalBytes) {
      throw new ConflictException("Artifact cursor is past the end.");
    }
    const requestedEnd = Math.min(
      input.totalBytes - 1,
      input.cursor + input.maxBytes + 3,
    );
    const body = input.body
      ? input.body.subarray(input.cursor, requestedEnd + 1)
      : (
          await this.storage.get(input.storageKey, {
            end: (input.storageOffset ?? 0) + requestedEnd,
            start: (input.storageOffset ?? 0) + input.cursor,
          })
        ).body;
    const leadingTrim = utf8ContinuationPrefixLength(body);
    const readableBody = body.subarray(leadingTrim);
    const finalChunk = requestedEnd === input.totalBytes - 1;
    const chunk = finalChunk ? readableBody : validUtf8Prefix(readableBody);
    const nextCursor = input.cursor + leadingTrim + chunk.byteLength;
    return {
      body: chunk.toString("utf8"),
      contentType: input.contentType,
      ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
      nextCursor: nextCursor < input.totalBytes ? nextCursor : null,
      sha256: input.sha256,
      totalBytes: input.totalBytes,
      truncated: nextCursor < input.totalBytes,
    };
  }

  private async cachedChunkSource(
    key: string,
    load: () => Promise<{ body: Buffer; contentType: string }>,
  ) {
    const now = Date.now();
    this.pruneChunkSourceCache(now);
    const cached = this.chunkSourceCache.get(key);
    if (cached) {
      cached.expiresAt = now + CHUNK_SOURCE_CACHE_TTL_MS;
      this.chunkSourceCache.delete(key);
      this.chunkSourceCache.set(key, cached);
      return cached;
    }
    const loaded = await load();
    const source: CachedChunkSource = {
      ...loaded,
      expiresAt: now + CHUNK_SOURCE_CACHE_TTL_MS,
      sha256: createHash("sha256").update(loaded.body).digest("hex"),
    };
    if (source.body.byteLength <= CHUNK_SOURCE_CACHE_MAX_BYTES) {
      this.chunkSourceCache.set(key, source);
      this.chunkSourceCacheBytes += source.body.byteLength;
      this.pruneChunkSourceCache(now);
    }
    return source;
  }

  private recordEvidenceRead(
    teamId: string,
    analysisId: string,
    fencingToken: bigint,
    input: { cursor: number; evidenceRef: string },
    output: { nextCursor: number | null; totalBytes: number },
  ) {
    return this.prisma.postRunAnalysisEvent.create({
      data: {
        actor: "CONTROL_PLANE",
        analysisId,
        kind: "analysis.evidence.served",
        payload: json({
          cursor: input.cursor,
          evidenceRef: input.evidenceRef,
          fencingToken: fencingToken.toString(),
          nextCursor: output.nextCursor,
          totalBytes: output.totalBytes,
        }),
        teamId,
      },
    });
  }

  private pruneChunkSourceCache(now: number) {
    for (const [key, source] of this.chunkSourceCache) {
      if (
        source.expiresAt > now &&
        this.chunkSourceCacheBytes <= CHUNK_SOURCE_CACHE_MAX_BYTES
      ) {
        continue;
      }
      this.chunkSourceCache.delete(key);
      this.chunkSourceCacheBytes -= source.body.byteLength;
    }
  }

  async submitOutcome(
    teamId: string,
    id: string,
    input: RuntimePostRunAnalysisTaskOutcomeInput,
  ) {
    const outcome = runtimePostRunAnalysisOutcomeSchema.parse(input.outcome);
    const existing = await this.prisma.postRunAnalysisJob.findFirst({
      include: {
        findings: {
          select: { workItemId: true },
          take: 1,
          where: { workItemId: { not: null } },
        },
        workItem: true,
      },
      omit: { inputManifest: true },
      where: { id, teamId },
    });
    if (!existing)
      throw new NotFoundException("Post-run analysis job was not found.");
    if (existing.completionId === input.completionId) {
      return {
        accepted: false,
        jobStatus: terminalOutputStatus(existing.status),
        nextAttemptScheduled: existing.status === "READY",
        workItemId:
          existing.workItem?.id ?? existing.findings[0]?.workItemId ?? null,
      };
    }
    this.requireLease(existing, input);
    if (existing.status !== "RUNNING") {
      throw new ConflictException("The post-run analysis job is terminal.");
    }
    if (outcome.kind === "ANALYSIS_COMPLETED") {
      return this.complete(
        teamId,
        existing,
        input.completionId,
        outcome.report,
      );
    }
    return this.fail(teamId, existing, input.completionId, outcome);
  }

  private async complete(
    teamId: string,
    job: PostRunAnalysisOutcomeJob,
    completionId: string,
    report: {
      findings: Array<{
        attemptNumber: number | null;
        category: string;
        component: string;
        confidence: number;
        evidenceRefs: string[];
        failureClass: string;
        impact: string;
        phase: string;
        recommendation: string;
        rootCause: string;
        runId: string | null;
        runtimeId: string | null;
        severity: string;
        title: string;
      }>;
      summary: string;
    },
  ) {
    const safeReport = runtimePostRunAnalysisReportSchema.parse(
      sanitizeLogBundleValue(report),
    );
    const validation = await this.completionValidationContext(
      teamId,
      job.id,
      safeReport.findings,
    );
    const evidenceRefs = manifestEvidenceRefs(validation.manifest);
    const candidateCount = validation.candidateCount;
    for (const finding of safeReport.findings) {
      const unknown = finding.evidenceRefs.filter(
        (ref) => !evidenceRefs.has(ref),
      );
      if (unknown.length) {
        throw new BadRequestException(
          `Analysis finding references unavailable evidence: ${unknown.join(", ")}.`,
        );
      }
    }
    validateFindingRuntimeLocations(safeReport.findings, validation.manifest);
    const normalized = safeReport.findings.map((finding) => ({
      ...finding,
      fingerprint: findingFingerprint(finding),
    }));
    const unique = Array.from(
      new Map(
        normalized.map((finding) => [finding.fingerprint, finding]),
      ).values(),
    );
    const actionable = unique.filter(
      (finding) => finding.confidence >= env().POST_RUN_ANALYSIS_MIN_CONFIDENCE,
    );
    const dedupeKey = createHash("sha256")
      .update(
        actionable
          .map((finding) => finding.fingerprint)
          .sort()
          .join("\n"),
      )
      .digest("hex");
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const citedEvidenceRefs = [
        ...new Set(
          safeReport.findings.flatMap((finding) => finding.evidenceRefs),
        ),
      ];
      if (citedEvidenceRefs.length || candidateCount > 0) {
        const servedEvents = await tx.postRunAnalysisEvent.findMany({
          select: { payload: true },
          where: {
            actor: "CONTROL_PLANE",
            analysisId: job.id,
            kind: "analysis.evidence.served",
          },
        });
        const servedEvidenceRefs = new Set(
          servedEvents.flatMap((event) => {
            const payload = record(event.payload);
            return payload.fencingToken === job.fencingToken.toString() &&
              typeof payload.evidenceRef === "string"
              ? [payload.evidenceRef]
              : [];
          }),
        );
        if (candidateCount > 0 && servedEvidenceRefs.size === 0) {
          throw new BadRequestException(
            "Analysis with anomaly candidates must read at least one evidence record during the active lease.",
          );
        }
        const unread = citedEvidenceRefs.filter(
          (evidenceRef) => !servedEvidenceRefs.has(evidenceRef),
        );
        if (unread.length) {
          throw new BadRequestException(
            `Analysis finding references evidence that was not read during the active lease: ${unread.join(", ")}.`,
          );
        }
      }
      const finalized = await tx.postRunAnalysisJob.updateMany({
        data: {
          analysisCheckpoint: json({}),
          completionId,
          error: Prisma.JsonNull,
          finishedAt: now,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          result: json(safeReport),
          status: "SUCCEEDED",
        },
        where: {
          fencingToken: job.fencingToken,
          id: job.id,
          leaseExpiresAt: { gt: now },
          leaseOwner: job.leaseOwner,
          leaseToken: job.leaseToken,
          status: "RUNNING",
          teamId,
        },
      });
      if (finalized.count !== 1) {
        throw new ConflictException("The post-run analysis lease is stale.");
      }
      await tx.analysisFinding.createMany({
        data: unique.map((finding) => ({
          analysisId: job.id,
          attemptNumber: finding.attemptNumber,
          category: finding.category,
          component: finding.component,
          confidence: finding.confidence,
          evidenceRefs: finding.evidenceRefs,
          failureClass: finding.failureClass,
          fingerprint: finding.fingerprint,
          impact: finding.impact,
          phase: finding.phase,
          recommendation: finding.recommendation,
          rootCause: finding.rootCause,
          runId: finding.runId,
          runtimeId: finding.runtimeId,
          severity: finding.severity,
          teamId,
          title: finding.title,
        })),
        skipDuplicates: true,
      });
      let workItem = null;
      if (actionable.length) {
        const task = await tx.taskExecution.findUniqueOrThrow({
          where: { id: job.taskExecutionId },
        });
        const body = workItemBody(task, safeReport.summary, actionable, job);
        const title = `[Auto Analysis][${task.sourceRef ?? task.id}] 发现 ${actionable.length} 个可优化问题`;
        workItem = await tx.improvementWorkItem.upsert({
          create: {
            analysisId: job.id,
            body,
            dedupeKey,
            findingCount: actionable.length,
            sourceTaskExecutionId: job.taskExecutionId,
            teamId,
            title,
          },
          update: {
            analysisId: job.id,
            body,
            findingCount: actionable.length,
            sourceTaskExecutionId: job.taskExecutionId,
            status: "OPEN",
            title,
          },
          where: { teamId_dedupeKey: { dedupeKey, teamId } },
        });
      }
      if (workItem && actionable.length) {
        await tx.analysisFinding.updateMany({
          data: { workItemId: workItem.id },
          where: {
            analysisId: job.id,
            fingerprint: {
              in: actionable.map((finding) => finding.fingerprint),
            },
          },
        });
      }
      await tx.postRunAnalysisEvent.create({
        data: {
          actor: "CONTROL_PLANE",
          analysisId: job.id,
          kind: "analysis.completed",
          payload: json({
            actionableFindingCount: actionable.length,
            coverage: safeReport.coverage ?? null,
            findingCount: unique.length,
            workItemId: workItem?.id ?? null,
          }),
          teamId,
        },
      });
      return {
        accepted: true,
        jobStatus: "SUCCEEDED" as const,
        nextAttemptScheduled: false,
        workItemId: workItem?.id ?? null,
      };
    });
  }

  private async fail(
    teamId: string,
    job: PostRunAnalysisOutcomeJob,
    completionId: string,
    outcome: Exclude<
      RuntimePostRunAnalysisOutcome,
      { kind: "ANALYSIS_COMPLETED" }
    >,
  ) {
    const now = new Date();
    const safeError = sanitizeLogBundleValue(outcome.error);
    const nextAttemptAt = postRunAnalysisRetryAt(job.attemptNumber, now);
    const retry =
      outcome.kind === "RETRYABLE_FAILURE" &&
      job.attemptNumber < job.maxAttempts &&
      nextAttemptAt < job.hardDeadlineAt;
    await this.prisma.$transaction(async (tx) => {
      const finalized = await tx.postRunAnalysisJob.updateMany({
        data: {
          completionId,
          error: json(safeError),
          finishedAt: retry ? null : now,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          nextAttemptAt: retry ? nextAttemptAt : null,
          readyAt: retry ? now : job.readyAt,
          status: retry ? "READY" : "FAILED",
          ...(retry ? { deadlineAt: job.hardDeadlineAt } : {}),
        },
        where: {
          fencingToken: job.fencingToken,
          id: job.id,
          leaseExpiresAt: { gt: now },
          leaseOwner: job.leaseOwner,
          leaseToken: job.leaseToken,
          status: "RUNNING",
          teamId,
        },
      });
      if (finalized.count !== 1) {
        throw new ConflictException("The post-run analysis lease is stale.");
      }
      await tx.postRunAnalysisEvent.create({
        data: {
          actor: "CONTROL_PLANE",
          analysisId: job.id,
          kind: retry ? "analysis.retry_queued" : "analysis.failed",
          payload: json({
            attemptNumber: job.attemptNumber,
            error: safeError,
            nextAttemptAt: retry ? nextAttemptAt.toISOString() : null,
          }),
          teamId,
        },
      });
    });
    return {
      accepted: true,
      jobStatus: retry ? ("READY" as const) : ("FAILED" as const),
      nextAttemptScheduled: retry,
      workItemId: null,
    };
  }

  private async failUnconfiguredJob(teamId: string) {
    await this.prisma.$transaction(async (tx) => {
      const job = await tx.postRunAnalysisJob.findFirst({
        orderBy: { createdAt: "asc" },
        select: { id: true },
        where: {
          NOT: {
            AND: [
              {
                inputManifest: {
                  equals: true,
                  path: ["analysisSynopsis", "cleanPass"],
                },
              },
              {
                inputManifest: {
                  equals: true,
                  path: ["analysisSynopsis", "completenessSufficient"],
                },
              },
            ],
          },
          status: "READY",
          teamId,
        },
      });
      if (!job) return;
      const now = new Date();
      const error = {
        code: "MODEL_PROVIDER_NOT_CONFIGURED",
        details: {},
        failureClass: "PROVIDER",
        message:
          "No model provider is configured for post-run analysis. Configure a model and retry the analysis.",
        phase: "post_run_analysis.configuration",
      };
      const updated = await tx.postRunAnalysisJob.updateMany({
        data: { error: json(error), finishedAt: now, status: "FAILED" },
        where: { id: job.id, status: "READY", teamId },
      });
      if (updated.count !== 1) return;
      await tx.postRunAnalysisEvent.create({
        data: {
          actor: "CONTROL_PLANE",
          analysisId: job.id,
          kind: "analysis.configuration_failed",
          payload: json({ error }),
          teamId,
        },
      });
    });
  }

  private async completionValidationContext(
    teamId: string,
    analysisId: string,
    findings: FindingRuntimeLocation[],
  ) {
    const evidenceRefs = [
      ...new Set(findings.flatMap((finding) => finding.evidenceRefs)),
    ];
    const runIds = [
      ...new Set(
        findings.flatMap((finding) => (finding.runId ? [finding.runId] : [])),
      ),
    ];
    const runtimeIds = [
      ...new Set(
        findings.flatMap((finding) =>
          finding.runtimeId ? [finding.runtimeId] : [],
        ),
      ),
    ];
    const attemptNumbers = [
      ...new Set(
        findings.flatMap((finding) =>
          finding.attemptNumber === null ? [] : [finding.attemptNumber],
        ),
      ),
    ];
    const rows = await this.prisma.$queryRaw<
      Array<{
        candidateCount: string | null;
        evidenceLocations: Prisma.JsonValue | null;
        evidenceRefs: Prisma.JsonValue | null;
        runs: Prisma.JsonValue | null;
        stages: Prisma.JsonValue | null;
      }>
    >(Prisma.sql`
      WITH source AS (
        SELECT "input_manifest" AS "manifest"
        FROM "post_run_analysis_jobs"
        WHERE "id" = ${analysisId}::uuid
          AND "team_id" = ${teamId}::uuid
        LIMIT 1
      ),
      requested_refs AS (
        SELECT "value"
        FROM jsonb_array_elements_text(${JSON.stringify(evidenceRefs)}::jsonb) AS requested("value")
      ),
      requested_runs AS (
        SELECT "value"
        FROM jsonb_array_elements_text(${JSON.stringify(runIds)}::jsonb) AS requested("value")
      ),
      requested_runtimes AS (
        SELECT "value"
        FROM jsonb_array_elements_text(${JSON.stringify(runtimeIds)}::jsonb) AS requested("value")
      ),
      requested_attempts AS (
        SELECT "value"
        FROM jsonb_array_elements(${JSON.stringify(attemptNumbers)}::jsonb) AS requested("value")
      )
      SELECT
        COALESCE(
          "manifest" #>> '{analysisSynopsis,candidateCount}',
          jsonb_array_length(
            CASE
              WHEN jsonb_typeof("manifest" #> '{analysisSynopsis,candidates}') = 'array'
                THEN "manifest" #> '{analysisSynopsis,candidates}'
              ELSE '[]'::jsonb
            END
          )::text,
          '0'
        ) AS "candidateCount",
        COALESCE((
          SELECT jsonb_agg(DISTINCT location."value")
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof("manifest" -> 'evidenceLocations') = 'array'
                THEN "manifest" -> 'evidenceLocations'
              ELSE '[]'::jsonb
            END
          ) AS location("value")
          WHERE location."value" ->> 'evidenceRef' IN (SELECT "value" FROM requested_refs)
        ), '[]'::jsonb) AS "evidenceLocations",
        COALESCE((
          SELECT jsonb_agg(DISTINCT ref."value")
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof("manifest" -> 'evidenceRefs') = 'array'
                THEN "manifest" -> 'evidenceRefs'
              ELSE '[]'::jsonb
            END
          ) AS ref("value")
          WHERE ref."value" IN (SELECT "value" FROM requested_refs)
        ), '[]'::jsonb) AS "evidenceRefs",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'attempts', COALESCE((
              SELECT jsonb_agg(DISTINCT jsonb_build_object(
                'attemptId', attempt."value" -> 'attemptId',
                'number', attempt."value" -> 'number'
              ))
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(run."value" -> 'attempts') = 'array'
                    THEN run."value" -> 'attempts'
                  ELSE '[]'::jsonb
                END
              ) AS attempt("value")
              WHERE attempt."value" -> 'number' IN (SELECT "value" FROM requested_attempts)
            ), '[]'::jsonb),
            'browserExecutions', COALESCE((
              SELECT jsonb_agg(DISTINCT jsonb_build_object(
                'attemptId', execution."value" -> 'attemptId',
                'runtimeId', execution."value" -> 'runtimeId'
              ))
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(run."value" -> 'browserExecutions') = 'array'
                    THEN run."value" -> 'browserExecutions'
                  ELSE '[]'::jsonb
                END
              ) AS execution("value")
              WHERE execution."value" ->> 'runtimeId' IN (SELECT "value" FROM requested_runtimes)
            ), '[]'::jsonb),
            'runId', run."value" -> 'runId'
          ))
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof("manifest" -> 'runs') = 'array'
                THEN "manifest" -> 'runs'
              ELSE '[]'::jsonb
            END
          ) AS run("value")
          WHERE run."value" ->> 'runId' IN (SELECT "value" FROM requested_runs)
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(run."value" -> 'attempts') = 'array'
                    THEN run."value" -> 'attempts'
                  ELSE '[]'::jsonb
                END
              ) AS attempt("value")
              WHERE attempt."value" -> 'number' IN (SELECT "value" FROM requested_attempts)
            )
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(run."value" -> 'browserExecutions') = 'array'
                    THEN run."value" -> 'browserExecutions'
                  ELSE '[]'::jsonb
                END
              ) AS execution("value")
              WHERE execution."value" ->> 'runtimeId' IN (SELECT "value" FROM requested_runtimes)
            )
        ), '[]'::jsonb) AS "runs",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'attempts', COALESCE((
              SELECT jsonb_agg(DISTINCT jsonb_build_object(
                'number', attempt."value" -> 'number'
              ))
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(stage."value" -> 'attempts') = 'array'
                    THEN stage."value" -> 'attempts'
                  ELSE '[]'::jsonb
                END
              ) AS attempt("value")
              WHERE attempt."value" -> 'number' IN (SELECT "value" FROM requested_attempts)
            ), '[]'::jsonb)
          ))
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof("manifest" -> 'stages') = 'array'
                THEN "manifest" -> 'stages'
              ELSE '[]'::jsonb
            END
          ) AS stage("value")
          WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(stage."value" -> 'attempts') = 'array'
                  THEN stage."value" -> 'attempts'
                ELSE '[]'::jsonb
              END
            ) AS attempt("value")
            WHERE attempt."value" -> 'number' IN (SELECT "value" FROM requested_attempts)
          )
        ), '[]'::jsonb) AS "stages"
      FROM source
    `);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException("Post-run analysis job was not found.");
    }
    const candidateCount = Number(row.candidateCount);
    return {
      candidateCount:
        Number.isSafeInteger(candidateCount) && candidateCount >= 0
          ? candidateCount
          : 0,
      manifest: {
        evidenceLocations: array(row.evidenceLocations),
        evidenceRefs: array(row.evidenceRefs),
        runs: array(row.runs),
        stages: array(row.stages),
      },
    };
  }

  private findJob(tx: Prisma.TransactionClient, teamId: string, id: string) {
    return tx.postRunAnalysisJob.findFirstOrThrow({
      select: {
        deadlineAt: true,
        fencingToken: true,
        leaseExpiresAt: true,
        leaseOwner: true,
        leaseToken: true,
        status: true,
      },
      where: { id, teamId },
    });
  }

  private requireLease(
    job: {
      fencingToken: bigint;
      leaseExpiresAt: Date | null;
      leaseOwner: string | null;
      leaseToken: string | null;
    },
    input: LeaseInput,
  ) {
    if (
      job.leaseOwner !== input.workerId ||
      job.leaseToken !== input.leaseToken ||
      job.fencingToken.toString() !== input.fencingToken ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= new Date()
    ) {
      throw new ConflictException("The post-run analysis lease is stale.");
    }
  }
}

type EvidenceLocation = {
  attemptNumber: number | null;
  evidenceRef: string;
  runId: string | null;
  runtimeId: string | null;
};

type KnownRunLocation = {
  attemptNumbers: Set<number>;
  runtimeAttempts: Map<string, Set<number>>;
  runtimeIds: Set<string>;
};

export function validateFindingRuntimeLocations(
  findings: FindingRuntimeLocation[],
  manifestValue: unknown,
) {
  const manifest = record(manifestValue);
  const runs = new Map<string, KnownRunLocation>();
  const allAttemptNumbers = new Set<number>();
  const allRuntimeIds = new Set<string>();

  for (const runValue of array(manifest.runs)) {
    const run = record(runValue);
    const runId = stringValue(run.runId);
    if (!runId) continue;
    const attemptNumbers = new Set<number>();
    const attemptNumbersById = new Map<string, number>();
    for (const attemptValue of array(run.attempts)) {
      const attempt = record(attemptValue);
      const attemptId = stringValue(attempt.attemptId);
      const number = positiveInteger(attempt.number);
      if (number === null) continue;
      attemptNumbers.add(number);
      allAttemptNumbers.add(number);
      if (attemptId) attemptNumbersById.set(attemptId, number);
    }
    const runtimeAttempts = new Map<string, Set<number>>();
    const runtimeIds = new Set<string>();
    for (const executionValue of array(run.browserExecutions)) {
      const execution = record(executionValue);
      const runtimeId = stringValue(execution.runtimeId);
      if (!runtimeId) continue;
      runtimeIds.add(runtimeId);
      allRuntimeIds.add(runtimeId);
      const attemptNumber = attemptNumbersById.get(
        stringValue(execution.attemptId) ?? "",
      );
      if (attemptNumber === undefined) continue;
      const numbers = runtimeAttempts.get(runtimeId) ?? new Set<number>();
      numbers.add(attemptNumber);
      runtimeAttempts.set(runtimeId, numbers);
    }
    runs.set(runId, { attemptNumbers, runtimeAttempts, runtimeIds });
  }
  for (const stageValue of array(manifest.stages)) {
    for (const attemptValue of array(record(stageValue).attempts)) {
      const number = positiveInteger(record(attemptValue).number);
      if (number !== null) allAttemptNumbers.add(number);
    }
  }

  const locations = parseEvidenceLocations(manifest.evidenceLocations);
  const locationsByRef = new Map<string, EvidenceLocation[]>();
  for (const location of locations) {
    const existing = locationsByRef.get(location.evidenceRef) ?? [];
    if (
      !existing.some(
        (item) =>
          item.attemptNumber === location.attemptNumber &&
          item.runId === location.runId &&
          item.runtimeId === location.runtimeId,
      )
    ) {
      existing.push(location);
    }
    locationsByRef.set(location.evidenceRef, existing);
  }

  const issues: string[] = [];
  for (const finding of findings) {
    const label = `finding "${finding.title.slice(0, 120)}"`;
    const run = finding.runId ? runs.get(finding.runId) : undefined;
    if (finding.runtimeId && !finding.runId) {
      issues.push(`${label} provides runtimeId without its required runId`);
    }
    if (finding.runId && !run) {
      issues.push(`${label} references an unknown runId ${finding.runId}`);
    }
    if (
      finding.attemptNumber !== null &&
      !(run?.attemptNumbers ?? allAttemptNumbers).has(finding.attemptNumber)
    ) {
      issues.push(
        `${label} references attempt ${finding.attemptNumber} outside the selected execution`,
      );
    }
    if (
      finding.runtimeId &&
      !(run?.runtimeIds ?? allRuntimeIds).has(finding.runtimeId)
    ) {
      issues.push(
        `${label} references runtimeId ${finding.runtimeId} outside the selected execution`,
      );
    }
    if (
      run &&
      finding.runtimeId &&
      finding.attemptNumber !== null &&
      !run.runtimeAttempts.get(finding.runtimeId)?.has(finding.attemptNumber)
    ) {
      issues.push(
        `${label} combines a runtime and attempt that were not linked in the execution manifest`,
      );
    }

    const citedLocations = finding.evidenceRefs.flatMap(
      (ref) => locationsByRef.get(ref) ?? [],
    );
    if (
      finding.runId &&
      !citedLocations.some((location) => location.runId === finding.runId)
    ) {
      issues.push(`${label} has no cited evidence linked to its runId`);
    }
    if (
      finding.runtimeId &&
      !citedLocations.some(
        (location) =>
          location.runtimeId === finding.runtimeId &&
          (!finding.runId || location.runId === finding.runId),
      )
    ) {
      issues.push(`${label} has no cited evidence linked to its runtimeId`);
    }
    if (
      finding.runId &&
      finding.attemptNumber !== null &&
      !citedLocations.some(
        (location) =>
          location.runId === finding.runId &&
          location.attemptNumber === finding.attemptNumber,
      )
    ) {
      issues.push(`${label} has no cited evidence linked to its attempt`);
    }
  }
  if (issues.length) {
    throw new BadRequestException(
      `Invalid analysis finding runtime location: ${[...new Set(issues)].join("; ")}.`,
    );
  }
}

function parseEvidenceLocations(value: unknown): EvidenceLocation[] {
  return array(value).flatMap((item) => {
    const location = record(item);
    const evidenceRef = stringValue(location.evidenceRef);
    if (!evidenceRef) return [];
    return [
      {
        attemptNumber: positiveInteger(location.attemptNumber),
        evidenceRef,
        runId: stringValue(location.runId),
        runtimeId: stringValue(location.runtimeId),
      },
    ];
  });
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length ? value : null;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function leaseExpiry(now: Date) {
  return new Date(
    now.getTime() + env().AGENT_RUNTIME_TASK_LEASE_SECONDS * 1_000,
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validUtf8Prefix(input: Buffer) {
  for (let trim = 0; trim <= 3 && trim < input.length; trim += 1) {
    const candidate = input.subarray(0, input.length - trim);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(candidate);
      return candidate;
    } catch {
      // The requested byte range ended inside a multibyte code point.
    }
  }
  return input;
}

function utf8ContinuationPrefixLength(input: Buffer) {
  let length = 0;
  while (
    length < Math.min(3, input.byteLength) &&
    (input[length]! & 0xc0) === 0x80
  ) {
    length += 1;
  }
  return length;
}

function isTextualContentType(contentType: string) {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/xml" ||
    normalized.endsWith("+xml")
  );
}

function redactArtifactBody(body: Buffer, contentType: string) {
  const text = body.toString("utf8");
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized === "application/json" || normalized.endsWith("+json")) {
    try {
      return Buffer.from(
        JSON.stringify(sanitizeLogBundleValue(JSON.parse(text)), null, 2),
      );
    } catch {
      // Invalid JSON is treated as ordinary redacted text.
    }
  }
  return Buffer.from(redactText(text));
}

export function compactInlineManifest(value: unknown): Record<string, unknown> {
  const manifest = record(value);
  const serialized = Buffer.from(JSON.stringify(manifest));
  if (
    manifest.truncated !== true &&
    serialized.byteLength <= INLINE_MANIFEST_MAX_BYTES
  ) {
    return manifest;
  }
  const evidenceLocationCount = manifestCollectionCount(
    manifest,
    "evidenceLocationCount",
    "evidenceLocations",
  );
  const evidenceRefCount = manifestCollectionCount(
    manifest,
    "evidenceRefCount",
    "evidenceRefs",
  );
  const manifestByteSize =
    nonnegativeInteger(manifest.manifestByteSize) ?? serialized.byteLength;
  const runCount = manifestCollectionCount(manifest, "runCount", "runs");
  const stageCount = manifestCollectionCount(manifest, "stageCount", "stages");
  const analysisSynopsis = compactAnalysisSynopsis(manifest.analysisSynopsis);
  const candidateLocations = synopsisEvidenceLocations(analysisSynopsis);
  const candidateEvidenceRefs = candidateLocations.map(
    (location) => location.evidenceRef,
  );
  const summary = {
    analysisSynopsis,
    eventCounts: record(manifest.eventCounts),
    evidenceLocations: candidateLocations,
    evidenceLocationCount,
    evidenceRefs: candidateEvidenceRefs,
    evidenceRefCount,
    manifestByteSize,
    runCount,
    runs: array(manifest.runs).length
      ? array(manifest.runs).map(compactManifestRun)
      : candidateRunsFromLocations(candidateLocations),
    schemaVersion: stringValue(manifest.schemaVersion),
    stageCount,
    stages: array(manifest.stages).map(compactManifestStage),
    task: record(manifest.task),
    truncated: true,
  };
  if (Buffer.byteLength(JSON.stringify(summary)) <= INLINE_MANIFEST_MAX_BYTES) {
    return summary;
  }
  const task = record(manifest.task);
  const candidateRunIds = new Set(
    candidateLocations.flatMap((location) =>
      location.runId ? [location.runId] : [],
    ),
  );
  const fallback = {
    analysisSynopsis,
    evidenceLocations: candidateLocations,
    evidenceLocationCount,
    evidenceRefs: candidateEvidenceRefs,
    evidenceRefCount,
    manifestByteSize,
    runCount,
    runs: relatedCandidateRuns(
      manifest.runs,
      candidateRunIds,
      candidateLocations,
    ),
    schemaVersion: stringValue(manifest.schemaVersion),
    stageCount,
    task: compactManifestTask(task),
    truncated: true,
  };
  if (
    Buffer.byteLength(JSON.stringify(fallback)) <= INLINE_MANIFEST_MAX_BYTES
  ) {
    return fallback;
  }
  const tightSynopsis = compactAnalysisSynopsis(
    manifest.analysisSynopsis,
    16,
    120,
  );
  const tightLocations = synopsisEvidenceLocations(tightSynopsis);
  const tightRunIds = new Set(
    tightLocations.flatMap((location) =>
      location.runId ? [location.runId] : [],
    ),
  );
  const tight = {
    ...fallback,
    analysisSynopsis: tightSynopsis,
    evidenceLocations: tightLocations,
    evidenceRefs: tightLocations.map((location) => location.evidenceRef),
    runs: relatedCandidateRuns(manifest.runs, tightRunIds, tightLocations),
  };
  if (Buffer.byteLength(JSON.stringify(tight)) <= INLINE_MANIFEST_MAX_BYTES) {
    return tight;
  }

  for (let candidateLimit = 16; candidateLimit >= 0; candidateLimit -= 1) {
    const minimalSynopsis = compactAnalysisSynopsis(
      manifest.analysisSynopsis,
      candidateLimit,
      120,
    );
    const minimalLocations = synopsisEvidenceLocations(minimalSynopsis);
    const minimal = {
      analysisSynopsis: minimalSynopsis,
      evidenceLocationCount,
      evidenceLocations: minimalLocations,
      evidenceRefCount,
      evidenceRefs: minimalLocations.map((location) => location.evidenceRef),
      manifestByteSize,
      runCount,
      runs: candidateRunsFromLocations(minimalLocations),
      schemaVersion: boundedString(manifest.schemaVersion, 160),
      stageCount,
      task: compactManifestTask(task),
      truncated: true,
    };
    if (
      Buffer.byteLength(JSON.stringify(minimal)) <= INLINE_MANIFEST_MAX_BYTES
    ) {
      return minimal;
    }
  }
  throw new Error("Unable to compact the execution manifest below 64 KB.");
}

function compactAnalysisSynopsis(
  value: unknown,
  candidateLimit = 32,
  summaryLimit = 240,
) {
  const synopsis = record(value);
  const allCandidates = array(synopsis.candidates);
  const candidates = allCandidates
    .slice(0, candidateLimit)
    .map((item) => {
      const candidate = record(item);
      return {
        attemptNumber: positiveInteger(candidate.attemptNumber),
        evidenceRef: exactBoundedString(candidate.evidenceRef, 500),
        occurredAt: boundedString(candidate.occurredAt, 40),
        priority: nonnegativeInteger(candidate.priority),
        runId: exactBoundedString(candidate.runId, 80),
        runtimeId: exactBoundedString(candidate.runtimeId, 80),
        signal: boundedString(candidate.signal, 120),
        summary: boundedString(candidate.summary, summaryLimit),
      };
    })
    .filter((candidate) => candidate.evidenceRef);
  const candidateCount =
    nonnegativeInteger(synopsis.candidateCount) ?? allCandidates.length;
  return {
    candidateCount,
    candidateReasonCounts: compactCandidateReasonCounts(
      synopsis.candidateReasonCounts,
    ),
    candidates,
    cleanPass: synopsis.cleanPass === true,
    completenessSufficient: synopsis.completenessSufficient === true,
    incompleteReasons: array(synopsis.incompleteReasons)
      .flatMap((reason) => {
        const value = boundedString(reason, 120);
        return value ? [value] : [];
      })
      .slice(0, 16),
    selectedCandidateCount: candidates.length,
    strategy:
      synopsis.strategy === "failure-first-v1" ? "failure-first-v1" : undefined,
    truncated:
      synopsis.truncated === true || candidates.length < candidateCount,
  };
}

function compactCandidateReasonCounts(value: unknown) {
  return Object.fromEntries(
    Object.entries(record(value))
      .slice(0, 32)
      .flatMap(([key, count]) => {
        const normalized = nonnegativeInteger(count);
        return normalized === null ? [] : [[key.slice(0, 120), normalized]];
      }),
  );
}

function relatedCandidateRuns(
  runsValue: unknown,
  candidateRunIds: Set<string>,
  locations: ReturnType<typeof synopsisEvidenceLocations>,
) {
  const runs = array(runsValue)
    .filter((item) =>
      candidateRunIds.has(stringValue(record(item).runId) ?? ""),
    )
    .map(compactManifestRun);
  return runs.length ? runs : candidateRunsFromLocations(locations);
}

function candidateRunsFromLocations(
  locations: ReturnType<typeof synopsisEvidenceLocations>,
) {
  const runs = new Map<
    string,
    {
      attempts: Map<number, string>;
      browserExecutions: Map<
        string,
        { attemptId: string | null; runtimeId: string }
      >;
    }
  >();
  for (const location of locations) {
    if (!location.runId) continue;
    const run = runs.get(location.runId) ?? {
      attempts: new Map<number, string>(),
      browserExecutions: new Map<
        string,
        { attemptId: string | null; runtimeId: string }
      >(),
    };
    const attemptId =
      location.attemptNumber === null
        ? null
        : `inline-attempt-${location.attemptNumber}`;
    if (location.attemptNumber !== null && attemptId) {
      run.attempts.set(location.attemptNumber, attemptId);
    }
    if (location.runtimeId) {
      run.browserExecutions.set(location.runtimeId, {
        attemptId,
        runtimeId: location.runtimeId,
      });
    }
    runs.set(location.runId, run);
  }
  return [...runs.entries()].map(([runId, run]) => ({
    attempts: [...run.attempts.entries()].map(([number, attemptId]) => ({
      attemptId,
      number,
      status: null,
    })),
    browserExecutions: [...run.browserExecutions.values()],
    executionDisposition: null,
    lifecycle: null,
    runId,
    verdict: null,
  }));
}

function compactManifestTask(value: Record<string, unknown>) {
  return {
    currentStage: boundedString(value.currentStage, 120),
    executionDisposition: boundedString(value.executionDisposition, 120),
    lifecycle: boundedString(value.lifecycle, 120),
    taskExecutionId: exactBoundedString(value.taskExecutionId, 80),
    verdict: boundedString(value.verdict, 120),
  };
}

function manifestCollectionCount(
  manifest: Record<string, unknown>,
  countKey: string,
  collectionKey: string,
) {
  return (
    nonnegativeInteger(manifest[countKey]) ??
    array(manifest[collectionKey]).length
  );
}

function nonnegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function boundedString(value: unknown, limit: number) {
  return typeof value === "string" && value ? value.slice(0, limit) : null;
}

function exactBoundedString(value: unknown, limit: number) {
  return typeof value === "string" && value && value.length <= limit
    ? value
    : null;
}

function synopsisEvidenceLocations(value: unknown) {
  return array(record(value).candidates).flatMap((item) => {
    const candidate = record(item);
    const evidenceRef = stringValue(candidate.evidenceRef);
    if (!evidenceRef) return [];
    return [
      {
        attemptNumber: positiveInteger(candidate.attemptNumber),
        evidenceRef,
        runId: stringValue(candidate.runId),
        runtimeId: stringValue(candidate.runtimeId),
      },
    ];
  });
}

function compactManifestRun(value: unknown) {
  const run = record(value);
  return {
    attempts: array(run.attempts).map((item) => {
      const attempt = record(item);
      return {
        attemptId: stringValue(attempt.attemptId),
        failureClass: stringValue(attempt.failureClass),
        number: positiveInteger(attempt.number),
        status: stringValue(attempt.status),
      };
    }),
    browserExecutions: array(run.browserExecutions).map((item) => {
      const execution = record(item);
      return {
        attemptId: stringValue(execution.attemptId),
        runtimeId: stringValue(execution.runtimeId),
        status: stringValue(execution.status),
      };
    }),
    executionDisposition: stringValue(run.executionDisposition),
    lifecycle: stringValue(run.lifecycle),
    runId: stringValue(run.runId),
    verdict: stringValue(run.verdict),
  };
}

function compactManifestStage(value: unknown) {
  const stage = record(value);
  return {
    attempts: array(stage.attempts).map((item) => {
      const attempt = record(item);
      return {
        number: positiveInteger(attempt.number),
        status: stringValue(attempt.status),
      };
    }),
    status: stringValue(stage.status),
    type: stringValue(stage.type),
    waitingReason: stringValue(stage.waitingReason),
  };
}

function manifestEvidenceRefs(value: unknown) {
  return new Set(
    array(record(value).evidenceRefs).filter(
      (item): item is string => typeof item === "string",
    ),
  );
}

function manifestAnalysisCandidateCount(value: unknown) {
  const synopsis = record(record(value).analysisSynopsis);
  const candidateCount = synopsis.candidateCount;
  return typeof candidateCount === "number" &&
    Number.isSafeInteger(candidateCount) &&
    candidateCount >= 0
    ? candidateCount
    : array(synopsis.candidates).length;
}

function publicAnalysisManifest(value: unknown): Record<string, unknown> {
  const manifest = record(value);
  return Object.fromEntries(
    Object.entries(manifest).filter(
      ([key]) =>
        key !== POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD &&
        key !== POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD,
    ),
  );
}

function structuredEvidenceSource(value: unknown, evidenceRef: string) {
  const manifest = record(value);
  const rawEntry = record(manifest[POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD])[
    evidenceRef
  ];
  return structuredEvidenceRow({
    entry: rawEntry,
    storageKey:
      typeof manifest[POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD] === "string"
        ? manifest[POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD]
        : null,
  });
}

function structuredEvidenceRow(value: unknown): {
  entry: StructuredEvidenceIndexEntry;
  storageKey: string;
} | null {
  const row = record(value);
  const storageKey = row.storageKey;
  const rawEntry = row.entry;
  const entry = record(rawEntry);
  if (
    typeof storageKey !== "string" ||
    !storageKey ||
    typeof entry.byteSize !== "number" ||
    !Number.isSafeInteger(entry.byteSize) ||
    entry.byteSize <= 0 ||
    typeof entry.offset !== "number" ||
    !Number.isSafeInteger(entry.offset) ||
    entry.offset < 0 ||
    !Number.isSafeInteger(entry.offset + entry.byteSize) ||
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.sha256)
  ) {
    return null;
  }
  return {
    entry: {
      byteSize: entry.byteSize,
      offset: entry.offset,
      sha256: entry.sha256,
    },
    storageKey,
  };
}

function embeddedInputManifest(value: unknown) {
  const manifest = record(value).inputManifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }
  return manifest as Record<string, unknown>;
}

function terminalOutputStatus(status: string) {
  if (["READY", "SUCCEEDED", "FAILED", "CANCELLED"].includes(status)) {
    return status as "READY" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  }
  return "FAILED" as const;
}

function workItemBody(
  task: {
    executionDisposition: string | null;
    id: string;
    lifecycle: string;
    sourceRef: string | null;
    title: string;
    verdict: string | null;
  },
  summary: string,
  findings: Array<{
    attemptNumber: number | null;
    category: string;
    component: string;
    confidence: number;
    evidenceRefs: string[];
    failureClass: string;
    impact: string;
    phase: string;
    recommendation: string;
    rootCause: string;
    runId: string | null;
    runtimeId: string | null;
    severity: string;
    title: string;
  }>,
  analysis: { analyzerVersion: string; id: string; inputSha256: string | null },
) {
  const lines = [
    `# ${task.title}`,
    "",
    `- Source task: ${task.id}`,
    `- Source issue: ${task.sourceRef ?? "n/a"}`,
    `- Result: ${task.lifecycle} / ${task.executionDisposition ?? "n/a"} / ${task.verdict ?? "n/a"}`,
    `- Analysis: ${analysis.id} (${analysis.analyzerVersion})`,
    `- Log bundle SHA-256: ${analysis.inputSha256 ?? "n/a"}`,
    "",
    "## 分析摘要",
    "",
    redactText(summary),
    "",
    "## 可优化问题",
  ];
  findings.forEach((finding, index) => {
    lines.push(
      "",
      `### ${index + 1}. [${finding.severity}] ${finding.title}`,
      "",
      `- 分类：${finding.category}`,
      `- 组件：${finding.component}`,
      `- 阶段：${finding.phase}`,
      `- 失败类型：${finding.failureClass}`,
      `- Run：${finding.runId ?? "n/a"}`,
      `- Runtime：${finding.runtimeId ?? "n/a"}`,
      `- Attempt：${finding.attemptNumber ?? "n/a"}`,
      `- 置信度：${finding.confidence.toFixed(2)}`,
      `- 根因：${finding.rootCause}`,
      `- 影响：${finding.impact}`,
      `- 建议：${finding.recommendation}`,
      `- 证据：${finding.evidenceRefs.join(", ")}`,
    );
  });
  return redactText(lines.join("\n")).slice(0, 100_000);
}
