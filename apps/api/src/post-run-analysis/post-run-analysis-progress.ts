export const POST_RUN_ANALYSIS_EVENT_CATEGORIES = [
  "ALL",
  "KEY",
  "ERROR",
  "MODEL",
  "EVIDENCE",
] as const;

export type PostRunAnalysisEventCategory =
  (typeof POST_RUN_ANALYSIS_EVENT_CATEGORIES)[number];

export type PostRunAnalysisProgressEvent = {
  kind: string;
  occurredAt: Date;
  payload: unknown;
  sequence: bigint;
};

type ProgressJob = {
  createdAt: Date;
  deadlineAt: Date;
  error: unknown;
  findings: Array<unknown>;
  finishedAt: Date | null;
  hardDeadlineAt: Date;
  inputSha256: string | null;
  nextAttemptAt: Date | null;
  readyAt: Date | null;
  startedAt: Date | null;
  status: string;
  updatedAt: Date;
};

const KEY_EVENT_KINDS = [
  "analysis.attempt_deadline_exceeded",
  "analysis.attempts_exhausted",
  "analysis.bundle.captured",
  "analysis.completed",
  "analysis.configuration_failed",
  "analysis.deadline_exceeded",
  "analysis.executor.started",
  "analysis.failed",
  "analysis.lease_recovered",
  "analysis.report.generated",
  "analysis.report.validation_failed",
  "analysis.retry_queued",
  "analysis.retry_requested",
  "analysis.started",
  "analysis.superseded",
] as const;

const ERROR_EVENT_KINDS = [
  "analysis.attempt_deadline_exceeded",
  "analysis.attempts_exhausted",
  "analysis.configuration_failed",
  "analysis.deadline_exceeded",
  "analysis.failed",
  "analysis.model.failed",
  "analysis.outcome.submit_failed",
  "analysis.report.validation_failed",
] as const;

const MODEL_EVENT_KINDS = [
  "analysis.model.completed",
  "analysis.model.failed",
  "analysis.model.started",
] as const;

const EVIDENCE_EVENT_KINDS = [
  "analysis.bundle.read",
  "analysis.evidence.read",
  "analysis.evidence.served",
  "analysis.manifest.read",
] as const;

const ATTEMPT_END_EVENT_KINDS = new Set([
  "analysis.attempt_deadline_exceeded",
  "analysis.attempts_exhausted",
  "analysis.completed",
  "analysis.configuration_failed",
  "analysis.deadline_exceeded",
  "analysis.failed",
  "analysis.lease_recovered",
  "analysis.retry_queued",
  "analysis.superseded",
]);

export function postRunAnalysisEventKinds(
  category: PostRunAnalysisEventCategory,
) {
  if (category === "KEY") return [...KEY_EVENT_KINDS];
  if (category === "ERROR") return [...ERROR_EVENT_KINDS];
  if (category === "MODEL") return [...MODEL_EVENT_KINDS];
  if (category === "EVIDENCE") return [...EVIDENCE_EVENT_KINDS];
  return null;
}

export function buildPostRunAnalysisProgress(
  job: ProgressJob,
  events: PostRunAnalysisProgressEvent[],
  now = new Date(),
) {
  const ordered = [...events].sort((left, right) =>
    left.sequence < right.sequence
      ? -1
      : left.sequence > right.sequence
        ? 1
        : 0,
  );
  const currentAttemptEvents = eventsForCurrentAttempt(ordered);
  const attempts = attemptProgress(job, ordered, now);
  const currentAttempt = attempts.at(-1) ?? null;
  const metrics = metricsForEvents(ordered);
  const currentAttemptMetrics = metricsForEvents(currentAttemptEvents);
  const latestReportEvent = currentAttemptEvents.findLast((event) =>
    ["analysis.report.generated", "analysis.report.validation_failed"].includes(
      event.kind,
    ),
  );
  const latestEvent = ordered.at(-1) ?? null;
  const phase = currentPhase(job, currentAttemptEvents);
  const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status);
  const deadline =
    job.status === "RUNNING" ? job.deadlineAt : job.hardDeadlineAt;
  const startedEvent = currentAttemptEvents.findLast(
    (event) => event.kind === "analysis.started",
  );
  const queueWaitMs =
    job.status === "READY" && job.readyAt
      ? Math.max(0, now.getTime() - job.readyAt.getTime())
      : (currentAttempt?.queueWaitMs ??
        number(record(startedEvent?.payload).queueWaitMs) ??
        (job.startedAt && job.readyAt
          ? Math.max(0, job.startedAt.getTime() - job.readyAt.getTime())
          : null));
  const findingCount =
    number(record(latestReportEvent?.payload).findingCount) ??
    job.findings.length;
  const activeElapsedMs = attempts.reduce(
    (total, attempt) => total + attempt.elapsedMs,
    0,
  );
  const lifecycleElapsedMs = Math.max(
    0,
    (job.finishedAt ?? now).getTime() - job.createdAt.getTime(),
  );

  return {
    activeElapsedMs,
    attempts,
    currentMessage: progressMessage(job, latestEvent, phase),
    currentAttemptElapsedMs: currentAttempt?.elapsedMs ?? 0,
    currentAttemptMetrics,
    deadlineAt: deadline.toISOString(),
    deadlineRemainingMs: terminal
      ? 0
      : Math.max(0, deadline.getTime() - now.getTime()),
    elapsedMs: activeElapsedMs,
    findingCount,
    lastActivityAt:
      latestEvent?.occurredAt.toISOString() ?? job.updatedAt.toISOString(),
    lastEventKind: latestEvent?.kind ?? null,
    lifecycleElapsedMs,
    metrics,
    nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
    phase,
    phaseLabel: phaseLabel(phase),
    queueWaitMs,
    steps: progressSteps(job, phase, currentAttemptEvents),
  };
}

