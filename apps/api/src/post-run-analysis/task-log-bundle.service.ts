import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service.js";
import { redactText } from "../observability/observability.service.js";

const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|private[._-]?key|client[._-]?secret|secret[._-]?access[._-]?key|access[._-]?key[._-]?id|(?:session|profile)[._-]?(?:id|key|token))$/iu;

export const POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD =
  "_structuredEvidenceIndex";
export const POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD =
  "_structuredEvidenceStorageKey";

export type StructuredEvidenceIndexEntry = {
  byteSize: number;
  offset: number;
  sha256: string;
};

export type PreparedObjectStream = {
  byteSize: number;
  openStream: () => Readable;
  sha256: string;
};

const ANALYSIS_CANDIDATE_LIMIT = 64;
const ANALYSIS_CANDIDATE_PER_RUN_LIMIT = 6;
const OBJECT_STREAM_CHUNK_BYTES = 64 * 1_024;
const UNLOCATED_ANALYSIS_CANDIDATE_LIMIT = 12;
const SLOW_OPERATION_THRESHOLD_MS = 15_000;
const ANOMALOUS_EVENT_KIND =
  /(?:fail|error|timeout|timed[_-]?out|lost|cancel|expire|reject|disconnect|crash|ambiguous|retry)/iu;
const ANOMALOUS_STATUS = new Set([
  "CANCELLED",
  "ERROR",
  "FAILED",
  "LOST",
  "TIMED_OUT",
]);

@Injectable()
export class TaskLogBundleService {
  constructor(private readonly prisma: PrismaService) {}

  async buildForCapture(teamId: string, taskExecutionId: string) {
    return this.buildSnapshot(teamId, taskExecutionId);
  }

  async build(teamId: string, taskExecutionId: string) {
    const snapshot = await this.buildSnapshot(teamId, taskExecutionId);
    const body = Buffer.from(stableJson(snapshot.bundle));
    const sha256 = createHash("sha256").update(body).digest("hex");
    const evidenceArchive = buildStructuredEvidenceArchive(
      snapshot.bundle,
      [...snapshot.evidenceRefs].sort(),
    );
    return {
      ...snapshot,
      body,
      byteSize: body.byteLength,
      evidenceBody: evidenceArchive.body,
      evidenceIndex: evidenceArchive.index,
      sha256,
    };
  }

