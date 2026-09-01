import type {
  PostRunAnalysisEvent,
  PostRunAnalysisEventCategory,
} from "./task-types";

export const analysisEventFilters: Array<{
  key: PostRunAnalysisEventCategory;
  label: string;
}> = [
  { key: "KEY", label: "关键事件" },
  { key: "ERROR", label: "错误" },
  { key: "MODEL", label: "模型" },
  { key: "EVIDENCE", label: "证据" },
  { key: "ALL", label: "全部" },
];

const KEY_EVENT_KINDS = new Set([
  "analysis.attempt_deadline_exceeded",
  "analysis.attempts_exhausted",
  "analysis.bundle.captured",
  "analysis.completed",
  "analysis.configuration_failed",
  "analysis.deadline_exceeded",
  "analysis.executor.started",
  "analysis.failed",
  "analysis.report.generated",
  "analysis.report.validation_failed",
  "analysis.retry_queued",
  "analysis.retry_requested",
  "analysis.started",
  "analysis.superseded",
]);

const ERROR_EVENT_KINDS = new Set([
  "analysis.attempt_deadline_exceeded",
  "analysis.attempts_exhausted",
  "analysis.configuration_failed",
  "analysis.deadline_exceeded",
  "analysis.failed",
  "analysis.model.failed",
  "analysis.outcome.submit_failed",
  "analysis.report.validation_failed",
]);

const EVIDENCE_EVENT_KINDS = new Set([
  "analysis.bundle.read",
  "analysis.evidence.read",
  "analysis.evidence.served",
  "analysis.manifest.read",
]);

export interface AnalysisEventGroup {
  actor: string;
  events: PostRunAnalysisEvent[];
  id: string;
  kind: string;
  meta: string | null;
  occurredAt: string;
  payload: unknown;
  sequence: string;
  summary: string | null;
  title: string | null;
}

export function analysisEventMatches(
  event: PostRunAnalysisEvent,
  category: PostRunAnalysisEventCategory,
) {
  if (category === "ALL") return true;
  if (category === "KEY") return KEY_EVENT_KINDS.has(event.kind);
  if (category === "ERROR") return ERROR_EVENT_KINDS.has(event.kind);
  if (category === "MODEL") return event.kind.startsWith("analysis.model.");
  return EVIDENCE_EVENT_KINDS.has(event.kind);
}

export function aggregateAnalysisEvents(events: PostRunAnalysisEvent[]) {
  const ordered = [...events].sort(compareEvents);
  const consumed = new Set<string>();
  const groups: AnalysisEventGroup[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const event = ordered[index]!;
    if (consumed.has(event.sequence)) continue;
    if (event.kind === "analysis.model.started") {
      const payload = record(event.payload);
      const callId = text(payload.callId);
      const terminal = ordered.slice(index + 1).find((candidate) => {
        if (
          !["analysis.model.completed", "analysis.model.failed"].includes(
            candidate.kind,
          )
        ) {
          return false;
        }
        const candidateCallId = text(record(candidate.payload).callId);
        return callId ? candidateCallId === callId : !candidateCallId;
      });
      if (terminal) consumed.add(terminal.sequence);
      groups.push(modelGroup(event, terminal ?? null));
      continue;
    }
    if (
      ["analysis.model.completed", "analysis.model.failed"].includes(event.kind)
    ) {
      groups.push(modelGroup(null, event));
      continue;
    }
    groups.push(singleEventGroup(event));
  }

  return groupEvidenceReads(groups).sort((left, right) =>
    left.sequence.localeCompare(right.sequence, undefined, { numeric: true }),
  );
}

function modelGroup(
  started: PostRunAnalysisEvent | null,
  terminal: PostRunAnalysisEvent | null,
): AnalysisEventGroup {
  const primary = terminal ?? started!;
  const payload = record(primary.payload);
  const startedPayload = record(started?.payload);
  const turn = number(payload.turn) ?? number(startedPayload.turn);
  const model = text(payload.model) ?? text(startedPayload.model);
  const durationMs = number(payload.durationMs);
  const usage = record(payload.usage);
  const inputTokens = number(usage.input_tokens);
  const outputTokens = number(usage.output_tokens);
  const status = terminal
    ? terminal.kind === "analysis.model.failed"
      ? "失败"
      : "完成"
    : "进行中";
  const meta = [
    model,
    durationMs === null ? null : formatDuration(durationMs),
    inputTokens === null && outputTokens === null
      ? null
      : `${formatNumber(inputTokens ?? 0)} 输入 / ${formatNumber(outputTokens ?? 0)} 输出`,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    actor: primary.actor,
    events: [started, terminal].filter((event): event is PostRunAnalysisEvent =>
      Boolean(event),
    ),
    id: `model:${text(payload.callId) ?? text(startedPayload.callId) ?? primary.sequence}`,
    kind: primary.kind,
    meta: meta || null,
    occurredAt: primary.occurredAt,
    payload: terminal?.payload ?? started?.payload,
    sequence: started?.sequence ?? primary.sequence,
    summary:
      text(payload.purpose) ??
      text(payload.errorMessage) ??
      (terminal ? "模型已返回本轮分析动作。" : "正在等待模型返回。"),
    title: `${turn ? `第 ${turn} 轮` : "本轮"}模型分析${status}`,
  };
}