function metricsForEvents(events: PostRunAnalysisProgressEvent[]) {
  const modelStarted = events.filter(
    (event) => event.kind === "analysis.model.started",
  );
  const completedModelCalls = events.filter(
    (event) => event.kind === "analysis.model.completed",
  );
  const failedModelCalls = events.filter(
    (event) => event.kind === "analysis.model.failed",
  );
  const modelFinished = [...completedModelCalls, ...failedModelCalls];
  const modelCallIds = new Set(
    [...modelStarted, ...modelFinished]
      .map((event) => text(record(event.payload).callId))
      .filter((value): value is string => Boolean(value)),
  );
  const legacyModelStarts = modelStarted.filter(
    (event) => !text(record(event.payload).callId),
  ).length;
  const legacyModelFinishes = modelFinished.filter(
    (event) => !text(record(event.payload).callId),
  ).length;
  const evidenceReads = events.filter(
    (event) => event.kind === "analysis.evidence.read",
  );
  const evidenceRefs = new Set(
    evidenceReads
      .map((event) => text(record(event.payload).evidenceRef))
      .filter((value): value is string => Boolean(value)),
  );
  const usage = completedModelCalls.reduce(
    (total, event) => {
      const value = record(record(event.payload).usage);
      total.inputTokens += number(value.input_tokens) ?? 0;
      total.outputTokens += number(value.output_tokens) ?? 0;
      total.totalTokens +=
        number(value.total_tokens) ??
        (number(value.input_tokens) ?? 0) + (number(value.output_tokens) ?? 0);
      return total;
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );

  return {
    bundleReads: events.filter((event) => event.kind === "analysis.bundle.read")
      .length,
    evidenceReads: evidenceReads.length,
    failedModelCalls: failedModelCalls.length,
    inputTokens: usage.inputTokens,
    manifestReads: events.filter(
      (event) => event.kind === "analysis.manifest.read",
    ).length,
    modelCalls:
      modelCallIds.size + Math.max(legacyModelStarts, legacyModelFinishes),
    modelDurationMs: modelFinished.reduce(
      (total, event) => total + (number(record(event.payload).durationMs) ?? 0),
      0,
    ),
    models: [
      ...new Set(
        [...modelStarted, ...modelFinished]
          .map((event) => text(record(event.payload).model))
          .filter((value): value is string => Boolean(value)),
      ),
    ],
    outputTokens: usage.outputTokens,
    reportValidationFailures: events.filter(
      (event) => event.kind === "analysis.report.validation_failed",
    ).length,
    totalTokens: usage.totalTokens,
    uniqueEvidence: evidenceRefs.size,
  };
}

function attemptProgress(
  job: ProgressJob,
  events: PostRunAnalysisProgressEvent[],
  now: Date,
) {
  const starts = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "analysis.started");

  return starts.map(({ event: started, index: startedIndex }, position) => {
    const nextStarted = starts[position + 1]?.event ?? null;
    const nextStartedIndex = starts[position + 1]?.index ?? events.length;
    const attemptEvents = events.slice(startedIndex, nextStartedIndex);
    const endEvent = attemptEvents.find((event) =>
      ATTEMPT_END_EVENT_KINDS.has(event.kind),
    );
    const isCurrent = position === starts.length - 1;
    const endAt =
      (endEvent ? attemptEndAt(endEvent) : null) ??
      nextStarted?.occurredAt ??
      (isCurrent && job.status === "RUNNING"
        ? now
        : (job.finishedAt ?? attemptEvents.at(-1)?.occurredAt ?? now));
    const elapsedMs = Math.max(
      0,
      endAt.getTime() - started.occurredAt.getTime(),
    );
    const attemptNumber =
      number(record(started.payload).attemptNumber) ?? position + 1;
    const terminalKind = endEvent?.kind ?? null;

    return {
      attemptNumber,
      elapsedMs,
      finishedAt:
        endEvent || nextStarted || job.status !== "RUNNING"
          ? endAt.toISOString()
          : null,
      metrics: metricsForEvents(attemptEvents),
      queueWaitMs: number(record(started.payload).queueWaitMs),
      startedAt: started.occurredAt.toISOString(),
      status: attemptStatus(terminalKind, isCurrent ? job.status : null),
    };
  });
}

