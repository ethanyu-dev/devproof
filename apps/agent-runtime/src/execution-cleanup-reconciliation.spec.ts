import { describe, expect, it } from "vitest";
import { executionStateSchema } from "@devproof/agent-runtime-protocol";
import { ExecutionJournal } from "./execution-journal.js";

const url = "https://test.example/whitelists";
const account = "test-account";
const evidence = new Map([
  [
    "network",
    {
      externalId: "network",
      kind: "NETWORK" as const,
      label: "回执",
      metadata: {},
    },
  ],
]);
const record = (id: number, type = "MAPPING", value = true) => ({
  id,
  type,
  account,
  config: { value },
});
const read = (requestId: number, rows: unknown[], extra = {}) => ({
  requestId,
  method: "GET",
  url: `${url}?account=${account}`,
  status: 200,
  responseSummary: JSON.stringify({ data: rows, total: rows.length }),
  ...extra,
});
const write = (
  requestId: number,
  method: string,
  request: unknown,
  extra = {},
) => ({
  requestId,
  method,
  url,
  status: 200,
  requestSummary: JSON.stringify(request),
  responseSummary: '{"code":0}',
  ...extra,
});
const create = (requestId = 1) =>
  write(requestId, "POST", { account, type: "MAPPING" });
const observe = (j: ExecutionJournal, requests: unknown[]) =>
  j.observe(
    {
      evidence: [...evidence.values()],
      result: { actionFeedback: { commandId: "cmd", requests } },
    },
    evidence,
  );
const resume = (j: ExecutionJournal) =>
  new ExecutionJournal({ executionState: JSON.parse(JSON.stringify(j.state)) });

