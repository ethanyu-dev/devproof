import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
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

function uiRows(enabled: boolean, time: number, account = "13962083614") {
  return {
    status: "SUCCEEDED",
    evidence: [...evidence.values()],
    result: {
      structuredObservation: {
        version: 2,
        captureId: randomUUID(),
        capturedFrom: new Date(time).toISOString(),
        capturedUntil: new Date(time).toISOString(),
        pageIdentity: "https://app.test/records",
        frames: [],
        regions: [],
        renderedText: "",
        consistency: "VERIFIED",
        coverage: {
          scope: "VIEWPORT",
          completeWithinScope: true,
          truncated: false,
          unavailableFrames: [],
        },
        nodes: [
          { nodeId: "row", tag: "tr" },
          ...["123", account, "合规模型映射", enabled ? "启用" : "禁用"].map(
            (text, i) => ({
              nodeId: `cell-${i}`,
              tag: "td",
              parentId: "row",
              text,
            }),
          ),
        ].map((n) => ({
          ...n,
          ref: n.nodeId,
          frameId: "frame",
          documentEpoch: "frame",
          visible: true,
          attributes: {},
          relations: [],
          textLocation: { start: 0, end: 0 },
        })),
      },
    },
  };
}

it("confirms restoration from a fresh UI read without requiring network receipts", () => {
  const j = new ExecutionJournal({});
  const baseline = uiRows(true, 1000);
  j.observe(baseline, evidence, { commandType: "page.snapshot", payload: {} });
  j.update({
    records: [
      {
        id: "123",
        type: "合规模型映射",
        account: "13962083614",
        ownership: "EXISTING",
        initialState: '{"enabled":true}',
        evidenceRefs: ["network-1"],
        cleanup: { status: "PENDING", instruction: "恢复启用" },
      },
    ],
  });
  expect(j.state.records[0]?.uiBaseline).toBeDefined();
  j.observe(uiRows(false, 2000), evidence, {
    commandType: "page.click",
    payload: {},
  });
  j.observe(uiRows(true, 3000), evidence, {
    commandType: "page.click",
    payload: {},
  });
  expect(j.state.cleanupConfirmations).toEqual([]);
  // Reload returns before the executor's automatic canonical snapshot.
  j.observe({ status: "SUCCEEDED", result: {} }, evidence, {
    commandType: "page.reload",
    payload: {},
  });
  expect(j.state.cleanupConfirmations).toEqual([]);
  j.observe(uiRows(true, 4000), evidence);
  expect(j.state.cleanupConfirmations[0]?.source).toBe("UI");
  j.update({
    records: [
      {
        recordRef: j.state.records[0]!.recordRef,
        evidenceRefs: ["network-1"],
        cleanup: { status: "COMPLETED", instruction: "恢复启用" },
      },
    ],
  });
  expect(j.state.records[0]?.cleanup?.status).toBe("COMPLETED");
  j.observe(uiRows(false, 5000), evidence, {
    commandType: "page.click",
    payload: {},
  });
  expect(j.state.records[0]?.cleanup?.status).toBe("PENDING");
  expect(j.state.cleanupConfirmations).toEqual([]);
});

it("rejects stale, foreign-account and still-modified UI restoration evidence", () => {
  const j = new ExecutionJournal({});
  const baseline = uiRows(true, 1000);
  j.observe(baseline, evidence);
  j.update({
    records: [
      {
        id: "123",
        type: "合规模型映射",
        account: "13962083614",
        ownership: "EXISTING",
        evidenceRefs: ["network-1"],
        cleanup: { status: "PENDING", instruction: "恢复" },
      },
    ],
  });
  for (const read of [
    baseline,
    uiRows(false, 2000),
    uiRows(true, 3000, "other-user"),
  ]) {
    j.observe(read, evidence, { commandType: "page.reload", payload: {} });
    expect(j.state.cleanupConfirmations).toEqual([]);
  }
});