function attemptStatus(terminalKind: string | null, jobStatus: string | null) {
  if (terminalKind === "analysis.completed") return "SUCCEEDED";
  if (
    terminalKind === "analysis.retry_queued" ||
    terminalKind === "analysis.attempt_deadline_exceeded" ||
    terminalKind === "analysis.lease_recovered"
  ) {
    return "RETRYING";
  }
  if (terminalKind === "analysis.superseded" || jobStatus === "CANCELLED") {
    return "CANCELLED";
  }
  if (
    terminalKind &&
    [
      "analysis.attempts_exhausted",
      "analysis.configuration_failed",
      "analysis.deadline_exceeded",
      "analysis.failed",
    ].includes(terminalKind)
  ) {
    return "FAILED";
  }
  if (jobStatus === "SUCCEEDED") return "SUCCEEDED";
  if (jobStatus === "FAILED") return "FAILED";
  return jobStatus === "RUNNING" ? "RUNNING" : "RETRYING";
}

function attemptEndAt(event: PostRunAnalysisProgressEvent) {
  const payload = record(event.payload);
  const value =
    text(payload.endedAt) ??
    text(payload.previousLeaseExpiredAt) ??
    text(payload.deadlineAt);
  if (!value) return event.occurredAt;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : event.occurredAt;
}

function eventsForCurrentAttempt(events: PostRunAnalysisProgressEvent[]) {
  const startedIndex = events.findLastIndex(
    (event) => event.kind === "analysis.started",
  );
  return startedIndex === -1 ? events : events.slice(startedIndex);
}

function currentPhase(
  job: ProgressJob,
  events: PostRunAnalysisProgressEvent[],
) {
  if (job.status === "SUCCEEDED") return "COMPLETED";
  if (["FAILED", "CANCELLED"].includes(job.status)) return "FAILED";
  if (!job.inputSha256) return "CAPTURE";
  if (!job.startedAt || job.status === "READY") return "QUEUE";
  if (events.some((event) => event.kind === "analysis.report.generated")) {
    return "PERSISTING";
  }
  const latestOperationalEvent = events.findLast((event) =>
    [
      "analysis.bundle.read",
      "analysis.evidence.read",
      "analysis.evidence.served",
      "analysis.manifest.read",
      "analysis.model.completed",
      "analysis.model.failed",
      "analysis.model.started",
      "analysis.report.validation_failed",
    ].includes(event.kind),
  );
  const latestModelAction =
    latestOperationalEvent?.kind === "analysis.model.completed"
      ? text(record(latestOperationalEvent.payload).action)
      : null;
  const reportedPhase = text(record(latestOperationalEvent?.payload).phase);
  if (
    latestModelAction === "GENERATE_REPORT" ||
    latestOperationalEvent?.kind === "analysis.report.validation_failed"
  ) {
    return "REPORTING";
  }
  if (
    [
      "analysis.bundle.read",
      "analysis.evidence.read",
      "analysis.evidence.served",
    ].includes(latestOperationalEvent?.kind ?? "") ||
    ["READ_BUNDLE", "READ_EVIDENCE"].includes(latestModelAction ?? "")
  ) {
    return "EVIDENCE";
  }
  if (
    ["EVIDENCE_ANALYSIS", "EVIDENCE_DISCOVERY"].includes(reportedPhase ?? "")
  ) {
    return "EVIDENCE";
  }
  if (
    ["REPORT_GENERATION", "REPORT_VALIDATION"].includes(reportedPhase ?? "")
  ) {
    return "REPORTING";
  }
  return "INDEXING";
}

