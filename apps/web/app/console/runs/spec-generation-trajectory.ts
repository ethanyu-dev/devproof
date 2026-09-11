import type { RunTrajectoryRecord } from "@devproof/contracts";
import { displayLabel } from "../../../lib/display-text";
import type { TaskDetail, TaskEvent } from "./task-types";

export function projectSpecGenerationTrajectory(
  detail: TaskDetail,
  events: TaskEvent[],
): RunTrajectoryRecord[] {
  const analysis = detail.stages.find(
    (stage) => stage.type === "SPEC_ANALYSIS",
  );
  const eventRecords = events
    .filter((event) => specGenerationEvent(event, analysis?.status))
    .map((event): RunTrajectoryRecord => {
      if (event.kind.startsWith("agent.")) {
        return projectAgentTaskEvent(event);
      }
      const payload = isRecord(event.payload) ? event.payload : {};
      const attemptNumber =
        typeof payload.attemptNumber === "number" && payload.attemptNumber > 0
          ? Math.floor(payload.attemptNumber)
          : null;
      return {
        actor: event.actor,
        attemptNumber,
        callId: null,
        completedAt: event.occurredAt,
        durationMs: null,
        error: errorMessage(payload.error),
        id: `task:${event.sequence}`,
        input: event.kind === "task.created" ? payload : null,
        kind: "INPUT",
        lane: "INPUT",
        metadata: { scope: "TASK", taskEventSequence: event.sequence },
        output: event.kind === "task.created" ? null : payload,
        segmentId: null,
        sequence: event.sequence,
        startedAt: event.occurredAt,
        status: taskEventStatus(event.kind),
        step: null,
        title: displayLabel(event.kind),
      };
    });
  const attemptRecords = (analysis?.attempts ?? []).map(
    (attempt): RunTrajectoryRecord => {
      const startedAt = attempt.startedAt ?? detail.createdAt;
      const completedAt = attempt.finishedAt;
      const durationMs = completedAt
        ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
        : null;
      return {
        actor: "SPEC_ANALYSIS_WORKER",
        attemptNumber: attempt.number,
        callId: null,
        completedAt,
        durationMs,
        error: trajectoryError(attempt.error),
        id: `analysis:${attempt.id}`,
        input: detail.input,
        kind: "RUNTIME",
        lane: "INPUT",
        metadata: { stage: "SPEC_ANALYSIS", status: attempt.status },
        output: attempt.result,
        segmentId: null,
        sequence: "0",
        startedAt,
        status: trajectoryStatus(attempt.status),
        step: null,
        title: `Spec 生成 · Attempt ${attempt.number}`,
      };
    },
  );
  return [...eventRecords, ...attemptRecords]
    .sort(
      (left, right) =>
        Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
        (BigInt(left.sequence) < BigInt(right.sequence)
          ? -1
          : BigInt(left.sequence) > BigInt(right.sequence)
            ? 1
            : left.id.localeCompare(right.id)),
    )
    .map((record, index) => ({ ...record, sequence: String(index + 1) }));
}

function specGenerationEvent(event: TaskEvent, analysisStatus?: string) {
  if (
    [
      "task.created",
      "task.rerun.created",
      "task.rerun.linked",
      "task.spec.shadow_compared",
    ].includes(event.kind)
  ) {
    return true;
  }
  const payload = isRecord(event.payload) ? event.payload : {};
  if (event.kind.startsWith("agent.") && payload.stage === "SPEC_ANALYSIS") {
    return true;
  }
  if (
    event.kind.startsWith("task.stage.") &&
    payload.stage === "SPEC_ANALYSIS"
  ) {
    return true;
  }
  return (
    analysisStatus !== "SUCCEEDED" &&
    ["task.cancel_requested", "task.completed", "task.timed_out"].includes(
      event.kind,
    )
  );
}