it("does not use identity-only rows as restoration baselines", () => {
  const j = new ExecutionJournal({});
  const baseline = uiRows(true, 1000);
  baseline.result.structuredObservation.nodes.pop();
  j.observe(baseline, evidence);
  j.update({
    records: [
      {
        id: "123",
        account: "13962083614",
        ownership: "EXISTING",
        evidenceRefs: ["network-1"],
        cleanup: { status: "PENDING", instruction: "恢复" },
      },
    ],
  });
  expect(j.state.records[0]?.uiBaseline).toBeUndefined();
  j.observe(
    {
      ...baseline,
      result: {
        structuredObservation: {
          ...baseline.result.structuredObservation,
          captureId: randomUUID(),
          capturedFrom: new Date(2000).toISOString(),
          capturedUntil: new Date(2000).toISOString(),
        },
      },
    },
    evidence,
    { commandType: "page.reload", payload: {} },
  );
  expect(j.state.cleanupConfirmations).toEqual([]);
});

it.each(["UI", "NETWORK"])(
  "invalidates UI cleanup when a later %s read contradicts it",
  (source) => {
    const j = new ExecutionJournal({});
    j.observe(output([listing]), evidence);
    j.observe(uiRows(true, 1000), evidence);
    j.update({
      records: [
        {
          recordRef: j.state.observedRecords[0]!.recordRef,
          evidenceRefs: ["network-1"],
          cleanup: { status: "PENDING", instruction: "恢复" },
        },
      ],
    });
    j.observe(uiRows(true, 2000), evidence, {
      commandType: "page.reload",
      payload: {},
    });
    const recordRef = j.state.records[0]!.recordRef;
    j.update({
      records: [
        {
          recordRef,
          evidenceRefs: ["network-1"],
          cleanup: { status: "COMPLETED", instruction: "恢复" },
        },
      ],
    });
    expect(j.state.records[0]?.cleanup?.status).toBe("COMPLETED");
    if (source === "UI")
      j.observe(uiRows(false, 3000), evidence, {
        commandType: "page.snapshot",
        payload: {},
      });
    else
      j.observe(
        output([
          {
            ...listing,
            requestId: 3,
            responseSummary: JSON.stringify({
              data: [{ ...record, config: '{"value":false}' }],
            }),
          },
        ]),
        evidence,
      );
    expect(j.state.cleanupConfirmations).toEqual([]);
    expect(j.state.records[0]?.cleanup?.status).toBe("PENDING");
    if (source === "NETWORK") {
      j.observe(uiRows(true, 4000), evidence, {
        commandType: "page.reload",
        payload: {},
      });
      expect(j.state.cleanupConfirmations).toEqual([]);
    }
  },
);

it("uses the submitted form and a visible row when the creation list body is unavailable", () => {
  const j = new ExecutionJournal({});
  j.observe(output([preflight]), evidence);
  const form = uiRows(true, 1000);
  form.result.structuredObservation.nodes = [
    {
      ...form.result.structuredObservation.nodes[0]!,
      nodeId: "form",
      tag: "form",
    },
    {
      ...form.result.structuredObservation.nodes[1]!,
      parentId: "form",
      tag: "input",
      text: "",
      value: "13962083614",
    },
    {
      ...form.result.structuredObservation.nodes[2]!,
      parentId: "form",
      tag: "select",
      text: "",
      selectedLabel: "合规模型映射",
      selectedLabelSource: "NATIVE_SELECT",
    },
  ] as typeof form.result.structuredObservation.nodes;
  j.observe(form, evidence);
  const created = uiRows(true, 2000);
  j.observe(
    {
      ...created,
      result: {
        ...created.result,
        actionFeedback: {
          commandId: "cmd",
          requests: [{ ...create, bodyPending: true }],
        },
      },
    },
    evidence,
    { commandType: "page.click", payload: {} },
  );
  expect(j.state.writes[0]?.uiTypeLabel).toBe("合规模型映射");
  // Finishing body capture after the form closed must retain its type mapping.
  j.observe(output([create]), evidence);
  expect(j.state.writes).toHaveLength(1);
  expect(j.state.writes[0]?.uiTypeLabel).toBe("合规模型映射");
  expect(j.state.records).toEqual([]);
  j.update({
    records: [
      {
        id: "123",
        account: "13962083614",
        type: "合规模型映射",
        ownership: "CREATED_THIS_RUN",
        evidenceRefs: ["network-1"],
      },
    ],
  });
  expect(j.state.records[0]).toMatchObject({
    id: "123",
    type: "MAPPING",
    displayType: "合规模型映射",
    resourceUrl: url,
    ownership: "CREATED_THIS_RUN",
  });
  expect(j.unresolvedWrites()).toEqual([]);
  expect(() =>
    j.update({
      records: [
        {
          id: "999",
          account: "13962083614",
          type: "合规模型映射",
          ownership: "CREATED_THIS_RUN",
          evidenceRefs: ["network-1"],
        },
      ],
    }),
  ).toThrow("本次创建归属");
});

