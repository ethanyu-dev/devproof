import { createHash, randomBytes } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { VerificationRequest } from "@devproof/contracts";
import {
  verificationAssertionRecordSchema,
  verificationRequestSchema,
  verificationResultSchema,
  type VerificationAssertionRecord,
  type VerificationEventAppendInput,
  type VerificationResult,
} from "@devproof/contracts";

import { PrismaService } from "../database/prisma.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import {
  isTerminalVerificationStatus,
  VerificationLifecycleService,
} from "./verification-lifecycle.service.js";
import { ObservabilityService } from "../observability/observability.service.js";
import { MetricsService } from "../observability/metrics.service.js";

const ACTIVE_STATUSES = [
  "QUEUED",
  "WAITING_EXECUTION",
  "RUNNING",
  "WAITING_HUMAN",
] as const;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function verificationRequestHash(request: VerificationRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

export function matchesVerificationRequestIdentity(
  storedHash: string,
  storedSnapshot: Prisma.JsonValue,
  candidateHash: string,
): boolean {
  if (storedHash === candidateHash) return true;
  const normalizedStored = verificationRequestSchema.parse(storedSnapshot);
  return verificationRequestHash(normalizedStored) === candidateHash;
}

function artifactId(evidenceRef: string) {
  return evidenceRef.slice("artifact://".length);
}

export function decodeUtf8ArtifactPage(body: Buffer, hasMoreBytes: boolean) {
  const maximumTrim = hasMoreBytes ? Math.min(3, body.byteLength) : 0;
  for (let trim = 0; trim <= maximumTrim; trim += 1) {
    const candidate = body.subarray(0, body.byteLength - trim);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(candidate);
      return { body: candidate, text };
    } catch {
      // A bounded range may end in the middle of a four-byte UTF-8 sequence.
    }
  }
  throw new ConflictException(
    "Artifact is not valid UTF-8 at this cursor; use a nextCursor returned by read_artifact.",
  );
}

export function validateVerificationEvidenceRefs(
  request: VerificationRequest,
  result: VerificationResult,
  artifacts: Array<{ id: string; kind: string }>,
) {
  const evidenceRefs = Array.from(
    new Set([
      ...result.evidenceRefs,
      ...result.criteria.flatMap((criterion) => criterion.evidenceRefs),
    ]),
  );
  const artifactsById = new Map(
    artifacts.map((artifact) => [artifact.id, artifact]),
  );
  const unavailable = evidenceRefs.filter(
    (evidenceRef) => !artifactsById.has(artifactId(evidenceRef)),
  );
  if (unavailable.length > 0) {
    throw new ConflictException(
      `Result references evidence unavailable to this verification: ${unavailable.join(", ")}.`,
    );
  }
  if (result.verdict !== "PASSED") return;

  const referencedKinds = new Set(
    evidenceRefs.map((evidenceRef) => {
      return artifactsById.get(artifactId(evidenceRef))?.kind;
    }),
  );
  const missing = request.evidencePolicy.requiredKinds.filter(
    (kind) => !referencedKinds.has(kind),
  );
  if (missing.length > 0) {
    throw new ConflictException(
      `PASSED result is missing referenced evidence kinds: ${missing.join(", ")}.`,
    );
  }
}

