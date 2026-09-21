import { expect, it } from "vitest";
import type { RuntimeEvidenceRef } from "@devproof/agent-runtime-protocol";
import { ExecutionJournal } from "./execution-journal.js";
import { prepareDataPrecondition } from "./data-precondition.js";
const reference = "artifact://observed";
const evidence = new Map([
  [
    reference,
    {
      externalId: reference,
      kind: "DOM",
      label: "record",
      metadata: {},
    } as RuntimeEvidenceRef,
  ],
]);
const context = {
  criterionIds: ["create"],
  records: [
    {
      id: "133",
      account: "test-user",
      type: "MAPPING",
      evidenceRefs: [reference],
    },
  ],
};
const journal = () =>
  new ExecutionJournal({ executionState: { account: "test-user" } });
it("allows existing-account conflicts, binds exact records and prevents repeat HITL after a reply", () => {
  const resolved = prepareDataPrecondition(
    context,
    {},
    journal(),
    ["create"],
    evidence,
  );
  expect(resolved).toMatchObject({
    reason: "DATA_PRECONDITION_CONFLICT",
    records: context.records,
  });
  expect(() =>
    prepareDataPrecondition(
      context,
      {
        humanResolutions: [
          {
            kind: "DATA_PRECONDITION",
            context: resolved,
            response: { instructions: "可以先删除开展后续测试" },
          },
        ],
      },
      journal(),
      ["create"],
      evidence,
    ),
  ).toThrow("已收到人工答复");
  const changed = {
    ...context,
    records: [{ ...context.records[0]!, id: "134" }],
  };
  expect(
    prepareDataPrecondition(
      changed,
      { resume: { kind: "DATA_PRECONDITION", context: resolved } },
      journal(),
      ["create"],
      evidence,
    ).records[0]!.id,
  ).toBe("134");
});
it("rejects unrelated accounts, unknown evidence and records created by this execution", () => {
  expect(() =>
    prepareDataPrecondition(
      {
        ...context,
        records: [{ ...context.records[0]!, account: "another-user" }],
      },
      {},
      journal(),
      ["create"],
      evidence,
    ),
  ).toThrow("已经提供");
  expect(() =>
    prepareDataPrecondition(context, {}, journal(), ["create"], new Map()),
  ).toThrow("证据");
  const j = journal();
  j.state.records.push({
    id: "133",
    type: "MAPPING",
    accountAliases: [],
    ownership: "CREATED_THIS_RUN",
    evidenceRefs: [reference],
  });
  expect(() =>
    prepareDataPrecondition(context, {}, j, ["create"], evidence),
  ).toThrow("本次创建");
});

it("accepts supplementary screenshots but still requires structural evidence and rejects mistyped IDs", () => {
  const screenshot = "artifact://screenshot";
  const mixed = new Map(evidence);
  mixed.set(screenshot, {
    externalId: screenshot,
    kind: "SCREENSHOT",
    label: "page",
    metadata: {},
  });
  const input = {
    ...context,
    records: [
      { ...context.records[0]!, evidenceRefs: [reference, screenshot] },
    ],
  };
  expect(
    prepareDataPrecondition(input, {}, journal(), ["create"], mixed).records[0]!
      .evidenceRefs,
  ).toHaveLength(2);
  expect(() =>
    prepareDataPrecondition(
      {
        ...input,
        records: [{ ...input.records[0]!, evidenceRefs: [screenshot] }],
      },
      {},
      journal(),
      ["create"],
      mixed,
    ),
  ).toThrow("至少需要");
  expect(() =>
    prepareDataPrecondition(
      {
        ...input,
        records: [
          {
            ...input.records[0]!,
            evidenceRefs: [reference, "artifact://typo"],
          },
        ],
      },
      {},
      journal(),
      ["create"],
      mixed,
    ),
  ).toThrow("artifact://typo");
});

it("allows a human to identify an unexposed record ID without fabricating it", () => {
  const { id: _id, ...unidentified } = context.records[0]!;
  const result = prepareDataPrecondition(
    { ...context, records: [unidentified] },
    {},
    journal(),
    ["create"],
    evidence,
  );
  expect(result.records[0]!.id).toBeUndefined();
  expect(result.conflictKey).toContain("UNIDENTIFIED");
});

it("accepts an observed SKU resource without inventing an account and rejects ungrounded identities", async () => {
  const { BrowserObservations } = await import("./browser-observation.js");
  const { runtimeActionCommandInputSchema } =
    await import("@devproof/runtime-protocol");
  const observations = new BrowserObservations(undefined, true);
  observations.capture(
    runtimeActionCommandInputSchema.parse({
      commandType: "page.snapshot",
      payload: {},
    }),
    {
      status: "SUCCEEDED",
      result: {
        content: '- <div> "SKU MA-llm-234 范围冲突" [ref=f1e1]',
        url: "https://app.test",
      },
      artifacts: [{ id: "observed", kind: "DOM" }],
    },
  );
  observations.deliverCurrentPage(observations.currentPage(true));
  const raw = {
    criterionIds: ["create"],
    records: [
      {
        type: "product-discount",
        resource: { kind: "SKU", key: "MA-llm-234" },
        citations: [{ ref: "f1e1" }],
      },
    ],
  };
  const result = prepareDataPrecondition(
    raw,
    {},
    new ExecutionJournal({}),
    ["create"],
    evidence,
    observations,
  );
  expect(result.records[0]).toMatchObject({
    resource: { kind: "SKU", key: "MA-llm-234" },
  });
  expect(result.records[0]?.account).toBeUndefined();
  expect(() =>
    prepareDataPrecondition(
      {
        ...raw,
        records: [
          { ...raw.records[0], resource: { kind: "SKU", key: "other" } },
        ],
      },
      {},
      journal(),
      ["create"],
      evidence,
      observations,
    ),
  ).toThrow("资源冲突");
  expect(() =>
    prepareDataPrecondition(
      {
        ...raw,
        records: [
          {
            type: "product-discount",
            resource: { kind: "SKU", key: "MA-llm-234" },
            evidenceRefs: [reference],
          },
        ],
      },
      {},
      journal(),
      ["create"],
      evidence,
      observations,
    ),
  ).toThrow("资源冲突");
});
