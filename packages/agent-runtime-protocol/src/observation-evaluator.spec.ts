import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type {
  ObservedNode,
  StructuredObservation,
} from "@devproof/runtime-protocol";
import {
  observationContractSchema,
  type ObservationBinding,
  type VisualComparisonReview,
} from "./observation-contract.js";
import {
  boundCriterionError,
  evaluateObservationTarget,
} from "./observation-evaluator.js";
import {
  observationDigest,
  freezeObservationContract,
} from "./observation-digest.js";

const contract = observationContractSchema.parse({
  version: 2,
  targets: [
    {
      targetId: "mapping",
      label: "模型映射默认开启",
      scope: { kind: "DIALOG", names: ["新增用户白名单"] },
      entity: {
        controlKind: "SELECT",
        label: "白名单类型",
        property: "SELECTED_LABEL",
        oneOf: ["合规模型映射"],
      },
      phase: "INITIAL_AFTER_OPEN",
      assertions: [
        {
          assertionId: "enabled",
          subject: { kind: "SWITCH", label: "启用状态" },
          property: "CHECKED",
          operator: "EQ",
          expected: true,
        },
      ],
      requiredEvidenceKinds: ["DOM", "SCREENSHOT"],
      temporal: "SAME_OBSERVATION",
    },
  ],
  comparisons: [],
});
const node = (nodeId: string, extra: Partial<ObservedNode>): ObservedNode => ({
  nodeId,
  frameId: "frame",
  documentEpoch: "doc",
  tag: "div",
  visible: true,
  attributes: {},
  relations: [],
  textLocation: { start: 0, end: 0 },
  ...extra,
});
function capture(): StructuredObservation {
  return {
    version: 2,
    captureId: randomUUID(),
    capturedFrom: new Date().toISOString(),
    capturedUntil: new Date().toISOString(),
    pageIdentity: "https://fixture.test",
    frames: [{ frameId: "frame", documentEpoch: "doc" }],
    nodes: [
      node("page", { tag: "body" }),
      node("background", {
        parentId: "page",
        role: "switch",
        name: "启用状态",
        checked: true,
      }),
      node("dialog", {
        parentId: "page",
        role: "dialog",
        name: "新增用户白名单",
      }),
      node("type", {
        parentId: "dialog",
        tag: "select",
        name: "白名单类型",
        selectedLabel: "合规模型映射",
        selectedLabelSource: "NATIVE_SELECT",
      }),
      node("switch", {
        parentId: "dialog",
        role: "switch",
        name: "启用状态",
        checked: true,
      }),
    ],
    renderedText: "",
    regions: [
      {
        nodeId: "dialog",
        epoch: "open-1",
        phaseProven: true,
        reopened: false,
        modifiedNodeIds: [],
      },
    ],
    consistency: "VERIFIED",
    coverage: {
      scope: "VIEWPORT",
      completeWithinScope: true,
      truncated: false,
      unavailableFrames: [],
    },
  };
}
describe("bound object evidence", () => {
  it("distinguishes an unvisited scope from multiple matching scopes", () => {
    const missing = capture();
    missing.nodes = missing.nodes.filter((n) =>
      ["page", "background"].includes(n.nodeId),
    );
    expect(
      evaluateObservationTarget(contract.targets[0]!, missing, ["DOM"]),
    ).toMatchObject({ error: "SCOPE_NOT_OBSERVED", candidates: [] });
    const ambiguous = capture();
    ambiguous.nodes.push({ ...ambiguous.nodes[2]!, nodeId: "other-dialog" });
    expect(
      evaluateObservationTarget(contract.targets[0]!, ambiguous, ["DOM"]),
    ).toMatchObject({ error: "SCOPE_AMBIGUOUS" });
  });
  it("does not turn a clipped or whitespace-altered field value into an exact match", () => {
    const target = structuredClone(contract.targets[0]!);
    target.assertions = [
      {
        assertionId: "value",
        subject: { kind: "FIELD", label: "启用状态" },
        property: "VALUE",
        operator: "EQ",
        expected: "two words",
      },
    ];
    const observation = capture();
    Object.assign(observation.nodes[4]!, {
      tag: "input",
      role: "textbox",
      value: "two  words",
    });
    expect(
      evaluateObservationTarget(target, observation, ["DOM", "SCREENSHOT"])
        .binding?.evaluation,
    ).toBe("MISMATCHED");
    Object.assign(observation.nodes[4]!, {
      value: "two words",
      truncatedProperties: ["VALUE"],
    });
    expect(
      evaluateObservationTarget(target, observation, ["DOM", "SCREENSHOT"])
        .binding,
    ).toMatchObject({ evaluation: "UNKNOWN", readiness: "PARTIAL" });
  });

  it("keeps a modal false counterexample despite background enabled text", () => {
    const observation = capture();
    observation.nodes[4]!.checked = false;
    const result = evaluateObservationTarget(
      contract.targets[0]!,
      observation,
      ["DOM", "SCREENSHOT"],
    ).binding!;
    expect(result).toMatchObject({
      readiness: "READY",
      evaluation: "MISMATCHED",
      facts: [{ actual: false, nodeId: "switch" }],
    });
  });
  it("does not use a different type, search value or cross-frame switch", () => {
    for (const change of ["type", "search", "frame"]) {
      const observation = capture();
      if (change === "type")
        observation.nodes[3]!.selectedLabel = "Another type";
      if (change === "search") {
        delete observation.nodes[3]!.selectedLabel;
        observation.nodes[3]!.value = "合规模型映射";
      }
      if (change === "frame") observation.nodes[4]!.frameId = "other";
      const result = evaluateObservationTarget(
        contract.targets[0]!,
        observation,
        ["DOM", "SCREENSHOT"],
      );
      expect(result.binding?.readiness).not.toBe("READY");
    }
  });
  it.each(["edited", "phase", "screenshot", "drift", "truncated"])(
    "keeps incomplete evidence when %s",
    (reason) => {
      const observation = capture();
      if (reason === "edited")
        observation.regions[0]!.modifiedNodeIds.push("switch");
      if (reason === "phase") observation.regions[0]!.phaseProven = false;
      if (reason === "drift") observation.consistency = "DRIFTED";
      if (reason === "truncated") observation.coverage.truncated = true;
      expect(
        evaluateObservationTarget(
          contract.targets[0]!,
          observation,
          reason === "screenshot" ? ["DOM"] : ["DOM", "SCREENSHOT"],
        ).binding?.readiness,
      ).toBe("PARTIAL");
    },
  );
  it("does not accept a quote or a binding from another contract", () => {
    const binding: ObservationBinding = {
      ...evaluateObservationTarget(contract.targets[0]!, capture(), [
        "DOM",
        "SCREENSHOT",
      ]).binding!,
      id: randomUUID(),
      runId: randomUUID(),
      attemptId: randomUUID(),
      criterionId: "check",
      contractDigest: observationDigest(contract),
      observationId: randomUUID(),
      captureId: randomUUID(),
      sourceCommandId: randomUUID(),
      capturedAt: new Date().toISOString(),
      evidenceRefs: [],
    };
    const input = {
      contract,
      contractDigest: observationDigest(contract),
      criterionId: "check",
      status: "PASSED",
      bindingIds: [binding.id],
      comparisonReviewIds: [],
      bindings: [binding],
      reviews: [],
    };
    expect(boundCriterionError(input)).toBeNull();
    expect(
      boundCriterionError({ ...input, contractDigest: "a".repeat(64) }),
    ).toContain("BINDING_NOT_AVAILABLE");
    expect(boundCriterionError({ ...input, bindingIds: [] })).toContain(
      "TARGET_NOT_CONFIRMED",
    );
  });
  it("cannot prove the initial state after an edited control disappears", () => {
    const observation = capture();
    observation.regions[0]!.modifiedNodeIds.push("old-switch");
    const binding = evaluateObservationTarget(
      contract.targets[0]!,
      observation,
      ["DOM", "SCREENSHOT"],
    ).binding!;
    expect(binding).toMatchObject({
      evaluation: "MATCHED",
      readiness: "PARTIAL",
      phaseProven: false,
      reasons: ["PHASE_UNPROVEN"],
    });
    // The current value is still readable; only its claimed default phase is lost.
    expect(
      evaluateObservationTarget(
        { ...contract.targets[0]!, phase: "CURRENT" },
        observation,
        ["DOM", "SCREENSHOT"],
      ).binding,
    ).toMatchObject({ evaluation: "MATCHED", readiness: "READY" });
  });
  it("requires resolving visual conflicts even when a new capture uses different bindings", () => {
    const comparisonContract = observationContractSchema.parse({
      ...contract,
      targets: [
        contract.targets[0]!,
        { ...contract.targets[0]!, targetId: "reference" },
      ],
      comparisons: [
        {
          comparisonId: "style",
          subjectTargetId: "mapping",
          referenceTargetId: "reference",
          dimensions: ["开关形式"],
          sourceRef: "source",
          quote: "开关形式一致",
        },
      ],
    });
    const digest = observationDigest(comparisonContract);
    const runId = randomUUID(),
      attemptId = randomUUID();
    const bindings: ObservationBinding[] = Array.from(
      { length: 4 },
      (_, i) => ({
        ...evaluateObservationTarget(contract.targets[0]!, capture(), [
          "DOM",
          "SCREENSHOT",
        ]).binding!,
        id: randomUUID(),
        runId,
        attemptId,
        criterionId: "check",
        targetId: i % 2 ? "reference" : "mapping",
        contractDigest: digest,
        observationId: randomUUID(),
        captureId: randomUUID(),
        sourceCommandId: randomUUID(),
        capturedAt: new Date().toISOString(),
        evidenceRefs: [],
      }),
    );
    const reviews: VisualComparisonReview[] = ["DIFFERENT", "EQUIVALENT"].map(
      (verdict, i) => ({
        id: randomUUID(),
        criterionId: "check",
        contractDigest: digest,
        comparisonId: "style",
        bindingIds: [bindings[i * 2]!.id, bindings[i * 2 + 1]!.id],
        deliveryId: randomUUID(),
        verdict: verdict as "DIFFERENT" | "EQUIVALENT",
        rationale: "Compare the observed switch appearance.",
        dimensions: ["开关形式"],
      }),
    );
    const input = {
      contract: comparisonContract,
      contractDigest: digest,
      criterionId: "check",
      status: "PASSED",
      bindingIds: bindings.slice(2).map((b) => b.id),
      comparisonReviewIds: [reviews[1]!.id],
      bindings,
      reviews,
    };
    expect(boundCriterionError(input)).toBe("COMPARISON_REVIEW_CONFLICT:style");
    const correction: VisualComparisonReview = {
      ...reviews[0]!,
      id: randomUUID(),
      deliveryId: randomUUID(),
      verdict: "EQUIVALENT",
      supersedesReviewId: reviews[0]!.id,
    };
    expect(
      boundCriterionError({ ...input, reviews: [...reviews, correction] }),
    ).toBeNull();
    expect(
      boundCriterionError({
        ...input,
        status: "FAILED",
        bindingIds: bindings.slice(0, 2).map((b) => b.id),
        comparisonReviewIds: [reviews[0]!.id],
      }),
    ).toBeNull();
  });
  it("freezes stable IDs and digests while rejecting illegal assertions", () => {
    expect(freezeObservationContract(contract, "check")).toEqual(
      freezeObservationContract(contract, "check"),
    );
    expect(observationDigest({ a: 1, b: 2 })).toBe(
      observationDigest({ b: 2, a: 1 }),
    );
    const invalid = structuredClone(contract);
    (invalid.targets[0]!.assertions[0] as { expected: unknown }).expected =
      "true";
    expect(observationContractSchema.safeParse(invalid).success).toBe(false);
  });
});