export function validateRecordedAssertions(
  request: VerificationRequest,
  result: VerificationResult,
  assertions: Array<{
    criterionId: string;
    evidenceRefs: string[];
    status: "PASSED" | "FAILED" | "INCONCLUSIVE";
  }>,
) {
  if (request.mode !== "TEST") return;
  const assertionsByCriterion = new Map(
    assertions.map((assertion) => [assertion.criterionId, assertion]),
  );
  for (const criterion of request.acceptanceCriteria) {
    if (criterion.required && !assertionsByCriterion.has(criterion.id)) {
      throw new ConflictException(
        `TEST verification is missing required assertion ${criterion.id}. Call record_assertion for every required criterion before finish_browser_verification.`,
      );
    }
  }
  for (const criterion of result.criteria) {
    const assertion = assertionsByCriterion.get(criterion.criterionId);
    if (!assertion) continue;
    if (assertion.status !== criterion.status) {
      throw new ConflictException(
        `Final result disagrees with recorded assertion ${criterion.criterionId}.`,
      );
    }
    const finalEvidence = new Set(criterion.evidenceRefs);
    if (
      assertion.evidenceRefs.some(
        (evidenceRef) => !finalEvidence.has(evidenceRef),
      )
    ) {
      throw new ConflictException(
        `Final result omits evidence recorded for assertion ${criterion.criterionId}.`,
      );
    }
  }
}

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: VerificationLifecycleService,
    private readonly storage: ObjectStorageService,
    private readonly observability: ObservabilityService,
    private readonly metrics: MetricsService,
  ) {}

  list(current: ToolAuthContext) {
    return this.prisma.verificationRun.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        agentProvider: true,
        createdAt: true,
        finishedAt: true,
        goal: true,
        id: true,
        idempotencyKey: true,
        queuedAt: true,
        status: true,
        updatedAt: true,
      },
      take: 100,
      where: { teamId: current.team.id },
    });
  }

  async create(current: ToolAuthContext, request: VerificationRequest) {
    const requestSha256 = verificationRequestHash(request);
    if (request.agentRuntime.externalRunId) {
      const mapped = await this.prisma.verificationRun.findFirst({
        where: {
          agentProvider: request.agentRuntime.provider,
          externalAgentRunId: request.agentRuntime.externalRunId,
          teamId: current.team.id,
        },
      });
      if (mapped) {
        const mappedRequest = verificationRequestSchema.parse(
          mapped.requestSnapshot,
        );
        return this.resolveIdempotent(
          mapped,
          verificationRequestHash({
            ...request,
            idempotencyKey: mappedRequest.idempotencyKey,
          }),
        );
      }
    }
    const existing = await this.prisma.verificationRun.findUnique({
      where: {
        teamId_idempotencyKey: {
          idempotencyKey: request.idempotencyKey,
          teamId: current.team.id,
        },
      },
    });
    if (existing) {
      return this.resolveIdempotent(existing, requestSha256);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const run = await tx.verificationRun.create({
          data: {
            agentProvider: request.agentRuntime.provider,
            callerCredentialId: current.credential.id,
            externalAgentRunId: request.agentRuntime.externalRunId ?? null,
            goal: request.goal,
            idempotencyKey: request.idempotencyKey,
            retentionUntil: new Date(
              Date.now() + request.evidencePolicy.retentionDays * 86_400_000,
            ),
            requestSha256,
            requestSnapshot: request as Prisma.InputJsonValue,
            teamId: current.team.id,
            traceId:
              this.observability.current()?.traceId ??
              randomBytes(16).toString("hex"),
          },
        });
        await tx.verificationEvent.create({
          data: {
            actor: "AGENT",
            kind: "verification.created",
            payload: {
              agentProvider: run.agentProvider,
              callerCredentialId: current.credential.id,
            },
            credentialId: current.credential.id,
            ...this.observability.eventFields(),
            runId: run.id,
            teamId: run.teamId,
            traceId: run.traceId,
          },
        });
        return run;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const raced = await this.prisma.verificationRun.findFirst({
          where: {
            teamId: current.team.id,
            OR: [
              { idempotencyKey: request.idempotencyKey },
              ...(request.agentRuntime.externalRunId
                ? [
                    {
                      agentProvider: request.agentRuntime.provider,
                      externalAgentRunId: request.agentRuntime.externalRunId,
                    },
                  ]
                : []),
            ],
          },
        });
        if (!raced) throw error;
        const racedRequest = verificationRequestSchema.parse(
          raced.requestSnapshot,
        );
        return this.resolveIdempotent(
          raced,
          verificationRequestHash({
            ...request,
            idempotencyKey: racedRequest.idempotencyKey,
          }),
        );
      }
      throw error;
    }
  }

  async detail(current: ToolAuthContext, id: string) {
    const row = await this.prisma.verificationRun.findFirst({
      include: {
        assertions: { orderBy: { createdAt: "asc" } },
        artifacts: { orderBy: { createdAt: "asc" } },
        checkpoints: { orderBy: { requestedAt: "asc" } },
        events: { orderBy: { sequence: "asc" } },
      },
      where: { id, teamId: current.team.id },
    });
    if (!row) {
      throw new NotFoundException("Verification run was not found.");
    }
    return this.serialize({
      ...row,
      artifacts: await Promise.all(
        row.artifacts.map(async (artifact) => ({
          ...artifact,
          downloadUrl: artifact.storageKey
            ? await this.storage.signedDownloadUrl(artifact.storageKey)
            : null,
          evidenceRef: `artifact://${artifact.id}`,
        })),
      ),
    });
  }

  async events(current: ToolAuthContext, id: string, after?: bigint) {
    await this.assertOwned(current.team.id, id);
    const rows = await this.prisma.verificationEvent.findMany({
      orderBy: { sequence: "asc" },
      take: 500,
      where: {
        runId: id,
        teamId: current.team.id,
        ...(after !== undefined ? { sequence: { gt: after } } : {}),
      },
    });
    return rows.map((row) => ({ ...row, sequence: row.sequence.toString() }));
  }

  async report(current: ToolAuthContext, id: string) {
    const detail = await this.detail(current, id);
    const request = verificationRequestSchema.parse(detail.requestSnapshot);
    const result = detail.result
      ? verificationResultSchema.parse(detail.result)
      : null;
    const assertionsByCriterion = new Map(
      detail.assertions.map((assertion) => [assertion.criterionId, assertion]),
    );
    const resultByCriterion = new Map(
      (result?.criteria ?? []).map((criterion) => [
        criterion.criterionId,
        criterion,
      ]),
    );
    const error = detail.error as { code?: string; message?: string } | null;
    const infrastructureCodes = new Set([
      "AGENT_RUN_TIMEOUT",
      "COMMAND_TIMEOUT",
      "EXECUTION_ACQUIRE_TIMEOUT",
      "RUNTIME_RESTARTED",
      "SESSION_LOST",
    ]);
    return {
      artifacts: detail.artifacts.map((artifact) => ({
        createdAt: artifact.createdAt,
        evidenceRef: artifact.evidenceRef,
        kind: artifact.kind,
        label: artifact.label,
        metadata: artifact.metadata,
      })),
      criteria: request.acceptanceCriteria.map((criterion) => ({
        assertion: assertionsByCriterion.get(criterion.id) ?? null,
        criterion,
        result: resultByCriterion.get(criterion.id) ?? null,
      })),
      failureClass:
        error?.code && infrastructureCodes.has(error.code)
          ? "INFRASTRUCTURE"
          : detail.status === "FAILED"
            ? "PRODUCT"
            : "NONE",
      finishedAt: detail.finishedAt,
      mode: request.mode,
      result,
      schemaVersion: 1,
      startedAt: detail.startedAt,
      status: detail.status,
      trace: detail.events,
      verificationId: detail.id,
    };
  }

  async readArtifact(
    current: ToolAuthContext,
    runId: string,
    evidenceRef: string,
    input: { cursor: number; maxBytes: number },
  ) {
    const id = artifactId(evidenceRef);
    const artifact = await this.prisma.verificationArtifact.findFirst({
      include: {
        runtimeArtifact: {
          select: { byteSize: true, contentType: true },
        },
      },
      where: { id, runId, teamId: current.team.id },
    });
    if (!artifact || !artifact.storageKey || !artifact.runtimeArtifact) {
      throw new NotFoundException("Verification artifact was not found.");
    }
    const allowedTypes = new Set([
      "image/jpeg",
      "image/png",
      "text/html; charset=utf-8",
      "application/json",
    ]);
    if (!allowedTypes.has(artifact.runtimeArtifact.contentType)) {
      throw new ConflictException("Artifact MIME type cannot be read by MCP.");
    }
    const isImage = artifact.runtimeArtifact.contentType.startsWith("image/");
    if (isImage && artifact.runtimeArtifact.byteSize > 1_250 * 1_024) {
      throw new ConflictException(
        "Screenshot exceeds the 1.25 MiB inline MCP image limit; capture a viewport JPEG.",
      );
    }
    if (isImage && input.cursor !== 0) {
      throw new ConflictException("Image artifacts do not support cursors.");
    }
    const start = isImage ? 0 : input.cursor;
    if (start >= artifact.runtimeArtifact.byteSize) {
      throw new ConflictException(
        "Artifact cursor is past the end of the file.",
      );
    }
    const length = isImage
      ? artifact.runtimeArtifact.byteSize
      : Math.min(input.maxBytes, artifact.runtimeArtifact.byteSize - start);
    const stored = await this.storage.get(artifact.storageKey, {
      end: start + length - 1,
      start,
    });
    const rawHasMoreBytes =
      start + stored.body.byteLength < artifact.runtimeArtifact.byteSize;
    const page = isImage
      ? { body: stored.body }
      : decodeUtf8ArtifactPage(stored.body, rawHasMoreBytes);
    const nextCursor = start + page.body.byteLength;
    return {
      body: page.body,
      contentType: artifact.runtimeArtifact.contentType,
      evidenceRef,
      kind: artifact.kind,
      nextCursor:
        nextCursor < artifact.runtimeArtifact.byteSize ? nextCursor : null,
      totalBytes: artifact.runtimeArtifact.byteSize,
      truncated: nextCursor < artifact.runtimeArtifact.byteSize,
    };
  }

  async appendEvent(
    current: ToolAuthContext,
    id: string,
    input: VerificationEventAppendInput,
  ) {
    const event = await this.lifecycle.appendEvent({
      actor: "AGENT",
      kind: input.kind,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      payload: input.payload,
      status: input.status,
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: input.durationMs }),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      runId: id,
      teamId: current.team.id,
    });
    this.recordAgentMetrics(input);
    return { ...event, sequence: event.sequence.toString() };
  }

  private recordAgentMetrics(input: VerificationEventAppendInput) {
    const operation = input.kind.startsWith("agent.model.")
      ? "model"
      : input.kind.startsWith("agent.tool.")
        ? "tool"
        : undefined;
    if (!operation) return;
    this.metrics.increment(
      "devproof_agent_operations_total",
      "Agent operations reported through the durable verification trace.",
      { operation, status: input.status.toLowerCase() },
    );
    if (input.durationMs !== undefined) {
      this.metrics.observe(
        `devproof_agent_${operation}_duration_seconds`,
        `Agent ${operation} operation duration in seconds.`,
        input.durationMs / 1_000,
      );
    }
    if (operation !== "model") return;
    for (const [field, direction] of [
      ["inputUnits", "input"],
      ["outputUnits", "output"],
      ["totalUnits", "total"],
    ] as const) {
      const value = input.payload[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        this.metrics.increment(
          "devproof_agent_model_units_total",
          "Model usage units reported by Agent Runtimes.",
          { direction },
          value,
        );
      }
    }
  }

  async recordAssertion(
    current: ToolAuthContext,
    runId: string,
    input: VerificationAssertionRecord,
  ) {
    const assertion = verificationAssertionRecordSchema.parse(input);
    return this.prisma.$transaction(async (tx) => {
      const run = await this.lockOwnedRun(tx, current.team.id, runId);
      if (run.status !== "RUNNING") {
        throw new ConflictException(
          `Verification in ${run.status} state cannot record assertions.`,
        );
      }
      const request = verificationRequestSchema.parse(run.requestSnapshot);
      if (
        !request.acceptanceCriteria.some(
          (criterion) => criterion.id === assertion.criterionId,
        )
      ) {
        throw new ConflictException(
          `Assertion references unknown criterion ${assertion.criterionId}.`,
        );
      }
      const evidenceIds = assertion.evidenceRefs.map(artifactId);
      const evidenceCount = await tx.verificationArtifact.count({
        where: {
          id: { in: evidenceIds },
          runId,
          teamId: current.team.id,
        },
      });
      if (evidenceCount !== new Set(evidenceIds).size) {
        throw new ConflictException(
          "Assertion references evidence unavailable to this verification.",
        );
      }
      const recorded = await tx.verificationAssertion.upsert({
        create: {
          ...assertion,
          runId,
          teamId: current.team.id,
        },
        update: {
          evidenceRefs: assertion.evidenceRefs,
          status: assertion.status,
          summary: assertion.summary,
        },
        where: {
          runId_criterionId: {
            criterionId: assertion.criterionId,
            runId,
          },
        },
      });
      await tx.verificationEvent.create({
        data: {
          actor: "AGENT",
          kind: "assertion.recorded",
          payload: {
            assertionId: recorded.id,
            criterionId: recorded.criterionId,
            evidenceRefs: recorded.evidenceRefs,
            status: recorded.status,
          },
          credentialId: current.credential.id,
          ...this.observability.eventFields(),
          runId,
          teamId: current.team.id,
          traceId: run.traceId,
        },
      });
      return recorded;
    });
  }

  async complete(
    current: ToolAuthContext,
    id: string,
    result: VerificationResult,
  ) {
    const completion = await this.prisma.$transaction(async (tx) => {
      const run = await this.lockOwnedRun(tx, current.team.id, id);
      if (isTerminalVerificationStatus(run.status)) {
        if (run.result && canonicalJson(run.result) === canonicalJson(result)) {
          return { alreadyCompleted: true };
        }
        throw new ConflictException(
          `Verification is already terminal with status ${run.status}.`,
        );
      }
      await this.validateResult(run.requestSnapshot, result, id, tx);
      await this.lifecycle.transitionInTransaction(tx, {
        actor: "AGENT",
        eventKind: "verification.completed",
        expected: [...ACTIVE_STATUSES],
        result,
        runId: id,
        teamId: current.team.id,
        to: result.verdict,
      });
      return { alreadyCompleted: false };
    });
    if (!completion.alreadyCompleted) await this.cancelPendingCheckpoints(id);
    return this.detail(current, id);
  }

  async cancel(current: ToolAuthContext, id: string) {
    const row = await this.assertOwned(current.team.id, id);
    if (
      !ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number])
    ) {
      // Cancellation is a compensating cleanup operation. A retry can race
      // with normal completion, so every terminal state is an idempotent
      // success and must never be rewritten to CANCELLED.
      return this.detail(current, id);
    }

    await this.lifecycle.transition({
      actor: "AGENT",
      eventKind: "verification.cancelled",
      expected: [...ACTIVE_STATUSES],
      runId: id,
      teamId: current.team.id,
      to: "CANCELLED",
    });
    await this.cancelPendingCheckpoints(id);
    return this.detail(current, id);
  }

  private async cancelPendingCheckpoints(runId: string) {
    await this.prisma.$transaction([
      this.prisma.verificationCheckpoint.updateMany({
        data: { status: "CANCELLED" },
        where: { runId, status: "PENDING" },
      }),
      this.prisma.notificationOutbox.updateMany({
        data: { status: "CANCELLED" },
        where: { runId, status: { in: ["PENDING", "FAILED"] } },
      }),
    ]);
  }

  private async assertOwned(teamId: string, id: string) {
    const row = await this.prisma.verificationRun.findFirst({
      where: { id, teamId },
    });
    if (!row) {
      throw new NotFoundException("Verification run was not found.");
    }
    return row;
  }

  private async validateResult(
    snapshot: Prisma.JsonValue,
    result: VerificationResult,
    runId: string,
    database: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const request = verificationRequestSchema.parse(snapshot);
    const expected = new Map(
      request.acceptanceCriteria.map((criterion) => [criterion.id, criterion]),
    );
    const received = new Set<string>();
    for (const criterion of result.criteria) {
      if (!expected.has(criterion.criterionId)) {
        throw new ConflictException(
          `Result references unknown criterion ${criterion.criterionId}.`,
        );
      }
      if (received.has(criterion.criterionId)) {
        throw new ConflictException(
          `Result repeats criterion ${criterion.criterionId}.`,
        );
      }
      received.add(criterion.criterionId);
    }
    for (const criterion of request.acceptanceCriteria) {
      if (criterion.required && !received.has(criterion.id)) {
        throw new ConflictException(
          `Result is missing required criterion ${criterion.id}.`,
        );
      }
    }
    const requiredResults = result.criteria.filter(
      (item) => expected.get(item.criterionId)?.required,
    );
    if (
      result.verdict === "PASSED" &&
      requiredResults.some((item) => item.status !== "PASSED")
    ) {
      throw new ConflictException(
        "A PASSED verdict requires every required criterion to pass.",
      );
    }
    if (
      result.verdict === "FAILED" &&
      !requiredResults.some((item) => item.status === "FAILED")
    ) {
      throw new ConflictException(
        "A FAILED verdict requires at least one required criterion to fail.",
      );
    }
    const artifacts = await database.verificationArtifact.findMany({
      select: { id: true, kind: true },
      where: { runId },
    });
    validateVerificationEvidenceRefs(request, result, artifacts);
    if (request.mode === "TEST") {
      const assertions = await database.verificationAssertion.findMany({
        where: { runId },
      });
      validateRecordedAssertions(request, result, assertions);
    }
  }

  private async lockOwnedRun(
    tx: Prisma.TransactionClient,
    teamId: string,
    id: string,
  ) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "verification_runs"
      WHERE "id" = CAST(${id} AS uuid)
        AND "team_id" = CAST(${teamId} AS uuid)
      FOR UPDATE
    `);
    if (locked.length === 0) {
      throw new NotFoundException("Verification run was not found.");
    }
    return tx.verificationRun.findUniqueOrThrow({ where: { id } });
  }

  private serialize<T extends { events?: Array<{ sequence: bigint }> }>(
    row: T,
  ) {
    return {
      ...row,
      ...(row.events
        ? {
            events: row.events.map((event) => ({
              ...event,
              sequence: event.sequence.toString(),
            })),
          }
        : {}),
    };
  }

  private resolveIdempotent<
    T extends {
      requestSha256: string;
      requestSnapshot: Prisma.JsonValue;
    },
  >(existing: T, requestSha256: string): T {
    if (
      !matchesVerificationRequestIdentity(
        existing.requestSha256,
        existing.requestSnapshot,
        requestSha256,
      )
    ) {
      throw new ConflictException(
        "Idempotency key is already bound to a different verification request.",
      );
    }
    return existing;
  }
}