function singleEventGroup(event: PostRunAnalysisEvent): AnalysisEventGroup {
  return {
    actor: event.actor,
    events: [event],
    id: `event:${event.sequence}`,
    kind: event.kind,
    meta: eventMeta(event),
    occurredAt: event.occurredAt,
    payload: event.payload,
    sequence: event.sequence,
    summary: eventSummary(event),
    title: null,
  };
}

function groupEvidenceReads(groups: AnalysisEventGroup[]) {
  const result: AnalysisEventGroup[] = [];
  for (const group of groups) {
    const previous = result.at(-1);
    if (
      group.kind === "analysis.evidence.read" &&
      previous?.kind === "analysis.evidence.read" &&
      Date.parse(group.occurredAt) - Date.parse(previous.occurredAt) <= 10_000
    ) {
      const events = [...previous.events, ...group.events];
      const refs = events
        .map((event) => text(record(event.payload).evidenceRef))
        .filter((value): value is string => Boolean(value));
      result[result.length - 1] = {
        ...previous,
        events,
        meta: `${events.length} 次读取 · ${new Set(refs).size} 条证据`,
        occurredAt: group.occurredAt,
        payload: events.map((event) => event.payload),
        summary: refs.slice(-3).map(shortRef).join("、"),
        title: "批量核验证据",
      };
      continue;
    }
    result.push(group);
  }
  return result;
}

function eventSummary(event: PostRunAnalysisEvent) {
  const payload = record(event.payload);
  if (event.kind === "analysis.started") {
    const queueWaitMs = number(payload.queueWaitMs);
    return queueWaitMs === null
      ? "Agent Runtime 已领取分析任务。"
      : `排队 ${formatDuration(queueWaitMs)} 后开始执行。`;
  }
  if (event.kind === "analysis.manifest.read") {
    return payload.complete === true
      ? "执行索引已完整读取。"
      : "正在分段读取执行索引。";
  }
  if (event.kind === "analysis.evidence.read") {
    const runId = text(payload.runId);
    const attemptNumber = number(payload.attemptNumber);
    const context = [
      text(payload.commandType),
      runId ? `Run ${runId.slice(0, 8)}` : null,
      attemptNumber ? `Attempt #${attemptNumber}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `已核验证据 ${shortRef(text(payload.evidenceRef) ?? "未知证据")}${context ? `（${context}）` : ""}。`;
  }
  if (event.kind === "analysis.report.generated") {
    return `报告已生成：${formatNumber(number(payload.findingCount) ?? 0)} 条发现，已读取 ${formatNumber(number(payload.evidenceReadCount) ?? 0)} 条证据。`;
  }
  if (event.kind === "analysis.report.validation_failed") {
    return "报告校验未通过，分析器将补充证据或修正定位后重试。";
  }
  if (event.kind === "analysis.bundle.captured") {
    return "不可变任务日志包和证据索引已经就绪。";
  }
  return text(record(payload.error).message) ?? text(payload.message);
}

function eventMeta(event: PostRunAnalysisEvent) {
  const payload = record(event.payload);
  const turn = number(payload.turn);
  const bytesRead = number(payload.bytesRead);
  return (
    [
      turn ? `第 ${turn} 轮` : null,
      bytesRead === null ? null : `${formatNumber(bytesRead)} bytes`,
    ]
      .filter(Boolean)
      .join(" · ") || null
  );
}

function compareEvents(
  left: PostRunAnalysisEvent,
  right: PostRunAnalysisEvent,
) {
  return left.sequence.localeCompare(right.sequence, undefined, {
    numeric: true,
  });
}

function shortRef(value: string) {
  return value.length > 72 ? `${value.slice(0, 69)}…` : value;
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} 秒`;
  return `${Math.floor(milliseconds / 60_000)} 分 ${Math.round(
    (milliseconds % 60_000) / 1_000,
  )} 秒`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
