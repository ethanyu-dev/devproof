import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ObservedNode,
  StructuredObservation,
} from "@devproof/runtime-protocol";
import {
  businessCheckSchema,
  compileBusinessCheck,
  type ObservationBinding,
} from "./observation-contract.js";
import {
  evaluateObservationTarget,
  boundCriterionError,
} from "./observation-evaluator.js";
import {
  freezeObservationContract,
  observationDigest,
} from "./observation-digest.js";
const contract = compileBusinessCheck(
  businessCheckSchema.parse({
    subjects: ["合规模型映射", "旧版对公转账白名单"],
    state: { label: "配置值", equals: "启用" },
  }),
  { sourceRef: "source", quote: "两种类型显示启用" },
  ["DOM"],
);
function node(id: string, extra: Partial<ObservedNode> = {}): ObservedNode {
  return {
    nodeId: id,
    ref: id,
    frameId: "frame",
    documentEpoch: "doc",
    tag: "div",
    visible: true,
    attributes: {},
    relations: [],
    textLocation: { start: 0, end: 0 },
    ...extra,
  };
}
function capture(): StructuredObservation {
  return {
    version: 2,
    captureId: randomUUID(),
    capturedFrom: new Date().toISOString(),
    capturedUntil: new Date().toISOString(),
    pageIdentity: "https://example.test",
    frames: [{ frameId: "frame", documentEpoch: "doc" }],
    nodes: [
      node("page", { tag: "body" }),
      node("form", { parentId: "page", tag: "form" }),
      ...contract.targets.flatMap((t, i) => [
        node(`row${i}`, { parentId: "form", role: "row" }),
        node(`type${i}`, {
          parentId: `row${i}`,
          role: "cell",
          text: t.identity.text,
        }),
        node(`state${i}`, {
          parentId: `row${i}`,
          role: "cell",
          name: "配置值",
          text: "启用",
        }),
      ]),
    ],
    renderedText: "",
    regions: [],
    consistency: "DOM_ONLY",
    coverage: {
      scope: "VIEWPORT",
      completeWithinScope: true,
      truncated: false,
      unavailableFrames: [],
    },
  };
}
const selection = (i: number) => ({
  scopeRef: `row${i}`,
  entityRef: `type${i}`,
  assertionRefs: { state: `state${i}` },
});
describe("business object and state separation", () => {
  it("independently binds two rows with identical expected states", () => {
    const observation = capture();
    const bindings = contract.targets.map(
      (target, i) =>
        evaluateObservationTarget(target, observation, ["DOM"], selection(i))
          .binding!,
    );
    expect(bindings.map((b) => b.entityKey)).toEqual([
      "合规模型映射",
      "旧版对公转账白名单",
    ]);
    expect(
      bindings.every(
        (b) => b.readiness === "READY" && b.evaluation === "MATCHED",
      ),
    ).toBe(true);
    const full: ObservationBinding[] = bindings.map((b) => ({
      ...b,
      id: randomUUID(),
      runId: randomUUID(),
      attemptId: randomUUID(),
      criterionId: "criterion",
      contractDigest: observationDigest(contract),
      observationId: observation.captureId,
      captureId: observation.captureId,
      sourceCommandId: randomUUID(),
      evidenceRefs: [],
      capturedAt: new Date().toISOString(),
    }));
    const input = {
      contract,
      contractDigest: observationDigest(contract),
      criterionId: "criterion",
      status: "PASSED",
      bindingIds: full.map((b) => b.id),
      comparisonReviewIds: [],
      bindings: full,
      reviews: [],
    };
    expect(boundCriterionError(input)).toBeNull();
    expect(
      boundCriterionError({ ...input, bindingIds: [full[0]!.id] }),
    ).toContain("TARGET_NOT_CONFIRMED");
  });
  it("rejects cross-row state and narrows a parent to the selected row", () => {
    expect(
      evaluateObservationTarget(contract.targets[0]!, capture(), ["DOM"], {
        ...selection(0),
        assertionRefs: { state: "state1" },
      }).binding?.readiness,
    ).toBe("PARTIAL");
    expect(
      evaluateObservationTarget(contract.targets[0]!, capture(), ["DOM"], {
        ...selection(0),
        scopeRef: "form",
      }).binding?.scopeIdentity,
    ).toBe("row0");
    expect(
      evaluateObservationTarget(contract.targets[0]!, capture(), ["DOM"], {
        ...selection(0),
        scopeRef: "form",
        assertionRefs: { state: "state1" },
      }).binding,
    ).toBeUndefined();
    expect(
      evaluateObservationTarget(
        contract.targets[1]!,
        capture(),
        ["DOM"],
        selection(0),
      ).error,
    ).toBeTruthy();
  });
  it("retains a genuine mismatch rather than making evidence selection depend on the desired state", () => {
    const observation = capture();
    observation.nodes.find((n) => n.nodeId === "state1")!.text = "禁用";
    expect(
      evaluateObservationTarget(
        contract.targets[1]!,
        observation,
        ["DOM"],
        selection(1),
      ).binding,
    ).toMatchObject({ readiness: "READY", evaluation: "MISMATCHED" });
  });
  it("rejects a popup option as the selected business object", () => {
    const observation = capture();
    const entity = observation.nodes.find((n) => n.nodeId === "type0")!;
    entity.role = "option";
    expect(
      evaluateObservationTarget(
        contract.targets[0]!,
        observation,
        ["DOM"],
        selection(0),
      ).binding,
    ).toBeUndefined();
  });
  it("requires a selected value and an untouched initial state", () => {
    const check = compileBusinessCheck(
      businessCheckSchema.parse({
        subjects: ["合规模型映射"],
        state: { label: "启用状态", equals: true },
        when: "INITIAL_AFTER_OPEN",
      }),
      { sourceRef: "source", quote: "默认启用" },
      ["DOM"],
    );
    const observation = capture();
    observation.nodes = [
      node("dialog", { role: "dialog" }),
      node("type", {
        parentId: "dialog",
        role: "combobox",
        selectedLabel: "合规模型映射",
        selectedLabelSource: "DISPLAY_RELATION",
      }),
      node("switch", {
        parentId: "dialog",
        role: "switch",
        name: "启用状态",
        checked: true,
      }),
    ];
    observation.regions = [
      {
        nodeId: "dialog",
        epoch: "open1",
        phaseProven: true,
        reopened: false,
        modifiedNodeIds: [],
      },
    ];
    const selected = {
      scopeRef: "dialog",
      entityRef: "type",
      assertionRefs: { state: "switch" },
    };
    expect(
      evaluateObservationTarget(
        check.targets[0]!,
        observation,
        ["DOM"],
        selected,
      ).binding?.readiness,
    ).toBe("READY");
    observation.nodes.push(
      node("type-field", { parentId: "dialog" }),
      node("state-field", { parentId: "dialog" }),
    );
    observation.nodes[1]!.parentId = "type-field";
    observation.nodes[2]!.parentId = "state-field";
    observation.regions.push(
      ...["type-field", "state-field"].map((nodeId) => ({
        nodeId,
        epoch: nodeId,
        phaseProven: true,
        reopened: false,
        modifiedNodeIds: [],
      })),
    );
    expect(
      evaluateObservationTarget(
        check.targets[0]!,
        observation,
        ["DOM"],
        selected,
      ).binding?.readiness,
    ).toBe("READY");
    observation.regions[0]!.modifiedNodeIds = ["switch"];
    expect(
      evaluateObservationTarget(
        check.targets[0]!,
        observation,
        ["DOM"],
        selected,
      ).binding?.reasons,
    ).toContain("PHASE_UNPROVEN");
    delete observation.nodes[1]!.selectedLabelSource;
    observation.nodes[1]!.value = "合规模型映射";
    expect(
      evaluateObservationTarget(
        check.targets[0]!,
        observation,
        ["DOM"],
        selected,
      ).binding,
    ).toBeUndefined();
  });
  it("compiles a comparison and preserves stable target relationships", () => {
    const raw = compileBusinessCheck(
      businessCheckSchema.parse({
        subjects: ["合规模型映射", "旧版对公转账白名单"],
        state: { label: "启用状态", equals: true },
        when: "INITIAL_AFTER_OPEN",
        compareWith: "ZDR",
        dimensions: ["布局", "交互"],
      }),
      { sourceRef: "source", quote: "与 ZDR 一致" },
      ["DOM"],
    );
    const frozen = freezeObservationContract(raw, "criterion");
    expect(frozen.targets).toHaveLength(3);
    expect(frozen.comparisons).toHaveLength(2);
    expect(frozen.targets[2]!.assertions[0]!.expected).toBeUndefined();
    expect(frozen.targets[2]!.phase).toBe("CURRENT");
    expect(
      frozen.targets.every((t) =>
        t.requiredEvidenceKinds.includes("SCREENSHOT"),
      ),
    ).toBe(true);
    expect(
      frozen.comparisons.every(
        (c) => c.referenceTargetId === frozen.targets[2]!.targetId,
      ),
    ).toBe(true);
    expect(freezeObservationContract(raw, "criterion")).toEqual(frozen);
  });
});

