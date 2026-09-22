import { executionStateSchema } from "@devproof/agent-runtime-protocol";
import type { AgentRuntimeTask, Prisma } from "@prisma/client";

/** A fenced executor checkpoint contains machine-built receipts, distinct from
 * its visual verdict or prose. Recognize the conservative create/delete case;
 * restoration, retention, partial journals and unknown writes still need review.
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
      (c) => c.recordRef === record.recordRef && c.source !== "UI",
    );
    const creation = state.writes.find(
      (w) => w.key === record.creationWriteKey,
    );
    const deletion = state.writes.find((w) => w.key === proof?.writeKey);
    const read = state.readReceipts.find((r) => r.key === proof?.readKey);
    if (
      !proof ||
      !creation ||
      !deletion ||
      !read ||
      creation.method !== "POST" ||
      deletion.method !== "DELETE" ||
      !read.complete ||
      !read.empty ||
      read.recordKeys.length ||
      creation.sequence === undefined ||
      deletion.sequence === undefined ||
      creation.sequence >= deletion.sequence ||
      deletion.sequence >= read.sequence
    )
      return [];
    try {
      const resource = new URL(record.resourceUrl);
      const created = new URL(creation.url);
      const deleted = new URL(deletion.url);
      const checked = new URL(read.url);
      if (
        created.origin !== resource.origin ||
        created.pathname !== resource.pathname ||
        deleted.origin !== resource.origin ||
        deleted.pathname !== resource.pathname ||
        deleted.searchParams.get("id") !== record.id ||
        checked.origin !== resource.origin ||
        checked.pathname !== `${resource.pathname}/list` ||
        checked.searchParams.get("name") !== record.resourceName ||
        [...checked.searchParams.keys()].some(
          (key) => !["name", "pageIndex", "pageSize"].includes(key),
        )
      )
        return [];
      if (
        state.readReceipts.some((later) => {
          if (later.sequence <= read.sequence) return false;
          const url = new URL(later.url);
          return (
            url.origin === resource.origin &&
            url.pathname === checked.pathname &&
            url.searchParams.get("name") === record.resourceName
          );
        })
      )
        return [];
    } catch {
      return [];
    }
    for (const write of [creation, deletion]) {
      if (
        used.has(write.key) ||
        !write.confirmed ||
        !write.status ||
        write.status < 200 ||
        write.status >= 300 ||
        !write.evidenceRefs.length
      )
        return [];
      try {
        const body = JSON.parse(write.response ?? "") as Record<
          string,
          unknown
        > | null;
        if (
          !body ||
          typeof body !== "object" ||
          body.success === false ||
          (body.code !== undefined &&
            ![0, 200, "0", "200", "OK", "SUCCESS"].includes(body.code as never))
        )
          return [];
      } catch {
        return [];
      }
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
  const known = new Set(evidence.map((e) => e.externalId));
  return (
    refs.every((ref) => known.has(ref)) &&
    evidence.some((e) => e.kind === "NETWORK")
  );
}
