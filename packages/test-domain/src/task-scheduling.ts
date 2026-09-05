export type CaseSchedulingState =
  "READY" | "WAITING" | "ADMITTED" | "RUNNING" | "RECOVERING" | "TERMINAL";

export interface CaseSchedulingDecision {
  state: CaseSchedulingState;
  reason: string | null;
  waitingSince: string | null;
  evaluatedAt: string;
  blockedBy: {
    resourceType: string;
    resourceId?: string;
    rootReason?: string;
    recoveryId?: string;
    recoveryPhase?: string;
    taskId?: string;
    caseExecutionId?: string;
    runId?: string;
  } | null;
  queue: { scope: string; position: number | null; snapshotAt: string } | null;
  nextRetryAt: string | null;
}

export interface CaseExecutionProgress {
  dispatchStatus: string;
  dispatchAttempts?: number;
  dispatchMaxAttempts?: number;
  scheduling?: unknown;
  run: {
    executionDisposition: string | null;
    lifecycle: string;
    verdict: string | null;
    tasks?: readonly { recoveryStatus: string | null }[];
  } | null;
}

const terminalLifecycles = new Set(["COMPLETED", "CANCELLED", "TIMED_OUT"]);
const schedulingStates = new Set<CaseSchedulingState>([
  "READY",
  "WAITING",
  "ADMITTED",
  "RUNNING",
  "RECOVERING",
  "TERMINAL",
]);

/** Read old rows without treating absent scheduling metadata as an error. */
export function readCaseScheduling(
  value: unknown,
): CaseSchedulingDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!schedulingStates.has(row.state as CaseSchedulingState)) return null;
  const text = (key: string) =>
    typeof row[key] === "string" ? (row[key] as string) : null;
  const blocker = row.blockedBy;
  const queue = row.queue;
  return {
    state: row.state as CaseSchedulingState,
    reason: text("reason"),
    waitingSince: text("waitingSince"),
    evaluatedAt: text("evaluatedAt") ?? "",
    blockedBy:
      blocker &&
      typeof blocker === "object" &&
      !Array.isArray(blocker) &&
      typeof (blocker as Record<string, unknown>).resourceType === "string"
        ? (blocker as CaseSchedulingDecision["blockedBy"])
        : null,
    queue:
      queue &&
      typeof queue === "object" &&
      !Array.isArray(queue) &&
      typeof (queue as Record<string, unknown>).scope === "string"
        ? (queue as CaseSchedulingDecision["queue"])
        : null,
    nextRetryAt: text("nextRetryAt"),
  };
}

export type CaseExecutionPhase =
  "queued" | "running" | "recovering" | "waitingHuman" | "terminal";

export function caseExecutionPhase(
  item: CaseExecutionProgress,
): CaseExecutionPhase {
  if (item.run && terminalLifecycles.has(item.run.lifecycle)) return "terminal";
  if (item.run?.lifecycle === "WAITING_HUMAN") return "waitingHuman";
  const scheduling = readCaseScheduling(item.scheduling);
  if (
    item.run?.tasks?.some(
      (task) =>
        task.recoveryStatus === "PENDING" || task.recoveryStatus === "CLOSING",
    )
  )
    return "recovering";
  if (scheduling?.state === "RECOVERING") return "recovering";
  if (item.run) {
    if (scheduling?.state === "ADMITTED") return "queued";
    return item.run.lifecycle === "RUNNING" ? "running" : "queued";
  }
  if (
    item.dispatchStatus === "CANCELLED" ||
    item.dispatchStatus === "LINKED" ||
    (item.dispatchStatus === "FAILED" &&
      (item.dispatchAttempts ?? 0) >= (item.dispatchMaxAttempts ?? 3)) ||
    scheduling?.state === "TERMINAL"
  )
    return "terminal";
  return "queued";
}

/** Phase counts are disjoint; verdict counts remain separate, compatible metrics. */
export function countCaseExecutions(
  executions: readonly CaseExecutionProgress[],
  plannedTotal: number,
  parentLifecycle?: string,
) {
  const total = Math.max(plannedTotal, executions.length);
  const counts = {
    blocked: 0,
    failed: 0,
    inconclusive: 0,
    passed: 0,
    queued: 0,
    running: 0,
    recovering: 0,
    waitingHuman: 0,
    terminal: 0,
    timedOut: 0,
    cancelled: 0,
    dispatchFailed: 0,
    total,
    waiting: 0,
  };
  for (const item of executions) {
    const phase =
      !item.run && parentLifecycle && terminalLifecycles.has(parentLifecycle)
        ? "terminal"
        : caseExecutionPhase(item);
    counts[phase] += 1;
    if (
      item.run?.executionDisposition &&
      item.run.executionDisposition !== "EXECUTED"
    )
      counts.blocked += 1;
    if (item.run?.verdict === "FAILED") counts.failed += 1;
    if (item.run?.verdict === "INCONCLUSIVE") counts.inconclusive += 1;
    if (item.run?.verdict === "PASSED") counts.passed += 1;
    if (item.run?.lifecycle === "TIMED_OUT") counts.timedOut += 1;
    if (
      item.run?.lifecycle === "CANCELLED" ||
      (!item.run && item.dispatchStatus === "CANCELLED")
    )
      counts.cancelled += 1;
    if (
      !item.run &&
      caseExecutionPhase(item) === "terminal" &&
      item.dispatchStatus !== "CANCELLED"
    )
      counts.dispatchFailed += 1;
  }
  // Historical Tasks can finish before all planned deployment rows were created.
  const missing = total - executions.length;
  if (parentLifecycle && terminalLifecycles.has(parentLifecycle))
    counts.terminal += missing;
  else counts.queued += missing;
  counts.waiting = counts.queued;
  return counts;
}

export function summarizeCaseScheduling(
  executions: readonly CaseExecutionProgress[],
  parentLifecycle?: string,
) {
  const counts = countCaseExecutions(
    executions,
    executions.length,
    parentLifecycle,
  );
  const decisions = executions.flatMap((item) => {
    if (caseExecutionPhase(item) === "terminal") return [];
    const decision = readCaseScheduling(item.scheduling);
    return decision ? [decision] : [];
  });
  const waiting = decisions.filter(
    (item) =>
      item.state === "WAITING" ||
      item.state === "ADMITTED" ||
      item.state === "RECOVERING",
  );
  const reasons: Record<string, number> = {};
  for (const item of waiting)
    if (item.reason) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
  const oldest = waiting.sort((left, right) =>
    (left.waitingSince ?? left.evaluatedAt).localeCompare(
      right.waitingSince ?? right.evaluatedAt,
    ),
  )[0];
  return {
    state:
      parentLifecycle && terminalLifecycles.has(parentLifecycle)
        ? ("TERMINAL" as const)
        : counts.running
          ? ("RUNNING" as const)
          : counts.recovering
            ? ("RECOVERING" as const)
            : counts.waitingHuman
              ? ("WAITING_HUMAN" as const)
              : counts.queued
                ? ("WAITING" as const)
                : ("TERMINAL" as const),
    reason: counts.running
      ? null
      : counts.recovering
        ? "LEASE_RECOVERY"
        : (oldest?.reason ?? (counts.queued ? "SCHEDULER_PENDING" : null)),
    waitingSince: oldest?.waitingSince ?? null,
    blockedBy: counts.running ? null : (oldest?.blockedBy ?? null),
    reasons,
  };
}