it.each(["pageIndex", "page_index"])(
  "recognizes %s pagination for creation and cleanup",
  (pageKey) => {
    const j = new ExecutionJournal({});
    const empty = {
      ...preflight,
      url: `${preflight.url}&${pageKey}=1&pageSize=10`,
      responseSummary: '{"whitelists":[],"total":"0"}',
    };
    j.observe(output([empty, create, listing]), evidence);
    expect(j.state.records[0]?.ownership).toBe("CREATED_THIS_RUN");
    j.observe(
      output([
        {
          method: "DELETE",
          requestId: 3,
          url: `${url}?id=123`,
          status: 200,
          responseSummary: "{}",
        },
        { ...empty, requestId: 4 },
      ]),
      evidence,
    );
    expect(j.state.cleanupConfirmations).toHaveLength(1);
  },
);

it("inherits a pre-mutation canonical baseline rather than locking model display strings", () => {
  const j = new ExecutionJournal({});
  j.observe(output([listing]), evidence);
  expect(j.state.observedRecords[0]).toMatchObject({
    type: "MAPPING",
    initialState: '{"value":true}',
  });
  j.update({
    records: [
      {
        id: "123",
        type: "合规模型映射",
        account: "13962083614",
        ownership: "EXISTING",
        initialState: "配置值为启用",
        evidenceRefs: ["network-1"],
        cleanup: { status: "PENDING", instruction: "恢复" },
      },
    ],
  });
  expect(j.state.records[0]).toMatchObject({
    type: "MAPPING",
    displayType: "合规模型映射",
    resourceUrl: url,
    initialState: '{"value":true}',
  });
  j.observe(
    output([
      {
        method: "PUT",
        requestId: 3,
        url,
        status: 200,
        requestSummary: JSON.stringify({
          id: 123,
          type: "MAPPING",
          account: "user-uuid",
          config: '{"value":true}',
        }),
        responseSummary: "{}",
      },
      { ...listing, requestId: 4 },
    ]),
    evidence,
  );
  expect(j.unreviewedWrites()).toEqual([]);
  expect(j.state.cleanupConfirmations).toHaveLength(1);
});

it("never derives an initial state from a post-mutation read", () => {
  const j = new ExecutionJournal({});
  j.observe(
    output([
      {
        ...create,
        method: "PUT",
        requestSummary: JSON.stringify({
          id: 123,
          type: "MAPPING",
          account: "user-uuid",
        }),
      },
      listing,
    ]),
    evidence,
  );
  expect(j.state.observedRecords).toEqual([]);
});

it("atomically blocks pending records and unidentified writes without claiming cleanup", () => {
  const j = new ExecutionJournal({});
  j.observe(output([listing]), evidence);
  j.update({
    records: [
      {
        recordRef: j.state.observedRecords[0]!.recordRef,
        evidenceRefs: ["network-1"],
        cleanup: { status: "PENDING", instruction: "恢复" },
      },
    ],
  });
  j.observe(output([{ ...create, requestSummary: undefined }]), evidence);
  j.blockCleanup("当前页面无法确认另一笔写入归属");
  expect(j.state.records[0]?.cleanup?.status).toBe("BLOCKED");
  expect(j.unreviewedWriteKeys()).toEqual([]);
  expect(j.unresolvedWrites()).toHaveLength(1);
  expect(j.cleanupNotice()).toContain("当前页面无法确认");
});
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
    resumed.update({ records: [], step: "继续验证已有记录" });
    expect(resumed.state.records).toEqual(j.state.records);
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