it("normalizes a dialog to its form and rejects text expectations on switches", () => {
  const target = compileBusinessCheck(
    businessCheckSchema.parse({
      subjects: ["合规模型映射"],
      state: { label: "启用状态", equals: true },
      when: "INITIAL_AFTER_OPEN",
    }),
    { sourceRef: "source", quote: "默认开启" },
    ["DOM", "SCREENSHOT"],
  ).targets[0]!;
  const observation = capture();
  observation.nodes = [
    node("dialog", { role: "dialog" }),
    node("form", { tag: "form", parentId: "dialog" }),
    node("identity", { text: "合规模型映射", parentId: "form" }),
    node("state", {
      tag: "button",
      role: "switch",
      name: "启用状态",
      checked: true,
      text: "",
      parentId: "form",
    }),
  ];
  observation.regions = [
    {
      nodeId: "form",
      epoch: "open",
      phaseProven: true,
      reopened: false,
      modifiedNodeIds: [],
    },
  ];
  observation.consistency = "DRIFTED";
  observation.verifiedScopeNodeIds = ["form"];
  const selection = {
    scopeRef: "dialog",
    entityRef: "identity",
    assertionRefs: { state: "state" },
  };
  expect(
    evaluateObservationTarget(
      target,
      observation,
      ["DOM", "SCREENSHOT"],
      selection,
    ).binding,
  ).toMatchObject({
    scopeIdentity: "form",
    readiness: "READY",
    evaluation: "MATCHED",
    facts: [{ actual: true, property: "CHECKED" }],
  });
  observation.verifiedScopeNodeIds = ["unrelated"];
  expect(
    evaluateObservationTarget(
      target,
      observation,
      ["DOM", "SCREENSHOT"],
      selection,
    ).binding?.reasons,
  ).toContain("OBSERVATION_DRIFTED");
  target.assertions[0]!.expected = "启用";
  const malformed = evaluateObservationTarget(
    target,
    observation,
    ["DOM", "SCREENSHOT"],
    selection,
  ).binding!;
  expect(malformed.reasons).toContain("STATE_TYPE_MISMATCH:state");
  expect(malformed.evaluation).toBe("UNKNOWN");
});
