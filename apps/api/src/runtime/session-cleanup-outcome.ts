import {
  completeReadCoversRecord,
  executionRecordKey,
  executionStateSchema,
  successfulExecutionWrite,
  writeMatchesRecord,
} from "@devproof/agent-runtime-protocol";
import type { AgentRuntimeTask, Prisma } from "@prisma/client";

function responseBody(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A fenced executor checkpoint contains machine-built receipts, distinct from
 * its visual verdict or prose. Recognize the same create/delete proof the
 * journal already records. Restoration, retention, partial journals and unknown
 * writes still need review.
 */
export function completedCleanupEvidence(value: unknown): string[] {
  const parsed = executionStateSchema.safeParse(value);
  if (!parsed.success) return [];
  const state = parsed.data;
  if (
    state.phase !== "CLEANUP" ||
    state.writeHistoryTruncated ||
    state.requestOrderTruncated ||
    state.pendingRecords.length ||
    state.cleanupReview ||
    !state.records.length ||
    state.writes.length !== state.records.length * 2
  )
    return [];
  const used = new Set<string>();
  const refs = new Set<string>();
  for (const record of state.records) {
    if (
      record.ownership !== "CREATED_THIS_RUN" ||
      !record.recordRef ||
      !record.resourceUrl ||
      !record.resourceName ||
      !record.creationWriteKey ||
      record.cleanup?.status !== "COMPLETED" ||
      record.cleanup.resolution !== "DELETED"
    )
      return [];
    const proof = state.cleanupConfirmations.find(
      (confirmation) =>
        confirmation.recordRef === record.recordRef &&
        confirmation.source !== "UI",
    );
    const creation = state.writes.find(
      (write) => write.key === record.creationWriteKey,
    );
    const deletion = state.writes.find(
      (write) => write.key === proof?.writeKey,
    );
    const read = state.readReceipts.find((item) => item.key === proof?.readKey);
    const createdBody = responseBody(creation?.response);
    const deletedBody = responseBody(deletion?.response);
    const key = executionRecordKey(record.id, record.type, record.resourceUrl);
    if (
      !proof ||
      !creation ||
      !deletion ||
      !read ||
      creation.method !== "POST" ||
      deletion.method !== "DELETE" ||
      creation.sequence === undefined ||
      deletion.sequence === undefined ||
      creation.sequence >= deletion.sequence ||
      deletion.sequence >= read.sequence ||
      !creation.confirmed ||
      !deletion.confirmed ||
      createdBody === undefined ||
      deletedBody === undefined ||
      !successfulExecutionWrite(creation.status, createdBody) ||
      !successfulExecutionWrite(deletion.status, deletedBody) ||
      !writeMatchesRecord(creation, record) ||
      !writeMatchesRecord(deletion, record) ||
      !completeReadCoversRecord(read, record) ||
      read.recordKeys.includes(key) ||
      state.readReceipts.some(
        (later) =>
          later.sequence > read.sequence &&
          (later.recordKeys.includes(key) ||
            completeReadCoversRecord(later, record)),
      )
    )
      return [];
    for (const write of [creation, deletion]) {
      if (used.has(write.key) || !write.evidenceRefs.length) return [];
      used.add(write.key);
      for (const ref of write.evidenceRefs) refs.add(ref);
    }
    if (!read.evidenceRefs.length || !proof.evidenceRefs.length) return [];
    for (const ref of [...read.evidenceRefs, ...proof.evidenceRefs])
      refs.add(ref);
  }
  return used.size === state.writes.length ? [...refs] : [];
}

export async function hasConfirmedCleanupOutcome(
  tx: Prisma.TransactionClient,
  owner: AgentRuntimeTask,
) {
  const snapshot = owner.snapshot as {
    executionPolicy?: { executionState?: unknown };
  } | null;
  const refs = completedCleanupEvidence(
    snapshot?.executionPolicy?.executionState,
  );
  if (!refs.length) return false;
  // Checkpoints already validate these references on admission. Recheck the
  // attempt boundary here so stale/cross-attempt journals never release a guard.
  const evidence = await tx.runEvidence.findMany({
    where: {
      runId: owner.runId,
      attemptId: owner.attemptId,
      externalId: { in: refs },
    },
    select: { externalId: true, kind: true },
  });
  const known = new Set(evidence.map((item) => item.externalId));
  return (
    refs.every((ref) => known.has(ref)) &&
    evidence.some((item) => item.kind === "NETWORK")
  );
}
