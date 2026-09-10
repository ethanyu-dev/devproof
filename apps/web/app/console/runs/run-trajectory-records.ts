import type { RunTrajectoryRecord } from "@devproof/contracts";

export function mergeTrajectoryRecords(
  ...groups: RunTrajectoryRecord[][]
): RunTrajectoryRecord[] {
  const records = new Map<string, RunTrajectoryRecord>();
  for (const record of groups.flat()) {
    const previous = records.get(record.id);
    if (!previous || BigInt(record.sequence) >= BigInt(previous.sequence))
      records.set(record.id, record);
  }
  const ordered = [...records.values()].sort((left, right) => {
    const leftSequence = BigInt(left.sequence);
    const rightSequence = BigInt(right.sequence);
    return leftSequence < rightSequence
      ? -1
      : leftSequence > rightSequence
        ? 1
        : 0;
  });
  const segmentEnds = new Map<string, RunTrajectoryRecord>();
  for (const record of ordered) {
    if (
      record.kind === "RUNTIME" &&
      record.title === "agent.segment.completed" &&
      record.segmentId
    )
      segmentEnds.set(record.segmentId, record);
  }
  // The start may have fallen out of the server's latest event page before the
  // segment ended. Reconcile the retained live row after merging all pages.
  return ordered.map((record) => {
    const end = record.segmentId
      ? segmentEnds.get(record.segmentId)
      : undefined;
    if (
      record.status !== "RUNNING" ||
      !end?.completedAt ||
      BigInt(end.sequence) <= BigInt(record.sequence)
    )
      return record;
    return {
      ...record,
      status: "FAILED",
      completedAt: end.completedAt,
      durationMs: Math.max(
        0,
        Date.parse(end.completedAt) - Date.parse(record.startedAt),
      ),
      error:
        end.error ?? "Execution segment ended before this operation completed.",
    };
  });
}
