import { createHash } from "node:crypto";

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

@Injectable()
export class TaskLogBundleService {
  constructor(private readonly prisma: PrismaService) {}

  async build(teamId: string, taskExecutionId: string) {
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
    const bundle = sanitizeLogBundleValue({
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
    const manifest = sanitizeLogBundleValue({
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
    const body = Buffer.from(stableJson(bundle));
    const sha256 = createHash("sha256").update(body).digest("hex");
    const evidenceArchive = buildStructuredEvidenceArchive(
      bundle,
      [...evidenceRefs].sort(),
    );
    return {
      body,
      bundle,
      byteSize: body.byteLength,
      completeness,
      evidenceBody: evidenceArchive.body,
      evidenceIndex: evidenceArchive.index,
      evidenceRefs,
      manifest,
      schemaVersion: "devproof.task-logs.v2" as const,
      sha256,
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
  return JSON.stringify(value, null, 2);
}

function buildStructuredEvidenceArchive(
  bundleValue: unknown,
  evidenceRefs: string[],
) {
  const chunks: Buffer[] = [];
  const index: Record<string, StructuredEvidenceIndexEntry> = {};
  let offset = 0;
  for (const evidenceRef of evidenceRefs) {
    const record = findStructuredEvidenceRecords(bundleValue, evidenceRef);
    if (record === null) {
      throw new Error(
        `Evidence ${evidenceRef} is missing from the captured log bundle.`,
      );
    }
    const body = Buffer.from(JSON.stringify(record));
    index[evidenceRef] = {
      byteSize: body.byteLength,
      offset,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    chunks.push(body, Buffer.from("\n"));
    offset += body.byteLength + 1;
  }
  return { body: Buffer.concat(chunks), index };
}

function findStructuredEvidenceRecords(
  bundleValue: unknown,
  evidenceRef: string,
): unknown | null {
  const bundle = recordValue(bundleValue);
  const task = recordValue(bundle.task);
  const matches: unknown[] = [];
  for (const collection of [
    arrayValue(bundle.runEvents),
    arrayValue(task.analysisSources),
    arrayValue(task.taskEvents),
    arrayValue(task.toolInvocations),
  ]) {
    matches.push(
      ...collection.filter((item) =>
        recordMatchesEvidenceRef(item, evidenceRef),
      ),
    );
  }
  for (const runValue of arrayValue(task.executionRuns)) {
    const run = recordValue(runValue);
    matches.push(
      ...arrayValue(run.evidences).filter((item) =>
        recordMatchesEvidenceRef(item, evidenceRef),
      ),
    );
    for (const executionValue of arrayValue(run.browserExecutions)) {
      const session = recordValue(recordValue(executionValue).runtimeSession);
      for (const collection of [
        arrayValue(session.commands),
        arrayValue(session.events),
      ]) {
        matches.push(
          ...collection.filter((item) =>
            recordMatchesEvidenceRef(item, evidenceRef),
          ),
        );
      }
    }
  }
  if (!matches.length) return null;
  return matches.length === 1
    ? matches[0]
    : { evidenceRef, occurrences: matches };
}

function recordMatchesEvidenceRef(value: unknown, evidenceRef: string) {
  const item = recordValue(value);
  return item.evidenceRef === evidenceRef || item.externalId === evidenceRef;
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