  private async buildSnapshot(teamId: string, taskExecutionId: string) {
    const task = await this.prisma.taskExecution.findFirst({
      include: {
        analysisSources: { orderBy: { createdAt: "asc" } },
        caseExecutions: {
          include: { deployment: true, testCase: true },
          orderBy: [{ createdAt: "asc" }, { executionOrdinal: "asc" }],
        },
        deployments: { orderBy: { createdAt: "asc" } },
        executionRuns: {
          include: {
            attempts: { orderBy: { number: "asc" } },
            browserExecutions: {
              include: {
                runtimeSession: {
                  select: {
                    closedAt: true,
                    commands: {
                      orderBy: { createdAt: "asc" },
                      select: {
                        commandType: true,
                        completedAt: true,
                        createdAt: true,
                        deadlineAt: true,
                        dispatchedAt: true,
                        error: true,
                        id: true,
                        payload: true,
                        result: true,
                        source: true,
                        status: true,
                      },
                    },
                    createdAt: true,
                    id: true,
                    events: {
                      orderBy: { occurredAt: "asc" },
                      select: {
                        createdAt: true,
                        id: true,
                        kind: true,
                        occurredAt: true,
                        payload: true,
                      },
                    },
                    lastError: true,
                    openedAt: true,
                    protocolMajor: true,
                    protocolMinor: true,
                    runtime: { select: { id: true, name: true, status: true } },
                    status: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
            criterionResults: { orderBy: { criterionId: "asc" } },
            evidences: {
              include: {
                runtimeArtifact: {
                  select: {
                    byteSize: true,
                    contentType: true,
                    id: true,
                    kind: true,
                    metadata: true,
                    sessionId: true,
                    sha256: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
            interventions: { orderBy: { requestedAt: "asc" } },
            tasks: {
              orderBy: { createdAt: "asc" },
              select: {
                activeOperation: true,
                attemptId: true,
                capability: true,
                createdAt: true,
                deadlineAt: true,
                error: true,
                finishedAt: true,
                id: true,
                lastHeartbeatAt: true,
                provider: true,
                result: true,
                startedAt: true,
                status: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        specificationSnapshots: {
          include: { cases: { orderBy: { position: "asc" } } },
          orderBy: { generatedAt: "asc" },
        },
        stages: {
          include: { attempts: { orderBy: { number: "asc" } } },
          orderBy: { createdAt: "asc" },
        },
      },
      where: { id: taskExecutionId, teamId },
    });
    if (!task) {
      throw new NotFoundException(
        `Task execution ${taskExecutionId} was not found.`,
      );
    }

    const [taskEvents, runEvents, toolInvocations] = await Promise.all([
      this.prisma.taskExecutionEvent.findMany({
        orderBy: { sequence: "asc" },
        where: { taskExecutionId, teamId },
      }),
      this.prisma.runEvent.findMany({
        orderBy: [{ runId: "asc" }, { sequence: "asc" }],
        where: { run: { taskExecutionId }, teamId },
      }),
      this.prisma.toolInvocation.findMany({
        orderBy: { startedAt: "asc" },
        select: {
          clientName: true,
          clientVersion: true,
          completedAt: true,
          durationMs: true,
          errorCode: true,
          errorMessage: true,
          id: true,
          inputSummary: true,
          outputSummary: true,
          requestId: true,
          spanId: true,
          startedAt: true,
          status: true,
          toolName: true,
          traceId: true,
          transport: true,
        },
        where: { teamId, traceId: task.traceId },
      }),
    ]);

    const terminalBrowserStatuses = new Set([
      "RELEASED",
      "FAILED",
      "LOST",
      "TIMED_OUT",
    ]);
    const browserExecutions = task.executionRuns.flatMap(
      (run) => run.browserExecutions,
    );
    const missingArtifactCount = task.executionRuns.reduce(
      (total, run) =>
        total +
        run.evidences.filter(
          (evidence) =>
            evidence.externalId.startsWith("artifact://") &&
            !evidence.runtimeArtifact,
        ).length,
      0,
    );
    const completeness = {
      browserExecutionsFinalized: browserExecutions.every((execution) =>
        terminalBrowserStatuses.has(execution.status),
      ),
      durableEvents: true,
      evidenceMetadata: missingArtifactCount === 0,
      missingArtifactCount,
      processLogs: false,
      processLogsReason:
        "No external structured-log adapter is configured; durable correlated events are included.",
    };
    const taskEventWatermark = taskEvents.at(-1)?.sequence.toString() ?? null;
    const attemptNumberById = new Map(
      task.executionRuns.flatMap((run) =>
        run.attempts.map((attempt) => [attempt.id, attempt.number] as const),
      ),
    );
    const browserExecutionByAttemptId = new Map(
      task.executionRuns.flatMap((run) =>
        run.browserExecutions.map(
          (execution) => [execution.attemptId, execution] as const,
        ),
      ),
    );
    const browserExecutionByRunAndSessionId = new Map(
      task.executionRuns.flatMap((run) =>
        run.browserExecutions.flatMap((execution) =>
          execution.runtimeSession
            ? ([
                [`${run.id}:${execution.runtimeSession.id}`, execution],
              ] as const)
            : [],
        ),
      ),
    );
    const runEventWatermarks: Record<string, string | null> =
      Object.fromEntries(task.executionRuns.map((run) => [run.id, null]));
    for (const event of runEvents) {
      runEventWatermarks[event.runId] = event.sequence.toString();
    }
    const evidenceRefs = new Set<string>([
      ...taskEvents.map((event) => `task-event://${event.id}`),
      ...runEvents.map((event) => `run-event://${event.id}`),
      ...toolInvocations.map(
        (invocation) => `tool-invocation://${invocation.id}`,
      ),
      ...task.executionRuns.flatMap((run) =>
        run.browserExecutions.flatMap((execution) => [
          ...(execution.runtimeSession?.commands.map(
            (command) => `browser-command://${command.id}`,
          ) ?? []),
          ...(execution.runtimeSession?.events.map(
            (event) => `browser-event://${event.id}`,
          ) ?? []),
        ]),
      ),
      ...task.analysisSources.map((source) => source.externalId),
      ...task.executionRuns.flatMap((run) =>
        run.evidences.map((evidence) => evidence.externalId),
      ),
    ]);
    const evidenceLocations = [
      ...runEvents.map((event) => {
        const execution = event.attemptId
          ? browserExecutionByAttemptId.get(event.attemptId)
          : undefined;
        return {
          attemptNumber: event.attemptId
            ? (attemptNumberById.get(event.attemptId) ?? null)
            : null,
          evidenceRef: `run-event://${event.id}`,
          runId: event.runId,
          runtimeId: execution ? browserRuntimeId(execution) : null,
        };
      }),
      ...task.executionRuns.flatMap((run) => [
        ...run.evidences.map((evidence) => {
          const execution = evidence.runtimeArtifact?.sessionId
            ? browserExecutionByRunAndSessionId.get(
                `${run.id}:${evidence.runtimeArtifact.sessionId}`,
              )
            : undefined;
          return {
            attemptNumber: evidence.attemptId
              ? (attemptNumberById.get(evidence.attemptId) ?? null)
              : null,
            evidenceRef: evidence.externalId,
            runId: run.id,
            runtimeId: execution ? browserRuntimeId(execution) : null,
          };
        }),
        ...run.browserExecutions.flatMap((execution) => {
          const attemptNumber =
            attemptNumberById.get(execution.attemptId) ?? null;
          const location = {
            attemptNumber,
            runId: run.id,
            runtimeId: browserRuntimeId(execution),
          };
          return [
            ...(execution.runtimeSession?.commands.map((command) => ({
              ...location,
              evidenceRef: `browser-command://${command.id}`,
            })) ?? []),
            ...(execution.runtimeSession?.events.map((event) => ({
              ...location,
              evidenceRef: `browser-event://${event.id}`,
            })) ?? []),
          ];
        }),
      ]),
    ].sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef));
    const bundle = sanitizeLogBundleValueInPlace({
      capturedAt: new Date().toISOString(),
      completeness,
      schemaVersion: "devproof.task-logs.v2",
      task: {
        ...task,
        executionRuns: task.executionRuns.map((run) => ({
          ...run,
          browserExecutions: run.browserExecutions.map((execution) => ({
            ...execution,
            runtimeSession: execution.runtimeSession
              ? {
                  ...execution.runtimeSession,
                  id: "[REDACTED]",
                  commands: execution.runtimeSession.commands.map(
                    (command) => ({
                      ...command,
                      evidenceRef: `browser-command://${command.id}`,
                    }),
                  ),
                  events: execution.runtimeSession.events.map((event) => ({
                    ...event,
                    evidenceRef: `browser-event://${event.id}`,
                  })),
                }
              : null,
          })),
        })),
        taskEvents: taskEvents.map((event) => ({
          ...event,
          evidenceRef: `task-event://${event.id}`,
        })),
        toolInvocations: toolInvocations.map((invocation) => ({
          ...invocation,
          evidenceRef: `tool-invocation://${invocation.id}`,
        })),
      },
      runEvents: runEvents.map((event) => ({
        ...event,
        evidenceRef: `run-event://${event.id}`,
      })),
      watermarks: {
        runEvents: runEventWatermarks,
        taskEvents: taskEventWatermark,
      },
    });
    const analysisSynopsis = buildAnalysisSynopsis(
      bundle,
      evidenceLocations,
      completeness,
    );
    const manifest = sanitizeLogBundleValueInPlace({
      analysisSynopsis,
      evidenceLocations,
      evidenceRefs: [...evidenceRefs].sort(),
      eventCounts: {
        runEvents: countBy(runEvents, (event) => event.kind),
        taskEvents: countBy(taskEvents, (event) => event.kind),
        toolInvocations: countBy(
          toolInvocations,
          (invocation) => invocation.status,
        ),
      },
      runs: task.executionRuns.map((run) => ({
        attempts: run.attempts.map((attempt) => ({
          attemptId: attempt.id,
          error: attempt.error,
          failureClass: attempt.failureClass,
          finishedAt: attempt.finishedAt,
          number: attempt.number,
          startedAt: attempt.startedAt,
          status: attempt.status,
        })),
        browserExecutions: run.browserExecutions.map((execution) => ({
          attemptId: execution.attemptId,
          browserExecutionId: execution.id,
          error: execution.error,
          finishedAt: execution.finishedAt,
          runtimeId:
            execution.runtimeSession?.runtime.id ?? execution.targetRuntimeId,
          runtimeName: execution.runtimeSession?.runtime.name ?? null,
          runtimeSession: execution.runtimeSession
            ? {
                commandCount: execution.runtimeSession.commands.length,
                failedCommands: execution.runtimeSession.commands
                  .filter((command) => command.status === "FAILED")
                  .map((command) => ({
                    commandId: command.id,
                    commandType: command.commandType,
                    error: command.error,
                    evidenceRef: `browser-command://${command.id}`,
                  })),
                lastError: execution.runtimeSession.lastError,
                runtimeSessionId: execution.runtimeSession.id,
                status: execution.runtimeSession.status,
              }
            : null,
          startedAt: execution.startedAt,
          status: execution.status,
        })),
        currentAttemptNumber: run.currentAttemptNumber,
        executionDisposition: run.executionDisposition,
        finishedAt: run.finishedAt,
        lifecycle: run.lifecycle,
        maxAttempts: run.maxAttempts,
        runId: run.id,
        runtimeTasks: run.tasks.map((runtimeTask) => ({
          activeOperation: runtimeTask.activeOperation,
          attemptId: runtimeTask.attemptId,
          capability: runtimeTask.capability,
          error: runtimeTask.error,
          finishedAt: runtimeTask.finishedAt,
          runtimeTaskId: runtimeTask.id,
          startedAt: runtimeTask.startedAt,
          status: runtimeTask.status,
        })),
        startedAt: run.startedAt,
        verdict: run.verdict,
      })),
      schemaVersion: "devproof.execution-manifest.v2",
      stages: task.stages.map((stage) => ({
        attempts: stage.attempts.map((attempt) => ({
          error: attempt.error,
          finishedAt: attempt.finishedAt,
          number: attempt.number,
          stageAttemptId: attempt.id,
          startedAt: attempt.startedAt,
          status: attempt.status,
        })),
        currentAttemptNumber: stage.currentAttemptNumber,
        finishedAt: stage.finishedAt,
        lastError: stage.lastError,
        maxAttempts: stage.maxAttempts,
        stageId: stage.id,
        startedAt: stage.startedAt,
        status: stage.status,
        type: stage.type,
        waitingReason: stage.waitingReason,
      })),
      task: {
        currentStage: task.currentStage,
        executionDisposition: task.executionDisposition,
        finishedAt: task.finishedAt,
        lifecycle: task.lifecycle,
        startedAt: task.startedAt,
        taskExecutionId: task.id,
        traceId: task.traceId,
        verdict: task.verdict,
      },
    }) as Record<string, unknown>;
    return {
      bundle,
      completeness,
      evidenceRefs,
      manifest,
      schemaVersion: "devproof.task-logs.v2" as const,
    };
  }
}

function countBy<T>(items: readonly T[], key: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function browserRuntimeId(execution: {
  runtimeSession: { runtime: { id: string } } | null;
  targetRuntimeId: string | null;
}) {
  return execution.runtimeSession?.runtime.id ?? execution.targetRuntimeId;
}

function stableJson(value: unknown) {
  return JSON.stringify(value);
}

export function prepareJsonObjectStream(value: unknown): PreparedObjectStream {
  const hash = createHash("sha256");
  let byteSize = 0;
  for (const chunk of bufferedTextChunks(jsonChunks(value))) {
    byteSize += Buffer.byteLength(chunk);
    hash.update(chunk);
  }
  return {
    byteSize,
    openStream: () =>
      Readable.from(bufferedTextChunks(jsonChunks(value)), {
        encoding: "utf8",
      }),
    sha256: hash.digest("hex"),
  };
}

function* jsonChunks(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) yield ",";
      yield* jsonChunks(value[index]);
    }
    yield "]";
    return;
  }
  if (value && typeof value === "object") {
    yield "{";
    let index = 0;
    for (const [key, child] of Object.entries(value)) {
      if (index > 0) yield ",";
      yield JSON.stringify(key);
      yield ":";
      yield* jsonChunks(child);
      index += 1;
    }
    yield "}";
    return;
  }
  yield JSON.stringify(value) ?? "null";
}

export function prepareStructuredEvidenceArchiveStream(
  bundleValue: unknown,
  evidenceRefs: string[],
): PreparedObjectStream & {
  index: Record<string, StructuredEvidenceIndexEntry>;
} {
  const recordsByEvidenceRef = collectStructuredEvidenceRecords(bundleValue);
  const index: Record<string, StructuredEvidenceIndexEntry> = {};
  const archiveHash = createHash("sha256");
  let offset = 0;
  for (const evidenceRef of evidenceRefs) {
    const serialized = serializedEvidenceRecord(
      recordsByEvidenceRef,
      evidenceRef,
    );
    const byteSize = Buffer.byteLength(serialized);
    index[evidenceRef] = {
      byteSize,
      offset,
      sha256: createHash("sha256").update(serialized).digest("hex"),
    };
    archiveHash.update(serialized);
    archiveHash.update("\n");
    offset += byteSize + 1;
  }
  return {
    byteSize: offset,
    index,
    openStream: () =>
      Readable.from(
        bufferedTextChunks(
          evidenceArchiveChunks(recordsByEvidenceRef, evidenceRefs),
        ),
        { encoding: "utf8" },
      ),
    sha256: archiveHash.digest("hex"),
  };
}

function* bufferedTextChunks(chunks: Iterable<string>) {
  let buffered: string[] = [];
  let bufferedBytes = 0;
  for (const chunk of chunks) {
    const chunkBytes = Buffer.byteLength(chunk);
    if (
      bufferedBytes > 0 &&
      bufferedBytes + chunkBytes > OBJECT_STREAM_CHUNK_BYTES
    ) {
      yield buffered.join("");
      buffered = [];
      bufferedBytes = 0;
    }
    if (chunkBytes >= OBJECT_STREAM_CHUNK_BYTES) {
      yield chunk;
      continue;
    }
    buffered.push(chunk);
    bufferedBytes += chunkBytes;
  }
  if (bufferedBytes > 0) yield buffered.join("");
}

function* evidenceArchiveChunks(
  recordsByEvidenceRef: Map<string, unknown[]>,
  evidenceRefs: string[],
) {
  for (const evidenceRef of evidenceRefs) {
    yield serializedEvidenceRecord(recordsByEvidenceRef, evidenceRef);
    yield "\n";
  }
}

function serializedEvidenceRecord(
  recordsByEvidenceRef: Map<string, unknown[]>,
  evidenceRef: string,
) {
  const records = recordsByEvidenceRef.get(evidenceRef);
  if (!records?.length) {
    throw new Error(
      `Evidence ${evidenceRef} is missing from the captured log bundle.`,
    );
  }
  return JSON.stringify(
    records.length === 1 ? records[0] : { evidenceRef, occurrences: records },
  );
}

export function buildStructuredEvidenceArchive(
  bundleValue: unknown,
  evidenceRefs: string[],
) {
  const recordsByEvidenceRef = collectStructuredEvidenceRecords(bundleValue);
  const index: Record<string, StructuredEvidenceIndexEntry> = {};
  let offset = 0;
  for (const evidenceRef of evidenceRefs) {
    const serialized = serializedEvidenceRecord(
      recordsByEvidenceRef,
      evidenceRef,
    );
    const byteSize = Buffer.byteLength(serialized);
    index[evidenceRef] = {
      byteSize,
      offset,
      sha256: createHash("sha256").update(serialized).digest("hex"),
    };
    offset += byteSize + 1;
  }
  const body = Buffer.allocUnsafe(offset);
  for (const evidenceRef of evidenceRefs) {
    const entry = index[evidenceRef]!;
    const bytesWritten = body.write(
      serializedEvidenceRecord(recordsByEvidenceRef, evidenceRef),
      entry.offset,
      entry.byteSize,
      "utf8",
    );
    if (bytesWritten !== entry.byteSize) {
      throw new Error(`Evidence ${evidenceRef} changed during serialization.`);
    }
    body[entry.offset + entry.byteSize] = 0x0a;
  }
  return { body, index };
}

function collectStructuredEvidenceRecords(bundleValue: unknown) {
  const bundle = recordValue(bundleValue);
  const task = recordValue(bundle.task);
  const records = new Map<string, unknown[]>();
  const collect = (items: unknown[]) => {
    for (const item of items) {
      const value = recordValue(item);
      const evidenceRef =
        typeof value.evidenceRef === "string"
          ? value.evidenceRef
          : typeof value.externalId === "string"
            ? value.externalId
            : null;
      if (!evidenceRef) continue;
      const matches = records.get(evidenceRef) ?? [];
      matches.push(item);
      records.set(evidenceRef, matches);
    }
  };
  for (const collection of [
    arrayValue(bundle.runEvents),
    arrayValue(task.analysisSources),
    arrayValue(task.taskEvents),
    arrayValue(task.toolInvocations),
  ]) {
    collect(collection);
  }
  for (const runValue of arrayValue(task.executionRuns)) {
    const run = recordValue(runValue);
    collect(arrayValue(run.evidences));
    for (const executionValue of arrayValue(run.browserExecutions)) {
      const session = recordValue(recordValue(executionValue).runtimeSession);
      collect(arrayValue(session.commands));
      collect(arrayValue(session.events));
    }
  }
  return records;
}

export function buildAnalysisSynopsis(
  bundleValue: unknown,
  evidenceLocationsValue: unknown,
  completenessValue: unknown,
) {
  const bundle = recordValue(bundleValue);
  const task = recordValue(bundle.task);
  const locations = new Map(
    arrayValue(evidenceLocationsValue).flatMap((item) => {
      const location = recordValue(item);
      return typeof location.evidenceRef === "string"
        ? [[location.evidenceRef, location] as const]
        : [];
    }),
  );
  const candidates: Array<Record<string, unknown>> = [];
  const addCandidate = (
    itemValue: unknown,
    signal: string,
    priority: number,
    occurredAtValue?: unknown,
  ) => {
    const item = recordValue(itemValue);
    const evidenceRef =
      typeof item.evidenceRef === "string"
        ? item.evidenceRef
        : typeof item.externalId === "string"
          ? item.externalId
          : null;
    if (!evidenceRef) return;
    const location = locations.get(evidenceRef);
    candidates.push({
      attemptNumber: positiveIntegerValue(location?.attemptNumber),
      evidenceRef,
      occurredAt: isoDateValue(
        occurredAtValue ??
          item.occurredAt ??
          item.completedAt ??
          item.createdAt ??
          item.startedAt,
      ),
      priority,
      runId: stringValue(location?.runId),
      runtimeId: stringValue(location?.runtimeId),
      signal,
      summary: candidateSummary(item),
    });
  };

  for (const item of arrayValue(task.taskEvents)) {
    const event = recordValue(item);
    if (ANOMALOUS_EVENT_KIND.test(stringValue(event.kind) ?? "")) {
      addCandidate(event, "TASK_EVENT_ANOMALY", 90);
    }
  }
  for (const item of arrayValue(bundle.runEvents)) {
    const event = recordValue(item);
    if (ANOMALOUS_EVENT_KIND.test(stringValue(event.kind) ?? "")) {
      addCandidate(event, "RUN_EVENT_ANOMALY", 92);
    }
  }
  for (const item of arrayValue(task.toolInvocations)) {
    const invocation = recordValue(item);
    if (ANOMALOUS_STATUS.has(stringValue(invocation.status) ?? "")) {
      addCandidate(invocation, "TOOL_INVOCATION_FAILED", 95);
    } else if (
      typeof invocation.durationMs === "number" &&
      invocation.durationMs >= SLOW_OPERATION_THRESHOLD_MS
    ) {
      addCandidate(invocation, "SLOW_TOOL_INVOCATION", 70);
    }
  }
  for (const runValue of arrayValue(task.executionRuns)) {
    const run = recordValue(runValue);
    const runFailed =
      ANOMALOUS_STATUS.has(stringValue(run.lifecycle) ?? "") ||
      ![null, "PASSED"].includes(stringValue(run.verdict));
    for (const executionValue of arrayValue(run.browserExecutions)) {
      const execution = recordValue(executionValue);
      const session = recordValue(execution.runtimeSession);
      for (const item of arrayValue(session.commands)) {
        const command = recordValue(item);
        if (ANOMALOUS_STATUS.has(stringValue(command.status) ?? "")) {
          addCandidate(command, "BROWSER_COMMAND_FAILED", 100);
        } else if (
          durationBetween(command.dispatchedAt, command.completedAt) >=
          SLOW_OPERATION_THRESHOLD_MS
        ) {
          addCandidate(command, "SLOW_BROWSER_COMMAND", 72);
        }
      }
      for (const item of arrayValue(session.events)) {
        const event = recordValue(item);
        if (ANOMALOUS_EVENT_KIND.test(stringValue(event.kind) ?? "")) {
          addCandidate(event, "BROWSER_EVENT_ANOMALY", 98);
        }
      }
    }
    if (runFailed) {
      for (const evidenceValue of arrayValue(run.evidences)) {
        const evidence = recordValue(evidenceValue);
        const artifact = recordValue(evidence.runtimeArtifact);
        if (
          ["CONSOLE", "DOM", "NETWORK"].includes(
            stringValue(artifact.kind) ?? stringValue(evidence.kind) ?? "",
          )
        ) {
          addCandidate(evidence, "FAILED_RUN_ARTIFACT", 80);
        }
      }
    }
  }

  const uniqueByEvidenceRef = new Map<string, Record<string, unknown>>();
  for (const candidate of candidates.sort(compareAnalysisCandidates)) {
    const evidenceRef = stringValue(candidate.evidenceRef);
    if (evidenceRef && !uniqueByEvidenceRef.has(evidenceRef)) {
      uniqueByEvidenceRef.set(evidenceRef, candidate);
    }
  }
  const unique = [...uniqueByEvidenceRef.values()];
  const selected: Array<Record<string, unknown>> = [];
  const perRunCounts = new Map<string, number>();
  let unlocatedCount = 0;
  for (const candidate of unique) {
    if (selected.length >= ANALYSIS_CANDIDATE_LIMIT) break;
    const runId = stringValue(candidate.runId);
    if (!runId) {
      if (unlocatedCount >= UNLOCATED_ANALYSIS_CANDIDATE_LIMIT) continue;
      unlocatedCount += 1;
    } else {
      const count = perRunCounts.get(runId) ?? 0;
      if (count >= ANALYSIS_CANDIDATE_PER_RUN_LIMIT) continue;
      perRunCounts.set(runId, count + 1);
    }
    selected.push(candidate);
  }
  const taskVerdict = stringValue(task.verdict);
  const completeness = recordValue(completenessValue);
  const incompleteReasons = [
    ...(completeness.browserExecutionsFinalized === true
      ? []
      : ["BROWSER_EXECUTIONS_NOT_FINALIZED"]),
    ...(completeness.durableEvents === true ? [] : ["DURABLE_EVENTS_MISSING"]),
    ...(completeness.evidenceMetadata === true
      ? []
      : ["EVIDENCE_METADATA_INCOMPLETE"]),
  ];
  const completenessSufficient = incompleteReasons.length === 0;
  return {
    candidateCount: unique.length,
    candidateReasonCounts: countBy(unique, (candidate) =>
      String(candidate.signal),
    ),
    candidates: selected,
    cleanPass:
      taskVerdict === "PASSED" && unique.length === 0 && completenessSufficient,
    completenessSufficient,
    incompleteReasons,
    selectedCandidateCount: selected.length,
    strategy: "failure-first-v1",
    truncated: selected.length < unique.length,
  };
}

function compareAnalysisCandidates(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  const priority = Number(right.priority) - Number(left.priority);
  if (priority) return priority;
  return (stringValue(right.occurredAt) ?? "").localeCompare(
    stringValue(left.occurredAt) ?? "",
  );
}

function candidateSummary(value: Record<string, unknown>) {
  const details =
    value.error ??
    value.errorMessage ??
    value.lastError ??
    value.result ??
    value.payload ??
    value.outputSummary ??
    value.status ??
    value.kind ??
    "Anomalous terminal record";
  if (typeof details === "string") return details.slice(0, 600);
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return String(details).slice(0, 600);
  }
  const preview = Object.fromEntries(
    Object.entries(details as Record<string, unknown>)
      .slice(0, 12)
      .map(([key, child]) => [key, candidatePreviewValue(child)]),
  );
  return JSON.stringify(preview).slice(0, 600);
}

function candidatePreviewValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 240);
  if (value === null || ["number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (depth >= 2) return "[nested object]";
  if (value && typeof value === "object") {
    const child = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(child)
        .slice(0, 6)
        .map(([key, item]) => [key, candidatePreviewValue(item, depth + 1)]),
    );
  }
  return String(value);
}

function isoDateValue(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || !value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function durationBetween(startedAt: unknown, finishedAt: unknown) {
  const start = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  const finish = typeof finishedAt === "string" ? Date.parse(finishedAt) : NaN;
  return Number.isNaN(start) || Number.isNaN(finish)
    ? 0
    : Math.max(0, finish - start);
}

function positiveIntegerValue(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function sanitizeLogBundleValue(
  value: unknown,
  key = "",
  depth = 0,
): unknown {
  if (SENSITIVE_KEY.test(key) || /(?:^|\.)runtimeSession\.id$/iu.test(key)) {
    return "[REDACTED]";
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return redactText(value);
  if (value === null || ["number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (depth >= 20) return "[DEPTH_LIMIT]";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogBundleValue(item, key, depth + 1));
  }
  if (!value || typeof value !== "object") return String(value);
  const object = value as Record<string, unknown>;
  const namedSensitiveValue =
    typeof object.name === "string" && SENSITIVE_KEY.test(object.name);
  return Object.fromEntries(
    Object.entries(object).map(([childKey, child]) => [
      childKey,
      namedSensitiveValue && childKey.toLowerCase() === "value"
        ? "[REDACTED]"
        : sanitizeLogBundleValue(
            child,
            key ? `${key}.${childKey}` : childKey,
            depth + 1,
          ),
    ]),
  );
}

function sanitizeLogBundleValueInPlace(
  value: unknown,
  key = "",
  depth = 0,
): unknown {
  if (SENSITIVE_KEY.test(key) || /(?:^|\.)runtimeSession\.id$/iu.test(key)) {
    return "[REDACTED]";
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return redactText(value);
  if (value === null || ["number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (depth >= 20) return "[DEPTH_LIMIT]";
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = sanitizeLogBundleValueInPlace(
        value[index],
        key,
        depth + 1,
      );
    }
    return value;
  }
  if (!value || typeof value !== "object") return String(value);
  const object = value as Record<string, unknown>;
  const namedSensitiveValue =
    typeof object.name === "string" && SENSITIVE_KEY.test(object.name);
  for (const [childKey, child] of Object.entries(object)) {
    object[childKey] =
      namedSensitiveValue && childKey.toLowerCase() === "value"
        ? "[REDACTED]"
        : sanitizeLogBundleValueInPlace(
            child,
            key ? `${key}.${childKey}` : childKey,
            depth + 1,
          );
  }
  return object;
}
