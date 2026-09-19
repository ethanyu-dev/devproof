import type { ExecutionDisposition, RunProductVerdict } from "@prisma/client";
import { redactText } from "../observability/observability.service.js";

/** Expose cleanup diagnostics without returning the full Runtime result. */
export function executionCleanup(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return null;
  const outcome = result as Record<string, unknown>;
  if (outcome.kind !== "VERIFICATION_COMPLETED") return null;
  const cleanup = outcome.cleanup as
    { status?: unknown; note?: unknown } | undefined;
  if (cleanup?.status !== "BLOCKED") return null;
  return {
    status: "BLOCKED" as const,
    note:
      typeof cleanup.note === "string" && cleanup.note.trim()
        ? redactText(cleanup.note)
        : "测试数据的清理、恢复或写入归属尚未完成核对。",
  };
}

/** Older runs used cleanup alone to clear a completed verification verdict.
 * Restore only that projection; interrupted executions and real errors remain intact.
 */
export function executionVerification(run: {
  lifecycle: string;
  executionDisposition: ExecutionDisposition | null;
  verdict: RunProductVerdict | null;
  currentAttemptNumber: number;
  attempts: Array<{ id: string; number: number; error?: unknown }>;
  tasks: Array<{ attemptId: string; result?: unknown; error?: unknown }>;
}) {
  const current = {
    executionDisposition: run.executionDisposition,
    verdict: run.verdict,
  };
  if (
    run.lifecycle !== "COMPLETED" ||
    run.executionDisposition !== "BLOCKED" ||
    run.verdict !== null
  )
    return current;
  const attempt = run.attempts.find(
    (a) => a.number === run.currentAttemptNumber,
  );
  const task = attempt && run.tasks.find((t) => t.attemptId === attempt.id);
  if (!task || task.error || attempt?.error || !executionCleanup(task.result))
    return current;
  const result = task.result as Record<string, unknown>;
  if (
    result.termination ||
    result.executionDisposition !== "EXECUTED" ||
    !["PASSED", "FAILED", "INCONCLUSIVE"].includes(String(result.verdict))
  )
    return current;
  return {
    executionDisposition: "EXECUTED" as const,
    verdict: result.verdict as RunProductVerdict,
  };
}