it("retains existing-record prerequisites and observed write counts in every model view", () => {
  const journal = new ExecutionJournal({
    executionState: executionStateSchema.parse({
      existingRecordKeys: ["resource:MAPPING:subject"],
      records: [],
    }),
  });
  const view = journal.modelView();
  expect(view.prerequisiteFacts).toMatchObject({
    existingRecordKeys: ["resource:MAPPING:subject"],
    recordedCreateCount: 0,
    createdRecordCount: 0,
  });
  expect(view.writes).toEqual([]);
});

it("persists existing records saved by delivered progress citations", () => {
  const journal = new ExecutionJournal({});
  journal.update(
    executionStateSchema.parse({
      records: [
        {
          id: "133",
          type: "MAPPING",
          account: "subject",
          ownership: "EXISTING",
          evidenceRefs: ["artifact://observed"],
        },
      ],
    }),
  );
  expect(journal.modelView().prerequisiteFacts.existingRecordCount).toBe(1);
  const restored = new ExecutionJournal({ executionState: journal.state });
  expect(restored.modelView().prerequisiteFacts.existingRecordKeys).toEqual([
    ":MAPPING:133",
  ]);
});

it("recognizes a fresh creation after authorized removal of a preexisting conflict", () => {
  const journal = new ExecutionJournal({
    executionState: { account: "13962083614" },
  });
  journal.observe(output([listing]), evidence);
  journal.observe(
    output([{ ...create, method: "DELETE", requestId: 10 }]),
    evidence,
  );
  journal.observe(output([preflight]), evidence);
  journal.observe(
    output([
      create,
      {
        ...listing,
        responseSummary: JSON.stringify({ data: [{ ...record, id: 456 }] }),
      },
    ]),
    evidence,
  );
  expect(journal.state.records).toContainEqual(
    expect.objectContaining({ id: "456", ownership: "CREATED_THIS_RUN" }),
  );
  expect(
    journal.state.records.some(
      (r) => r.id === "123" && r.ownership === "CREATED_THIS_RUN",
    ),
  ).toBe(false);
});

it("merges plan deltas and accepts the allocated legacy account without discarding owned records", () => {
  const j = new ExecutionJournal({
    testAccounts: [
      {
        slotId: "subject:1",
        account: "13962083614",
        usage: "CREATE_OR_MODIFY",
        requiredTypes: ["MAPPING"],
      },
    ],
  });
  j.observe(output([preflight, create, listing]), evidence);
  j.update({ step: "核对开关", account: "13962083614" });
  expect(j.state.phase).toBe("VERIFYING");
  expect(j.state.records).toHaveLength(1);
  expect(j.state.account).toBeUndefined();
  expect(() => j.update({ account: "unallocated" })).toThrow("不能分配");
  expect(() => j.update({ phase: "PREFLIGHT" })).toThrow("不能退回");
  expect(j.cleanupReserveCalls()).toBeGreaterThanOrEqual(10);
});

it("retains unidentified writes, prevents retroactive ownership and reports unresolved cleanup across resume", () => {
  const j = new ExecutionJournal({});
  const { requestSummary: _body, ...missingBody } = create;
  j.observe(output([missingBody]), evidence);
  expect(j.state.writes).toHaveLength(1);
  expect(j.state.phase).toBe("VERIFYING");
  expect(j.unreviewedWrites()).toHaveLength(1);
  expect(j.cleanupNotice()).toContain("不能直接删除");
  expect(j.cleanupReserveCalls()).toBeGreaterThan(0);
  j.observe(output([preflight, listing]), evidence);
  expect(j.state.preflightAbsences).toEqual([]);
  expect(j.state.records).toEqual([]);
  j.update({
    cleanupReview: {
      status: "BLOCKED",
      writeKeys: j.unresolvedWrites().map((w) => w.key),
      evidenceRefs: ["network-1"],
      note: "提交缺失请求体，无法确认归属，需人工核对后处理。",
    },
  });
  const restored = new ExecutionJournal({ executionState: j.state });
  expect(restored.unreviewedWrites()).toEqual([]);
  expect(restored.cleanupNotice()).toContain("需人工核对");
  expect(() =>
    j.update({
      cleanupReview: {
        status: "BLOCKED",
        writeKeys: ["invented"],
        evidenceRefs: ["network-1"],
        note: "需人工核对",
      },
    }),
  ).toThrow("writeKeys");
  const rejected = new ExecutionJournal({});
  rejected.observe(output([{ ...missingBody, status: 400 }]), evidence);
  expect(rejected.unresolvedWrites()).toEqual([]);
});

