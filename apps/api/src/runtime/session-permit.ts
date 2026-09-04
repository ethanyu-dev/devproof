import type { BrowserRuntimeSession, Prisma } from "@prisma/client";
import type { RuntimeSessionPermit } from "@devproof/runtime-protocol";

/** A live node cannot renew a stopped executor's authority. */
export async function sessionExecutionPermit(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
  now: Date,
): Promise<RuntimeSessionPermit | null> {
  if (
    session.quarantinedAt ||
    session.closedAt ||
    !["OPENING", "ACTIVE", "HUMAN_CONTROL"].includes(session.status)
  )
    return null;
  const base = {
    sessionId: session.id,
    fencingToken: session.fencingToken.toString(),
    leaseToken: session.leaseToken,
    controlGeneration: session.controlGeneration ?? 0,
    ...(session.ownerTaskId && session.ownerFencingToken != null
      ? {
          ownerTaskId: session.ownerTaskId,
          ownerFencingToken: session.ownerFencingToken.toString(),
        }
      : {}),
  };
  if (session.status === "HUMAN_CONTROL") {
    if (!session.humanControlExpiresAt || session.humanControlExpiresAt <= now)
      return null;
    return {
      ...base,
      ownerKind: "HUMAN",
      expiresAt: new Date(
        Math.min(
          session.leaseExpiresAt.getTime(),
          session.humanControlExpiresAt.getTime(),
        ),
      ).toISOString(),
    };
  }
  if (session.ownerTaskId) {
    const task = await tx.agentRuntimeTask.findUnique({
      include: { run: true },
      where: { id: session.ownerTaskId },
    });
    if (
      task?.status === "WAITING_HUMAN" &&
      task.run.lifecycle === "WAITING_HUMAN"
    ) {
      const intervention = await tx.humanIntervention.findFirst({
        where: { taskId: task.id, status: "PENDING", expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
      });
      if (!intervention?.expiresAt) return null;
      return {
        ...base,
        ownerKind: "HUMAN",
        expiresAt: new Date(
          Math.min(
            session.leaseExpiresAt.getTime(),
            intervention.expiresAt.getTime(),
          ),
        ).toISOString(),
      };
    }
    if (
      task?.status === "PENDING" &&
      task.run.lifecycle === "QUEUED" &&
      session.executionPermitExpiresAt &&
      session.executionPermitExpiresAt > now
    ) {
      // A resolved human intervention has a bounded handoff window to its new Agent epoch.
      const snapshot = task.snapshot as {
        executionPolicy?: { resume?: unknown };
      };
      if (snapshot.executionPolicy?.resume)
        return {
          ...base,
          ownerKind: "HUMAN",
          expiresAt: new Date(
            Math.min(
              session.leaseExpiresAt.getTime(),
              session.executionPermitExpiresAt.getTime(),
            ),
          ).toISOString(),
        };
    }
    if (
      !task ||
      task.fencingToken !== session.ownerFencingToken ||
      task.status !== "RUNNING" ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= now ||
      task.run.lifecycle !== "RUNNING" ||
      task.run.cancelRequestedAt ||
      task.run.deadlineAt <= now
    )
      return null;
    return {
      ...base,
      ownerKind: "AGENT",
      ownerTaskId: task.id,
      ownerFencingToken: task.fencingToken.toString(),
      expiresAt: new Date(
        Math.min(
          session.leaseExpiresAt.getTime(),
          task.leaseExpiresAt.getTime(),
          task.run.deadlineAt.getTime(),
        ),
      ).toISOString(),
    };
  }
  const execution = await tx.browserExecution.findFirst({
    select: { id: true },
    where: { runtimeSessionId: session.id },
  });
  const expiresAt = new Date(
    Math.min(
      session.leaseExpiresAt.getTime(),
      execution
        ? (session.executionPermitExpiresAt?.getTime() ??
            session.createdAt.getTime() + 120_000)
        : session.leaseExpiresAt.getTime(),
    ),
  );
  if (expiresAt <= now) return null;
  return {
    ...base,
    ownerKind: execution ? "STARTUP" : "SYSTEM",
    expiresAt: expiresAt.toISOString(),
  };
}