describe("automatic cleanup reconciliation", () => {
  it("does not register post-edit state as a baseline when the PUT body arrives late", () => {
    const j = new ExecutionJournal({});
    observe(j, [
      write(1, "PUT", undefined, {
        bodyPending: true,
        responseSummary: undefined,
      }),
      read(2, [record(33, "MAPPING", false)]),
    ]);
    expect(j.state.observedRecords).toEqual([]);
    const restored = resume(j);
    observe(restored, [
      write(1, "PUT", record(33, "MAPPING", false)),
      read(3, [record(33, "MAPPING", false)]),
    ]);
    expect(restored.state.records).toEqual([]);
    expect(restored.state.cleanupConfirmations).toEqual([]);
    expect(restored.unresolvedWrites()).toHaveLength(1);
    expect(restored.cleanupNotice()).toBeDefined();
  });

  it("preserves a true pre-edit baseline across a delayed body and resume", () => {
    const j = new ExecutionJournal({});
    observe(j, [
      read(0, [record(33)]),
      write(1, "PUT", undefined, {
        bodyPending: true,
        responseSummary: undefined,
      }),
      read(2, [record(33, "MAPPING", false)]),
    ]);
    const restored = resume(j);
    observe(restored, [write(1, "PUT", record(33, "MAPPING", false))]);
    expect(restored.state.records[0]).toMatchObject({
      initialState: '{"value":true}',
      baselineObservation: { sequence: 0 },
      cleanup: { status: "PENDING" },
    });
    observe(restored, [write(3, "PUT", record(33)), read(4, [record(33)])]);
    expect(restored.state.records[0]?.cleanup).toMatchObject({
      status: "COMPLETED",
      resolution: "RESTORED",
    });
    expect(restored.cleanupNotice()).toBeUndefined();
  });

  it("rejects a baseline whose timestamp contradicts its observed order", () => {
    const j = new ExecutionJournal({});
    observe(j, [
      read(0, [record(33)], { timestamp: "2026-09-19T01:01:00Z" }),
      write(1, "PUT", record(33), { timestamp: "2026-09-19T01:00:00Z" }),
      read(2, [record(33)]),
    ]);
    expect(j.state.records).toEqual([]);
    expect(() =>
      j.update({
        records: [
          {
            recordRef: j.state.observedRecords[0]!.recordRef,
            evidenceRefs: ["network"],
            cleanup: { status: "PENDING", instruction: "恢复" },
          },
        ],
      }),
    ).toThrow("写入前");
    expect(j.cleanupNotice()).toBeDefined();
  });

  it("does not auto-register a legacy candidate with unknown observation order", () => {
    const j = new ExecutionJournal({});
    observe(j, [read(0, [record(33)])]);
    delete j.state.observedRecords[0]!.baselineObservation;
    const restored = resume(j);
    observe(restored, [write(1, "PUT", record(33)), read(2, [record(33)])]);
    expect(restored.state.records).toEqual([]);
    expect(restored.cleanupNotice()).toBeDefined();
  });

  it.each([
    { url: `${url}?account=other-account` },
    { url: `${url}?account=${account}&type=OTHER` },
    { url: `${url}?id=36` },
    { url: `${url}/36` },
    { url: `${url}?account=${account}&account=other-account` },
    { url: `${url}?account=${account}&status=disabled` },
    { responseSummary: '{"data":[],"total":10}' },
    { responseTruncated: true },
  ])(
    "keeps retention after a query that cannot establish the record's absence: %j",
    (extra) => {
      const j = new ExecutionJournal({});
      observe(j, [read(0, []), create(), read(2, [record(35)])]);
      j.update({
        records: [
          {
            recordRef: j.state.records[0]!.recordRef,
            cleanup: {
              status: "RETAINED",
              instruction: "Spec：后续测试需要时保留",
              note: "后续测试完成后清理",
            },
          },
        ],
      });
      const restored = resume(j);
      observe(restored, [read(3, [], extra)]);
      expect(restored.state.records[0]?.cleanup?.status).toBe("RETAINED");
      expect(restored.cleanupNotice()).toBeUndefined();
      // A complete query of the right account must still reopen the reminder.
      observe(restored, [read(4, [])]);
      expect(restored.state.records[0]?.cleanup?.status).toBe("PENDING");
      expect(restored.cleanupNotice()).toBeDefined();
    },
  );

  it("does not invent a restoration obligation for a definitively rejected edit", () => {
    const j = new ExecutionJournal({});
    observe(j, [
      read(0, [record(33)]),
      write(1, "PUT", record(33, "MAPPING", false), { status: 403 }),
      read(2, [record(33)]),
    ]);
    expect(j.state.records).toEqual([]);
    expect(j.cleanupNotice()).toBeUndefined();
  });
  it("does not assign multiple new IDs to a single ambiguous creation receipt", () => {
    const j = new ExecutionJournal({});
    observe(j, [read(0, []), create(), read(2, [record(35), record(36)])]);
    expect(j.state.records).toEqual([]);
    expect(j.unresolvedWrites()).toHaveLength(1);
    const identified = new ExecutionJournal({});
    observe(identified, [
      read(0, []),
      { ...create(), responseSummary: '{"data":{"id":35}}' },
      read(2, [record(35), record(36)]),
    ]);
    expect(identified.state.records.map((r) => r.id)).toEqual(["35"]);
  });
  it("replays two new types followed by deletion using an account-wide baseline", () => {
    const j = new ExecutionJournal({});
    const original = record(13, "REAL_NAME");
    observe(j, [
      read(0, [original]),
      create(),
      read(2, [original, record(35)]),
    ]);
    observe(j, [
      write(3, "POST", { account, type: "LEGACY" }),
      read(4, [original, record(35), record(36, "LEGACY")]),
    ]);
    expect(j.state.records.map((r) => r.id)).toEqual(["35", "36"]);
    const restored = resume(j);
    observe(restored, [
      write(5, "DELETE", { id: 35 }),
      write(6, "DELETE", { id: 36 }),
      read(7, [original]),
    ]);
    expect(
      restored.state.records.every(
        (r) =>
          r.cleanup?.status === "COMPLETED" &&
          r.cleanup.resolution === "DELETED",
      ),
    ).toBe(true);
    expect(restored.unresolvedWrites()).toEqual([]);
    expect(restored.cleanupNotice()).toBeUndefined();
    expect(executionStateSchema.safeParse(restored.state).success).toBe(true);
    observe(restored, [write(5, "DELETE", { id: 35 }), read(7, [original])]);
    expect(restored.state.records).toHaveLength(2);
    expect(restored.state.cleanupConfirmations).toHaveLength(2);
  });

  it.each([
    {
      responseSummary: JSON.stringify({
        data: [record(13, "OTHER")],
        total: 20,
      }),
    },
    { responseTruncated: true },
    { url: `${url}?account=${account}&status=enabled` },
    { url: `${url}?account=${account}&account=other` },
    { url: `${url}?account=other` },
    { url: "https://other.example/whitelists?account=test-account" },
    {
      responseSummary: JSON.stringify({
        data: [{ id: 13, account }],
        total: 1,
      }),
    },
    { responseSummary: JSON.stringify({ data: [record(13)], total: 1 }) },
  ])(
    "does not derive absence from incomplete, filtered or contradictory baselines: %j",
    (extra) => {
      const j = new ExecutionJournal({});
      observe(j, [
        read(0, [record(13, "OTHER")], extra),
        create(),
        read(2, [record(35)]),
      ]);
      expect(j.state.records).toEqual([]);
      expect(j.unresolvedWrites()).toHaveLength(1);
    },
  );

  it("never uses a late/replayed baseline or conflicting create ID to claim ownership", () => {
    for (const requests of [
      [create(), read(0, []), read(2, [record(35)])],
      [
        read(0, []),
        { ...create(), responseSummary: '{"data":{"id":36}}' },
        read(2, [record(35)]),
      ],
      [
        read(0, [], { timestamp: "2026-09-19T01:01:00Z" }),
        { ...create(), timestamp: "2026-09-19T01:00:00Z" },
        read(2, [record(35)]),
      ],
    ]) {
      const j = new ExecutionJournal({});
      observe(j, requests);
      expect(j.state.records).toEqual([]);
    }
  });

  it("auto-registers a pre-edit baseline, restores it and independently retains a new record", () => {
    const j = new ExecutionJournal({});
    observe(j, [read(0, [record(33)])]);
    observe(j, [
      write(1, "PUT", record(33, "MAPPING", false)),
      read(2, [record(33, "MAPPING", false)]),
    ]);
    expect(j.state.records[0]).toMatchObject({
      id: "33",
      ownership: "EXISTING",
      initialState: '{"value":true}',
      cleanup: { status: "PENDING" },
    });
    observe(j, [
      write(3, "POST", { account, type: "LEGACY" }),
      read(4, [record(33, "MAPPING", false), record(34, "LEGACY")]),
    ]);
    observe(j, [
      write(5, "PUT", record(33)),
      read(6, [record(33), record(34, "LEGACY")]),
    ]);
    expect(j.state.records[0]?.cleanup).toMatchObject({
      status: "COMPLETED",
      resolution: "RESTORED",
    });
    const own = j.state.records.find((r) => r.id === "34")!;
    j.update({
      records: [
        {
          recordRef: own.recordRef,
          cleanup: {
            status: "RETAINED",
            instruction: "Spec：后续用例需要时保留；无需继续使用时删除。",
            note: "后续环境用例仍需记录 34，执行结束后由该用例清理。",
          },
        },
      ],
    });
    expect(j.cleanupNotice()).toBeUndefined();
    expect(resume(j).state.records[1]?.cleanup?.status).toBe("RETAINED");
    observe(j, [
      write(7, "PUT", record(34, "LEGACY", false)),
      read(8, [record(33), record(34, "LEGACY", false)]),
    ]);
    expect(j.state.records[1]?.cleanup?.status).toBe("PENDING");
  });

  it("does not treat deleting an existing record as restoring it", () => {
    const j = new ExecutionJournal({});
    observe(j, [
      read(0, [record(33)]),
      write(1, "DELETE", { id: 33 }),
      read(2, []),
    ]);
    expect(j.state.records[0]?.cleanup?.status).toBe("PENDING");
    expect(j.state.cleanupConfirmations).toEqual([]);
  });

  it("clears an old review after a delayed receipt and fresh cleanup proof resolve it", () => {
    const j = new ExecutionJournal({});
    observe(j, [
      read(0, []),
      { ...create(), bodyPending: true, responseSummary: undefined },
      read(2, [record(35)]),
    ]);
    j.blockCleanup("创建回执尚未完成采集");
    expect(j.state.cleanupReview).toBeDefined();
    const restored = resume(j);
    observe(restored, [create(), write(3, "DELETE", { id: 35 }), read(4, [])]);
    expect(restored.state.cleanupReview).toBeUndefined();
    expect(restored.state.pendingRecords).toEqual([]);
    expect(restored.cleanupNotice()).toBeUndefined();
  });

  it("keeps failed cleanup pending and closes the reminder only after a successful retry", () => {
    const j = new ExecutionJournal({});
    observe(j, [
      read(0, []),
      create(),
      read(2, [record(35)]),
      write(3, "DELETE", { id: 35 }, { status: 500 }),
      read(4, [record(35)]),
    ]);
    j.blockCleanup("删除失败，待重试");
    expect(j.cleanupNotice()).toContain("删除失败");
    observe(j, [write(5, "DELETE", { id: 35 }), read(6, [])]);
    expect(j.cleanupNotice()).toBeUndefined();
    expect(j.state.records[0]?.cleanup?.resolution).toBe("DELETED");
    // A later positive read invalidates the previous completion.
    observe(j, [read(7, [record(35)])]);
    expect(j.state.records[0]?.cleanup?.status).toBe("PENDING");
  });

  it("rejects retained status without a reason, a proven current record, or creation ownership", () => {
    const j = new ExecutionJournal({});
    observe(j, [read(0, []), create(), read(2, [record(35)])]);
    const retention = {
      status: "RETAINED" as const,
      instruction: "按约定保留",
    };
    expect(() =>
      j.update({
        records: [
          { recordRef: j.state.records[0]!.recordRef, cleanup: retention },
        ],
      }),
    ).toThrow("保留依据");
    observe(j, [write(3, "DELETE", { id: 35 }), read(4, [])]);
    expect(() =>
      j.update({
        records: [
          {
            recordRef: j.state.records[0]!.recordRef,
            cleanup: { ...retention, note: "后续用例需要" },
          },
        ],
      }),
    ).toThrow("重新读取");
    const existing = new ExecutionJournal({});
    observe(existing, [read(0, [record(33)]), write(1, "PUT", record(33))]);
    expect(() =>
      existing.update({
        records: [
          {
            recordRef: existing.state.records[0]!.recordRef,
            cleanup: { ...retention, note: "后续使用" },
          },
        ],
      }),
    ).toThrow("既有数据应恢复");
  });
});
