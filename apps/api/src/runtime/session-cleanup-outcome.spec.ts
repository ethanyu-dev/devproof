import { expect, it, vi } from "vitest";
import {
  completedCleanupEvidence,
  hasConfirmedCleanupOutcome,
} from "./session-cleanup-outcome.js";
import { initialWriteState } from "./session-recovery.state.js";

function journal() {
  const resourceUrl = "https://fixture.test/discount";
  return {
    phase: "CLEANUP",
    pendingRecords: [],
    writeHistoryTruncated: false,
    requestOrderTruncated: false,
    records: [
      {
        id: "557",
        recordRef: "record",
        resourceUrl,
        resourceName: "unique-case",
        creationWriteKey: "create",
        ownership: "CREATED_THIS_RUN",
        evidenceRefs: ["created"],
        cleanup: {
          status: "COMPLETED",
          resolution: "DELETED",
          instruction: "Delete our test record",
        },
      },
    ],
    writes: [
      {
        key: "create",
        sequence: 1,
        method: "POST",
        url: resourceUrl,
        status: 200,
        confirmed: true,
        response: '{"code":0}',
        evidenceRefs: ["created"],
      },
      {
        key: "delete",
        sequence: 2,
        method: "DELETE",
        url: `${resourceUrl}?id=557`,
        status: 200,
        confirmed: true,
        response: '{"code":0}',
        evidenceRefs: ["deleted"],
      },
    ],
    readReceipts: [
      {
        key: "read",
        sequence: 3,
        url: `${resourceUrl}/list?name=unique-case`,
        complete: true,
        empty: true,
        recordKeys: [] as string[],
        evidenceRefs: ["queried"],
      },
    ],
    cleanupConfirmations: [
      {
        recordRef: "record",
        writeKey: "delete",
        readKey: "read",
        source: "NETWORK",
        evidenceRefs: ["deleted", "queried"],
      },
    ],
  };
}

it("recognizes machine receipts independently of an inconclusive visual verdict", async () => {
  const state = journal();
  expect(completedCleanupEvidence(state)).toEqual([
    "created",
    "deleted",
    "queried",
  ]);
  const owner = {
    runId: "run",
    attemptId: "attempt",
    snapshot: { executionPolicy: { executionState: state } },
    fencingToken: 1n,
    status: "SUCCEEDED",
    completionId: "done",
    result: { kind: "VERIFICATION_COMPLETED", verdict: "INCONCLUSIVE" },
  };
  const evidence = ["created", "deleted", "queried"].map((externalId) => ({
    externalId,
    kind: "NETWORK",
  }));
  const tx = {
    agentRuntimeTask: { findUnique: vi.fn(async () => owner) },
    executionResourceLease: {
      findMany: vi.fn(async () => [{ mode: "WRITE" }]),
    },
    browserRuntimeCommand: { count: vi.fn(async () => 0) },
    runEvidence: { findMany: vi.fn(async () => evidence) },
  };
  expect(
    await initialWriteState(
      tx as never,
      {
        ownerTaskId: "owner",
        ownerFencingToken: 1n,
        purpose: "EXECUTION",
      } as never,
    ),
  ).toBe("CONFIRMED");
  expect(tx.runEvidence.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ runId: "run", attemptId: "attempt" }),
    }),
  );
  evidence.pop();
  expect(await hasConfirmedCleanupOutcome(tx as never, owner as never)).toBe(
    false,
  );
});

it.each([
  "truncated",
  "order",
  "unconfirmed",
  "failed",
  "blocked",
  "retained",
  "existing",
  "wrong id",
  "wrong query",
  "old read",
  "still present",
  "incomplete read",
  "extra write",
  "duplicate write",
  "UI only",
  "no evidence",
  "unreviewed",
  "business failure",
  "missing response",
  "filtered query",
  "superseded read",
])("does not release an incomplete cleanup chain: %s", (reason) => {
  const s = journal();
  if (reason === "truncated") s.writeHistoryTruncated = true;
  if (reason === "order") s.requestOrderTruncated = true;
  if (reason === "unconfirmed") s.writes[0]!.confirmed = false;
  if (reason === "failed") s.writes[1]!.status = 500;
  if (reason === "business failure") s.writes[1]!.response = '{"code":1}';
  if (reason === "missing response") s.writes[1]!.response = "";
  if (reason === "filtered query") s.readReceipts[0]!.url += "&type=other";
  if (reason === "superseded read")
    s.readReceipts.push({
      ...s.readReceipts[0]!,
      key: "later",
      sequence: 4,
      empty: false,
      recordKeys: ["557"],
    });
  if (reason === "blocked") s.records[0]!.cleanup.status = "BLOCKED";
  if (reason === "retained") s.records[0]!.cleanup.status = "RETAINED";
  if (reason === "existing") s.records[0]!.ownership = "EXISTING";
  if (reason === "wrong id")
    s.writes[1]!.url = "https://fixture.test/discount?id=other";
  if (reason === "wrong query")
    s.readReceipts[0]!.url = "https://fixture.test/discount/list?name=other";
  if (reason === "old read") s.readReceipts[0]!.sequence = 0;
  if (reason === "still present") s.readReceipts[0]!.recordKeys.push("557");
  if (reason === "incomplete read") s.readReceipts[0]!.complete = false;
  if (reason === "extra write")
    s.writes.push({ ...s.writes[0]!, key: "extra" });
  if (reason === "duplicate write") s.writes[1]!.key = "create";
  if (reason === "UI only") s.cleanupConfirmations[0]!.source = "UI";
  if (reason === "no evidence") s.readReceipts[0]!.evidenceRefs = [];
  if (reason === "unreviewed")
    Object.assign(s, {
      cleanupReview: {
        status: "BLOCKED",
        note: "Unknown submission",
        writeKeys: ["extra"],
        evidenceRefs: ["created"],
      },
    });
  expect(completedCleanupEvidence(s)).toEqual([]);
});