function projectAgentTaskEvent(event: TaskEvent): RunTrajectoryRecord {
  const payload = isRecord(event.payload) ? event.payload : {};
  const durationMs =
    typeof payload.durationMs === "number" && payload.durationMs >= 0
      ? Math.floor(payload.durationMs)
      : null;
  const completed = /(?:completed|failed|generated|validation_failed)$/u.test(
    event.kind,
  );
  // These are separate events, not merged operations. Subtracting duration
  // moves a completion before its start event and corrupts chronology.
  const startedAt = event.occurredAt;
  const isAnalysis = event.kind === "agent.analysis.completed";
  const isModel = event.kind.startsWith("agent.model.");
  const isTool = event.kind.startsWith("agent.tool.");
  const input =
    payload.inputPreview ??
    (isAnalysis
      ? null
      : event.kind === "agent.segment.started"
        ? payload
        : null);
  const output = isAnalysis
    ? {
        sourceRefs: payload.sourceRefs ?? [],
        summary: payload.summary ?? null,
      }
    : (payload.outputPreview ??
      (event.kind === "agent.spec.generated"
        ? {
            caseCount: payload.caseCount,
            sourceRefs: payload.sourceRefs,
          }
        : null));
  return {
    actor: event.actor,
    attemptNumber:
      typeof payload.attemptNumber === "number" && payload.attemptNumber > 0
        ? Math.floor(payload.attemptNumber)
        : null,
    callId: typeof payload.callId === "string" ? payload.callId : null,
    completedAt: completed ? event.occurredAt : null,
    durationMs,
    error:
      typeof payload.errorMessage === "string" ? payload.errorMessage : null,
    id: `task:${event.sequence}`,
    input,
    kind: isAnalysis
      ? "ANALYSIS"
      : isModel
        ? "MODEL"
        : isTool
          ? "TOOL"
          : "RUNTIME",
    lane: isAnalysis
      ? "ANALYSIS"
      : isModel
        ? "MODEL"
        : isTool
          ? "TOOLS"
          : "INPUT",
    metadata: {
      ...(typeof payload.model === "string" ? { model: payload.model } : {}),
      ...(typeof payload.provider === "string"
        ? { provider: payload.provider }
        : {}),
      ...(payload.usage ? { usage: payload.usage } : {}),
      stage: "SPEC_ANALYSIS",
      stageAttemptId: payload.stageAttemptId ?? null,
      taskEventSequence: event.sequence,
    },
    output,
    segmentId: typeof payload.segmentId === "string" ? payload.segmentId : null,
    sequence: event.sequence,
    startedAt,
    status:
      ["FAILED", "TIMED_OUT", "CANCELLED"].includes(String(payload.status)) ||
      /failed|validation_failed/iu.test(event.kind)
        ? "FAILED"
        : payload.status === "WAITING_HUMAN"
          ? "WAITING_HUMAN"
          : /started/iu.test(event.kind)
            ? "RUNNING"
            : "SUCCEEDED",
    step:
      typeof payload.step === "number" && payload.step > 0
        ? Math.floor(payload.step)
        : null,
    title: agentEventTitle(event.kind, payload),
  };
}

export function agentEventTitle(
  kind: string,
  payload: Record<string, unknown>,
) {
  if (kind === "agent.analysis.completed") return "Agent 分析";
  if (kind.startsWith("agent.model.")) {
    return `模型 ${displayLabel(kind.split(".").at(-1) ?? kind)}`;
  }
  if (kind.startsWith("agent.tool.")) {
    const name = typeof payload.name === "string" ? payload.name : "Tool";
    return `${name} · ${displayLabel(kind.split(".").at(-1) ?? kind)}`;
  }
  if (kind === "agent.spec.validation_failed") return "Spec 校验失败";
  if (kind === "agent.spec.generated") return "Spec 已生成";
  if (kind === "agent.segment.started") return "Spec Agent 开始";
  if (kind === "agent.segment.completed") return "Spec Agent 完成";
  return displayLabel(kind);
}

function trajectoryError(error: unknown) {
  if (error === null || error === undefined) return null;
  return errorMessage(error) ?? prettyValue(error);
}

function trajectoryStatus(status: string): RunTrajectoryRecord["status"] {
  if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(status)) return "FAILED";
  if (status === "SUCCEEDED") return "SUCCEEDED";
  if (["PENDING", "RUNNING"].includes(status)) return "RUNNING";
  return "INFO";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function prettyValue(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
function errorMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isRecord(value) || typeof value.message !== "string") return null;
  return typeof value.code === "string"
    ? `${value.code}: ${value.message}`
    : value.message;
}

function taskEventStatus(kind: string): RunTrajectoryRecord["status"] {
  if (/failed|cancelled|timed_out/iu.test(kind)) return "FAILED";
  if (/waiting/iu.test(kind)) return "WAITING_HUMAN";
  if (/started|queued/iu.test(kind)) return "RUNNING";
  if (/succeeded|completed|created|provided|linked/iu.test(kind))
    return "SUCCEEDED";
  return "INFO";
}