it("joins action feedback and later network capture using stable request identity", () => {
  const j = new ExecutionJournal({});
  const requestId = "025d306c-0748-448a-94f0-fc18dc8008da";
  j.observe(
    output([
      { ...create, requestId, responseSummary: undefined, bodyPending: true },
    ]),
    evidence,
  );
  j.observe(
    {
      evidence: [...evidence.values()],
      result: {
        content: JSON.stringify([
          {
            ...create,
            requestId,
            requestBody: JSON.parse(create.requestSummary),
            responseBody: { code: 0 },
          },
        ]),
      },
    },
    evidence,
  );
  expect(j.state.writes).toHaveLength(1);
  expect(j.state.writes[0]!.confirmed).toBe(true);
});

it("tracks independent types created sequentially for one account without losing the second cleanup obligation", () => {
  const j = new ExecutionJournal({});
  j.observe(output([preflight, create, listing]), evidence);
  const type = "EMAIL";
  j.observe(
    output([
      {
        ...preflight,
        requestId: 3,
        url: preflight.url.replace("MAPPING", type),
      },
      {
        ...create,
        requestId: 4,
        requestSummary: JSON.stringify({ account: "13962083614", type }),
      },
      {
        ...listing,
        requestId: 5,
        responseSummary: JSON.stringify({
          data: [{ ...record, id: 124, type }],
        }),
      },
    ]),
    evidence,
  );
  expect(j.state.records.map((r) => r.id)).toEqual(["123", "124"]);
  expect(j.pendingCleanup()).toHaveLength(2);
  expect(j.unresolvedWrites()).toEqual([]);
});

it("does not treat HTTP 500 or a truncated receipt history as proof of no writes", () => {
  const j = new ExecutionJournal({});
  j.observe(
    output([
      { ...create, status: 500, responseSummary: '{"error":"late failure"}' },
    ]),
    evidence,
  );
  expect(j.unreviewedWrites()).toHaveLength(1);
  for (let i = 0; i < 201; i++)
    j.observe(
      output([{ ...create, requestId: i + 10, status: 400 }]),
      evidence,
    );
  expect(j.state.writes).toHaveLength(200);
  expect(j.state.writeHistoryTruncated).toBe(true);
  expect(j.unreviewedWriteKeys()).toContain("history:truncated");
  expect(j.cleanupNotice()).toContain("原始网络证据");
  expect(executionStateSchema.safeParse(j.state).success).toBe(true);
  const restored = new ExecutionJournal({ executionState: j.state });
  expect(restored.unreviewedWriteKeys()).toContain("history:truncated");
});

it("reconciles query-ID deletion and a later complete read in the same artifact through a stable recordRef", () => {
  const j = new ExecutionJournal({});
  const deletion = {
    method: "DELETE",
    requestId: 3,
    url: `${url}?id=123`,
    status: 200,
    responseSummary: '{"code":0}',
  };
  const cleared = {
    ...listing,
    requestId: 4,
    url: `${url}?account=13962083614&type=MAPPING`,
    responseSummary: '{"data":[],"total":0}',
  };
  j.observe(output([preflight, create, listing, deletion, cleared]), evidence);
  expect(j.unresolvedWrites()).toEqual([]);
  const original = j.state.records[0]!;
  expect(j.state.cleanupConfirmations).toHaveLength(1);
  j.update({
    records: [
      {
        recordRef: original.recordRef,
        cleanup: { instruction: "删除本轮记录", status: "COMPLETED" },
        evidenceRefs: ["network-1"],
      },
    ],
  });
  expect(j.state.records[0]).toMatchObject({
    id: "123",
    ownership: "CREATED_THIS_RUN",
    resourceUrl: url,
    cleanup: { status: "COMPLETED" },
  });
  expect(
    new ExecutionJournal({ executionState: j.state }).state.records[0]
      ?.recordRef,
  ).toBe(original.recordRef);
});

