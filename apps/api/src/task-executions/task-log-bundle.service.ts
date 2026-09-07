import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service.js";
import { redactText } from "../observability/observability.service.js";

const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|private[._-]?key|client[._-]?secret|secret[._-]?access[._-]?key|access[._-]?key[._-]?id|(?:session|profile)[._-]?(?:id|key|token))$/iu;

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
    const runEventWatermarks: Record<string, string | null> =
      Object.fromEntries(task.executionRuns.map((run) => [run.id, null]));
    for (const event of runEvents) {
      runEventWatermarks[event.runId] = event.sequence.toString();
    }
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
    return { bundle };
  }
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