function progressSteps(
  job: ProgressJob,
  phase: string,
  events: PostRunAnalysisProgressEvent[],
) {
  const definitions = [
    ["CAPTURE", "采集日志"],
    ["QUEUE", "等待调度"],
    ["INDEXING", "读取索引"],
    ["EVIDENCE", "核验证据"],
    ["REPORTING", "生成报告"],
    ["PERSISTING", "保存结果"],
  ] as const;
  if (phase === "COMPLETED") {
    return definitions.map(([key, label]) => ({
      key,
      label,
      status: "COMPLETED",
    }));
  }
  const failed = phase === "FAILED";
  const activeKey = failed
    ? currentPhase({ ...job, status: "RUNNING" }, events)
    : phase;
  const activeIndex = Math.max(
    0,
    definitions.findIndex(([key]) => key === activeKey),
  );
  return definitions.map(([key, label], index) => ({
    key,
    label,
    status:
      index < activeIndex
        ? "COMPLETED"
        : index === activeIndex
          ? failed
            ? "FAILED"
            : "ACTIVE"
          : "PENDING",
  }));
}

function progressMessage(
  job: ProgressJob,
  latestEvent: PostRunAnalysisProgressEvent | null,
  phase: string,
) {
  if (job.status === "SUCCEEDED") {
    return job.findings.length
      ? `分析完成，生成 ${job.findings.length} 条可执行发现。`
      : "分析完成，未发现达到置信度阈值的可执行问题。";
  }
  if (["FAILED", "CANCELLED"].includes(job.status)) {
    const error = record(job.error);
    return text(error.message) ?? "自动优化分析未完成。";
  }
  const payload = record(latestEvent?.payload);
  if (latestEvent?.kind === "analysis.model.started") {
    const turn = number(payload.turn);
    const model = text(payload.model);
    return `正在进行${turn ? `第 ${turn} 轮` : ""}模型分析${model ? `（${model}）` : ""}。`;
  }
  if (latestEvent?.kind === "analysis.model.completed") {
    return text(payload.purpose) ?? "本轮模型分析已完成，正在执行下一步操作。";
  }
  if (latestEvent?.kind === "analysis.evidence.read") {
    const runId = text(payload.runId);
    const attemptNumber = number(payload.attemptNumber);
    const context = [
      text(payload.commandType),
      runId ? `Run ${runId.slice(0, 8)}` : null,
      attemptNumber ? `Attempt #${attemptNumber}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `正在核验证据 ${shortRef(text(payload.evidenceRef))}${context ? `（${context}）` : ""}。`;
  }
  if (latestEvent?.kind === "analysis.manifest.read") {
    return payload.complete === true
      ? "执行索引已读取完成，正在定位异常证据。"
      : "正在分段读取完整执行索引。";
  }
  if (latestEvent?.kind === "analysis.report.validation_failed") {
    return "分析报告校验未通过，正在补充证据或修正定位。";
  }
  if (latestEvent?.kind === "analysis.report.generated") {
    return "分析报告已生成，正在保存发现和改进任务。";
  }
  return (
    {
      CAPTURE: "正在等待任务日志和运行制品完成收口。",
      EVIDENCE: "正在定位并核验与异常阶段相关的证据。",
      INDEXING: "正在读取执行索引并建立异常阶段上下文。",
      PERSISTING: "正在保存分析结果。",
      QUEUE: job.nextAttemptAt
        ? "分析已进入队列，等待可用的 Agent Runtime。"
        : "分析日志包已就绪，等待调度。",
      REPORTING: "正在生成并校验优化分析报告。",
    }[phase] ?? "自动优化分析正在运行。"
  );
}

function phaseLabel(phase: string) {
  return (
    {
      CAPTURE: "日志采集中",
      COMPLETED: "分析完成",
      EVIDENCE: "证据分析中",
      FAILED: "分析未完成",
      INDEXING: "索引读取中",
      PERSISTING: "结果保存中",
      QUEUE: "等待调度",
      REPORTING: "报告生成中",
    }[phase] ?? phase
  );
}

function shortRef(value: string | null) {
  if (!value) return "未知证据";
  return value.length > 72 ? `${value.slice(0, 69)}…` : value;
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