it.each([
  { url: `${url}?id=123`, requestSummary: '{"id":456}' },
  { url: `${url}?id=123&id=456` },
  { url: `https://other.test/whitelist-config?id=123` },
])(
  "does not join contradictory or cross-resource deletion identities",
  (deletion) => {
    const j = new ExecutionJournal({});
    j.observe(
      output([
        preflight,
        create,
        listing,
        {
          method: "DELETE",
          requestId: 3,
          status: 200,
          responseSummary: '{"code":0}',
          ...deletion,
        },
      ]),
      evidence,
    );
    expect(j.unresolvedWrites()).toHaveLength(1);
    expect(j.state.cleanupConfirmations).toEqual([]);
  },
);

it.each([
  { url: `${url}?page=2`, responseSummary: '{"data":[],"total":15}' },
  {
    url: `${url}?account=other-user&type=MAPPING`,
    responseSummary: '{"data":[],"total":0}',
  },
  {
    url: `${url}?account=13962083614&type=OTHER`,
    responseSummary: '{"data":[],"total":0}',
  },
  { url, responseSummary: '{"data":[],"total":0}', responseTruncated: true },
])(
  "does not confirm cleanup from partial, unrelated, or truncated reads",
  (read) => {
    const j = new ExecutionJournal({});
    j.observe(
      output([
        preflight,
        create,
        listing,
        {
          method: "DELETE",
          requestId: 3,
          url: `${url}?id=123`,
          status: 200,
          responseSummary: '{"code":0}',
        },
        { ...listing, requestId: 4, ...read },
      ]),
      evidence,
    );
    expect(j.state.cleanupConfirmations).toEqual([]);
    expect(() =>
      j.update({
        records: [
          {
            recordRef: j.state.records[0]!.recordRef,
            cleanup: { instruction: "删除", status: "COMPLETED" },
            evidenceRefs: ["network-1"],
          },
        ],
      }),
    ).toThrow("重新核对");
  },
);

it("does not turn replaying a pre-delete empty read into post-delete evidence", () => {
  const j = new ExecutionJournal({});
  j.observe(output([preflight, create, listing]), evidence);
  j.observe(
    output([
      {
        method: "DELETE",
        requestId: 3,
        url: `${url}?id=123`,
        status: 200,
        responseSummary: '{"code":0}',
      },
    ]),
    evidence,
  );
  j.observe(output([preflight]), evidence);
  expect(j.state.cleanupConfirmations).toEqual([]);
});

it("saves independent valid record deltas while rejecting invented ownership", () => {
  const j = new ExecutionJournal({});
  j.observe(output([preflight, create, listing]), evidence);
  const results = j.updatePartial({
    records: [
      { id: "999", ownership: "CREATED_THIS_RUN", evidenceRefs: ["network-1"] },
      {
        recordRef: j.state.records[0]!.recordRef,
        cleanup: {
          instruction: "删除",
          status: "BLOCKED",
          note: "界面不可用，待人工处理",
        },
      },
    ],
  });
  expect(results.map((r) => r.accepted)).toEqual([false, true]);
  expect(j.state.records).toHaveLength(1);
  expect(j.state.records[0]!.cleanup?.status).toBe("BLOCKED");
});

it("rejects an ambiguous legacy ID delta rather than updating a same-ID record on another resource", () => {
  const j = new ExecutionJournal({
    executionState: {
      records: [url, "https://other.test/whitelist-config"].map(
        (resourceUrl) => ({
          id: "123",
          resourceUrl,
          ownership: "EXISTING",
          evidenceRefs: ["network-1"],
        }),
      ),
    },
  });
  expect(() =>
    j.update({ records: [{ id: "123", currentState: "changed" }] }),
  ).toThrow("身份不唯一");
});

