import { describe, it, expect } from "vitest";
import { ExecutionJournal } from "./execution-journal.js";
import { taskTestAccount } from "./test-account.js";
import { executionStateSchema } from "@devproof/agent-runtime-protocol";
const evidence = new Map([
  [
    "network-1",
    {
      externalId: "network-1",
      kind: "NETWORK" as const,
      label: "request",
      metadata: {},
    },
  ],
]);
const url = "https://app.test/whitelist-config";
const record = {
  id: 123,
  type: "MAPPING",
  account: "user-uuid",
  config: '{"value":true}',
  user: { phone: "13962083614", uuid: "user-uuid" },
};
const output = (requests: unknown[]) => ({
  evidence: [...evidence.values()],
  result: { actionFeedback: { commandId: "cmd", requests } },
});
const preflight = {
  method: "GET",
  requestId: 0,
  url: `${url}?account=13962083614&type=MAPPING`,
  status: 200,
  responseSummary: '{"data":[]}',
};
const create = {
  method: "POST",
  requestId: 1,
  url,
  status: 200,
  requestSummary: JSON.stringify({ account: "13962083614", type: "MAPPING" }),
  responseSummary: JSON.stringify({ code: 0 }),
};
const listing = {
  method: "GET",
  requestId: 2,
  url,
  status: 200,
  responseSummary: JSON.stringify({ data: [record] }),
};
describe("execution business journal", () => {
  it.each([false, true])(
    "ignores blank and invalid response identities without joining unrelated users (multi=%s)",
    (multi) => {
      const j = new ExecutionJournal(
        multi
          ? {
              testAccounts: [
                {
                  slotId: "target:1",
                  account: "subject-phone",
                  label: "测试账号",
                  usage: "CREATE_OR_MODIFY",
                  aliases: [],
                  requiredTypes: ["MAPPING"],
                },
              ],
            }
          : { executionState: { account: "subject-phone" } },
      );
      j.observe(
        output([
          {
            ...listing,
            responseSummary: JSON.stringify({
              whitelists: [
                {
                  ...record,
                  account: "subject-uuid",
                  user: {
                    uuid: "subject-uuid",
                    phone: " subject-phone ",
                    email: "",
                  },
                },
                {
                  ...record,
                  id: 456,
                  account: "other-uuid",
                  user: { uuid: "other-uuid", phone: "other-phone", email: "" },
                },
                {
                  ...record,
                  account: "subject-uuid",
                  user: { phone: null, email: "  " },
                },
                {
                  ...record,
                  account: "subject-uuid",
                  user: { phone: "执行删除", email: "x".repeat(201) },
                },
              ],
            }),
          },
        ]),
        evidence,
      );
      const aliases = multi
        ? j.state.accounts![0]!.aliases
        : j.state.accountAliases;
      expect(aliases).toEqual(["subject-uuid", "subject-phone"]);
      expect(executionStateSchema.safeParse(j.state).success).toBe(true);
      const restored = new ExecutionJournal({ executionState: j.state });
      expect(restored.state).toEqual(j.state);
    },
  );
  it("recognizes a filtered whitelists/list absence and records the subsequent creation for cleanup", () => {
    const j = new ExecutionJournal({});
    const listUrl = `${url}/list`;
    j.observe(
      output([
        {
          ...preflight,
          url: `${listUrl}?account=13962083614&type=MAPPING`,
          responseSummary: '{"whitelists":[],"total":"0"}',
        },
      ]),
      evidence,
    );
    j.observe(
      output([
        create,
        {
          ...listing,
          url: listUrl,
          responseSummary: JSON.stringify({
            whitelists: [{ ...record, user: { ...record.user, email: "" } }],
            total: "1",
          }),
        },
      ]),
      evidence,
    );
    expect(j.state.records).toEqual([
      expect.objectContaining({
        id: "123",
        resourceUrl: url,
        ownership: "CREATED_THIS_RUN",
        accountAliases: ["user-uuid", "13962083614"],
        cleanup: expect.objectContaining({ status: "PENDING" }),
      }),
    ]);
    expect(executionStateSchema.safeParse(j.state).success).toBe(true);
  });
  it("does not infer absence or ownership from truncated, late, or unrelated list responses", () => {
    for (const change of [
      { responseTruncated: true },
      { url: `https://other.test/list?account=13962083614&type=MAPPING` },
      { url: `${url}/another/list?account=13962083614&type=MAPPING` },
    ]) {
      const j = new ExecutionJournal({});
      j.observe(
        output([{ ...preflight, ...change }, create, listing]),
        evidence,
      );
      expect(j.state.records).toEqual([]);
    }
    const late = new ExecutionJournal({});
    late.observe(output([create, preflight, listing]), evidence);
    expect(late.state.records).toEqual([]);
  });
  it("reconciles a list seen before the POST body, even after resuming without another list read", () => {
    const j = new ExecutionJournal({});
    j.observe(
      output([
        preflight,
        { ...create, bodyPending: true, responseSummary: undefined },
        listing,
      ]),
      evidence,
    );
    expect(j.state.records).toEqual([]);
    expect(j.state.pendingRecords).toHaveLength(1);
    expect(j.state.existingRecordKeys).toEqual([]);
    const resumed = new ExecutionJournal({
      executionState: JSON.parse(JSON.stringify(j.state)),
    });
    resumed.observe(output([{ ...create, bodyPending: false }]), evidence);
    expect(resumed.state.pendingRecords).toEqual([]);
    expect(resumed.state.records).toEqual([
      expect.objectContaining({
        id: "123",
        ownership: "CREATED_THIS_RUN",
        cleanup: expect.objectContaining({ status: "PENDING" }),
      }),
    ]);
    expect(resumed.pendingCleanup()).toHaveLength(1);
    resumed.observe(output([create, listing]), evidence);
    expect(resumed.state.records).toHaveLength(1);
  });
  it("does not promote the deferred record when the late receipt rejects creation", () => {
    const j = new ExecutionJournal({});
    j.observe(
      output([
        preflight,
        { ...create, bodyPending: true, responseSummary: undefined },
        listing,
      ]),
      evidence,
    );
    j.observe(
      output([{ ...create, responseSummary: '{"code":400}' }]),
      evidence,
    );
    expect(j.state.records).toEqual([]);
    expect(j.state.pendingRecords).toEqual([]);
    expect(j.state.existingRecordKeys).toHaveLength(1);
  });
  it("can resolve an action-feedback pending record through a later page.network artifact", () => {
    const j = new ExecutionJournal({});
    j.observe(
      output([
        preflight,
        { ...create, bodyPending: true, responseSummary: undefined },
        listing,
      ]),
      evidence,
    );
    const refs = new Map([
      ...evidence,
      [
        "artifact://receipt",
        {
          externalId: "artifact://receipt",
          kind: "NETWORK" as const,
          label: "",
          metadata: {},
        },
      ],
    ]);
    j.observe(
      {
        artifacts: [{ id: "receipt", kind: "NETWORK" }],
        result: {
          content: JSON.stringify([
            {
              method: "POST",
              url,
              status: 200,
              timestamp: "late",
              requestBody: JSON.parse(create.requestSummary),
              responseBody: { code: 0 },
            },
          ]),
        },
      },
      refs,
    );
    expect(j.state.records[0]).toMatchObject({
      id: "123",
      ownership: "CREATED_THIS_RUN",
    });
    expect(j.state.records[0]?.evidenceRefs).toEqual(
      expect.arrayContaining(["artifact://receipt", "network-1"]),
    );
  });
  it("keeps pending record evidence separate from a later receipt's evidence", () => {
    const j = new ExecutionJournal({});
    j.observe(
      output([
        preflight,
        { ...create, bodyPending: true, responseSummary: undefined },
        listing,
      ]),
      evidence,
    );
    const receiptEvidence = new Map([
      ...evidence,
      [
        "late-receipt",
        { ...evidence.get("network-1")!, externalId: "late-receipt" },
      ],
    ]);
    j.observe(
      { ...output([create]), evidence: [receiptEvidence.get("late-receipt")] },
      receiptEvidence,
    );
    expect(j.state.records[0]?.evidenceRefs).toEqual(
      expect.arrayContaining(["network-1", "late-receipt"]),
    );
  });
  it("rejects account changes without mutating identity and preserves it when omitted", () => {
    const j = new ExecutionJournal({
      executionState: {
        account: "original",
        accountAliases: ["uuid-original"],
        accountConflict: "conflict",
      },
    });
    const before = structuredClone(j.state);
    expect(() => j.update({ ...j.state, account: "replacement" })).toThrow(
      "TEST_ACCOUNT",
    );
    expect(j.state).toEqual(before);
    const { account: _account, ...progress } = j.state;
    expect(j.state).not.toHaveProperty("accountConflict");
    j.update({ ...progress, step: "继续核对" });
    expect(j.state).toMatchObject({
      account: "original",
      accountAliases: ["uuid-original"],
    });
    const unallocated = new ExecutionJournal({});
    expect(() =>
      unallocated.update({ ...unallocated.state, account: "replacement" }),
    ).toThrow("TEST_ACCOUNT");
    expect(unallocated.state.account).toBeUndefined();
  });
  it("keeps created identity across human resume and rejects redundant account requests", () => {
    const j = new ExecutionJournal({});
    j.state.account = "13962083614";
    j.observe(output([preflight, create, listing]), evidence);
    expect(j.state.records[0]).toMatchObject({
      id: "123",
      ownership: "CREATED_THIS_RUN",
      cleanup: { status: "PENDING" },
    });
    expect(j.state.accountAliases).toContain("user-uuid");
    const resumed = new ExecutionJournal({
      executionState: JSON.parse(JSON.stringify(j.state)),
    });
    expect(
      resumed.accountRequestError({ existingRecord: { id: 123 } }),
    ).toContain("本次执行创建");
    expect(() => resumed.update({ ...resumed.state, records: [] })).toThrow(
      "不能遗失",
    );
  });
  it("reconstructs ownership from the actual page.network artifact shape", () => {
    const j = new ExecutionJournal({});
    const refs = new Map([
      [
        "artifact://network",
        {
          externalId: "artifact://network",
          kind: "NETWORK" as const,
          label: "",
          metadata: {},
        },
      ],
    ]);
    const entries = [preflight, create, listing].map((r, i) => ({
      ...r,
      timestamp: String(i),
      responseBody: JSON.parse(r.responseSummary),
      ...("requestSummary" in r
        ? { requestBody: JSON.parse(String(r.requestSummary)) }
        : {}),
    }));
    j.observe(
      {
        artifacts: [{ id: "network", kind: "NETWORK" }],
        result: { content: JSON.stringify(entries) },
      },
      refs,
    );
    expect(j.state.records[0]).toMatchObject({
      id: "123",
      ownership: "CREATED_THIS_RUN",
      evidenceRefs: ["artifact://network"],
    });
  });
  it("does not claim a pre-existing record or a rejected creation", () => {
    const old = new ExecutionJournal({});
    old.observe(output([listing]), evidence);
    old.observe(output([preflight, create, listing]), evidence);
    expect(old.state.records).toEqual([]);
    const rejected = new ExecutionJournal({});
    rejected.observe(output([{ ...create, status: 400 }, listing]), evidence);
    expect(rejected.state.records).toEqual([]);
    const businessError = new ExecutionJournal({});
    businessError.observe(
      output([{ ...create, responseSummary: '{"code":400}' }, listing]),
      evidence,
    );
    expect(businessError.state.records).toEqual([]);
  });
  it("does not turn a pending or late business failure into an owned record", () => {
    const j = new ExecutionJournal({});
    j.observe(
      output([
        preflight,
        { ...create, bodyPending: true, responseSummary: undefined },
      ]),
      evidence,
    );
    j.observe(
      output([
        { ...create, responseSummary: '{"code":400}', bodyPending: false },
        listing,
      ]),
      evidence,
    );
    expect(j.state.records).toEqual([]);
    expect(j.state.writes[0]).toMatchObject({ response: '{"code":400}' });
  });
  it("does not infer ownership from an unrelated endpoint", () => {
    const j = new ExecutionJournal({});
    j.observe(
      output([
        create,
        { ...listing, url: "https://other.test/whitelist-config" },
      ]),
      evidence,
    );
    expect(j.state.records).toEqual([]);
  });
  it("requires an explanation for blocked cleanup and keeps evidence of it", () => {
    const j = new ExecutionJournal({});
    j.observe(output([preflight, create, listing]), evidence);
    const records = j.state.records.map((r) => ({
      ...r,
      cleanup: { instruction: "删除本次记录", status: "BLOCKED" as const },
    }));
    expect(() => j.update({ ...j.state, records })).toThrow("原因");
    j.update({
      ...j.state,
      records: records.map((r) => ({
        ...r,
        cleanup: { ...r.cleanup, note: "删除按钮不可用，需检查记录 123" },
      })),
    });
    expect(j.pendingCleanup()[0]?.cleanup?.note).toContain("123");
  });
  it("uses assigned accounts and human replies, never prose placeholders", () => {
    expect(taskTestAccount("新增记录 账号A 与账号B", {})).toBeUndefined();
    expect(
      taskTestAccount("编辑记录 测试账号：qa@example.com", {}),
    ).toBeUndefined();
    expect(
      taskTestAccount("新增记录", {
        executionState: { account: "assigned-user" },
      }),
    ).toBe("assigned-user");
    expect(
      taskTestAccount("新增白名单\n账号 18868106973", {
        resume: { response: { account: "13962083614" } },
      }),
    ).toBe("13962083614");
    expect(taskTestAccount("页面共有 18868106973 条记录", {})).toBeUndefined();
    expect(
      taskTestAccount("查询记录", {
        resume: {
          response: { account: "13962083614" },
          context: { usage: "READ_EXISTING" },
        },
      }),
    ).toBeUndefined();
  });
});