it("invalidates a cleanup proof if a later write or positive read changes the record again", () => {
  const j = new ExecutionJournal({});
  j.observe(
    output([
      preflight,
      create,
      listing,
      {
        method: "DELETE",
        requestId: 3,
        url: `${url}?id=123`,
        status: 200,
        responseSummary: '{"code":0}',
      },
      { ...listing, requestId: 4, responseSummary: '{"data":[],"total":0}' },
    ]),
    evidence,
  );
  j.update({
    records: [
      {
        recordRef: j.state.records[0]!.recordRef,
        cleanup: { instruction: "删除", status: "COMPLETED" },
        evidenceRefs: ["network-1"],
      },
    ],
  });
  j.observe(output([{ ...listing, requestId: 5 }]), evidence);
  expect(j.state.cleanupConfirmations).toEqual([]);
  expect(j.state.records[0]!.cleanup?.status).toBe("PENDING");
  j.observe(output([preflight]), evidence);
  expect(j.state.cleanupConfirmations).toEqual([]);
});

it("does not accept a new artifact ID alone as proof of cleanup", () => {
  const j = new ExecutionJournal({});
  j.observe(output([preflight, create, listing]), evidence);
  expect(() =>
    j.update({
      records: [
        {
          recordRef: j.state.records[0]!.recordRef,
          cleanup: { instruction: "删除", status: "COMPLETED" },
          evidenceRefs: ["different-artifact"],
        },
      ],
    }),
  ).toThrow("重新核对");
});

it("confirms restoration from a PUT and subsequent actual state in one artifact, then invalidates a changed state", () => {
  const j = new ExecutionJournal({
    executionState: {
      records: [
        {
          id: "123",
          type: "MAPPING",
          account: "user-uuid",
          resourceUrl: url,
          ownership: "EXISTING",
          initialState: '{"value":true}',
          evidenceRefs: ["network-1"],
          cleanup: { instruction: "恢复初始值", status: "PENDING" },
        },
      ],
    },
  });
  const restore = {
    method: "PUT",
    requestId: 3,
    url: `${url}?id=123`,
    status: 200,
    requestSummary: JSON.stringify({ config: '{"value":true}' }),
    responseSummary: '{"code":0}',
  };
  j.observe(output([restore, { ...listing, requestId: 4 }]), evidence);
  expect(j.state.cleanupConfirmations).toHaveLength(1);
  j.update({
    records: [
      {
        recordRef: j.state.records[0]!.recordRef,
        cleanup: { instruction: "恢复初始值", status: "COMPLETED" },
      },
    ],
  });
  j.observe(
    output([
      {
        ...listing,
        requestId: 5,
        responseSummary: JSON.stringify({
          data: [{ ...record, config: '{"value":false}' }],
        }),
      },
    ]),
    evidence,
  );
  expect(j.state.cleanupConfirmations).toEqual([]);
  expect(j.state.records[0]!.cleanup?.status).toBe("PENDING");
  j.observe(output([{ ...listing, requestId: 4 }]), evidence);
  expect(j.state.cleanupConfirmations).toEqual([]);
});

it.each([
  { url: `${url}?id=123&status=disabled` },
  { url: `${url}/456` },
  { url: `${url}?id=123&type=OTHER` },
  {
    url,
    responseSummary: JSON.stringify({
      data: Array.from({ length: 101 }, (_, i) => ({
        ...record,
        id: i === 100 ? 123 : i + 1000,
      })),
    }),
  },
])("rejects a filtered or oversized read as absence proof", (read) => {
  const j = new ExecutionJournal({});
  j.observe(
    output([
      preflight,
      create,
      listing,
      {
        method: "DELETE",
        requestId: 3,
        url: `${url}?id=123`,
        status: 200,
        responseSummary: '{"code":0}',
      },
      { ...listing, requestId: 4, responseSummary: '{"data":[]}', ...read },
    ]),
    evidence,
  );
  expect(j.state.cleanupConfirmations).toEqual([]);
});

it("correlates a UUID path ID with its collection resource", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const j = new ExecutionJournal({});
  j.observe(
    output([
      preflight,
      create,
      {
        ...listing,
        responseSummary: JSON.stringify({ data: [{ ...record, id }] }),
      },
      {
        method: "DELETE",
        requestId: 3,
        url: `${url}/${id}`,
        status: 200,
        responseSummary: '{"code":0}',
      },
      { ...listing, requestId: 4, responseSummary: '{"data":[]}' },
    ]),
    evidence,
  );
  expect(j.unresolvedWrites()).toEqual([]);
  expect(j.state.cleanupConfirmations).toHaveLength(1);
});
