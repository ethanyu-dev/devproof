import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  observationContractSchema,
  type ObservationBinding,
} from "@devproof/agent-runtime-protocol";
import { observationDigest } from "@devproof/agent-runtime-protocol/observation-digest";
import { BoundEvidence } from "./bound-evidence.js";
import { BrowserObservations } from "./browser-observation.js";
import {
  criterionSubmissionSchema,
  resolveCriterionEvidence,
} from "./criterion-evidence.js";

function fixture() {
  const contract = observationContractSchema.parse({
    version: 2,
    targets: [
      {
        targetId: "type",
        label: "Default",
        scope: { kind: "DIALOG", names: ["New"] },
        entity: {
          controlKind: "SELECT",
          label: "Type",
          property: "SELECTED_LABEL",
          oneOf: ["Mapping"],
        },
        phase: "INITIAL_AFTER_OPEN",
        assertions: [
          {
            assertionId: "enabled",
            subject: { kind: "SWITCH", label: "Enabled" },
            property: "CHECKED",
            operator: "EQ",
            expected: true,
          },
        ],
        requiredEvidenceKinds: ["DOM"],
        temporal: "SAME_OBSERVATION",
      },
    ],
    comparisons: [],
  });
  const runId = randomUUID(),
    attemptId = randomUUID();
  const binding: ObservationBinding = {
    id: randomUUID(),
    runId,
    attemptId,
    criterionId: "check",
    targetId: "type",
    contractDigest: observationDigest(contract),
    observationId: randomUUID(),
    captureId: randomUUID(),
    sourceCommandId: randomUUID(),
    scopeIdentity: "dialog",
    entityKey: "Mapping",
    phase: "INITIAL_AFTER_OPEN",
    phaseProven: true,
    facts: [
      {
        assertionId: "enabled",
        nodeId: "switch",
        property: "CHECKED",
        actual: true,
        evaluation: "MATCHED",
      },
    ],
    evaluation: "MATCHED",
    readiness: "READY",
    evidenceRefs: [`artifact://${randomUUID()}`],
    capturedAt: new Date().toISOString(),
    reasons: [],
  };
  return {
    contract,
    binding,
    memory: new BoundEvidence(
      [{ id: "check", observationContract: contract }],
      runId,
      attemptId,
    ),
  };
}

it("stops retrying immutable binding conflicts and retains the real cause", () => {
  const { memory } = fixture();
  expect(
    memory.bindingResult("type", "page", {
      bindings: [],
      error: "BINDING_CONFLICT",
      retryable: false,
    }),
  ).toMatchObject({
    accepted: false,
    error: "BINDING_CONFLICT",
    retryable: false,
    code: "OBSERVATION_BINDING_EXHAUSTED",
  });
});

it("expands both binding and coverage budgets, prioritizing unfinished criteria", () => {
  const { binding, contract } = fixture();
  const criteria = Array.from({ length: 40 }, (_, i) => ({
    id: `check-${i}`,
    observationContract: contract,
  }));
  const memory = new BoundEvidence(criteria, binding.runId, binding.attemptId);
  memory.ingest({
    bindings: criteria.map((c) => ({
      ...binding,
      id: randomUUID(),
      criterionId: c.id,
    })),
  });
  const small = memory.view(12 * 1024, ["check-39"]);
  const expanded = memory.view(32 * 1024, ["check-39"]);
  expect(expanded.bindings.length).toBeGreaterThan(small.bindings.length);
  expect(expanded.coverage.length).toBeGreaterThan(small.coverage.length);
  expect(expanded.bindings[0]!.criterionId).toBe("check-39");
  expect(expanded.coverage[0]!.criterionId).toBe("check-39");
  expect(Buffer.byteLength(JSON.stringify(expanded))).toBeLessThanOrEqual(
    32 * 1024,
  );
  expect(
    Buffer.byteLength(JSON.stringify(memory.view(1024))),
  ).toBeLessThanOrEqual(1024);
});

it("requires full facts in the actual model request, not IDs or a truncated preview", () => {
  const { binding, memory } = fixture();
  memory.ingest({ bindings: [binding] });
  for (const content of [
    { bindingIds: [binding.id] },
    { ...binding, facts: undefined },
  ]) {
    expect(
      memory.deliveredRequest([{ content: JSON.stringify(content) }], undefined)
        .bindingIds,
    ).toEqual([]);
    expect(memory.resolve("check", "PASSED", [binding.id], []).error).toContain(
      "BINDING_NOT_DELIVERED",
    );
  }
  expect(
    memory.deliveredRequest(
      [{ content: JSON.stringify(memory.view()) }],
      undefined,
    ).bindingIds,
  ).toEqual([binding.id]);
  expect(memory.resolve("check", "PASSED", [binding.id], [])).toEqual({
    evidenceRefs: binding.evidenceRefs,
  });
});

it("limits failed bindings per object and unchanged page, and resets on real progress", () => {
  const { binding, memory } = fixture();
  const failure = {
    bindings: [],
    coverage: [
      {
        criterionId: "check",
        targetId: "type",
        observationId: binding.observationId,
        error: "ENTITY_NOT_CONFIRMED",
      },
    ],
  };
  expect(memory.bindingResult("type", "same-page", failure)).toMatchObject({
    accepted: false,
    retryable: true,
    attempts: 1,
  });
  memory.bindingResult("other", "same-page", failure);
  memory.bindingResult("type", "same-page", failure);
  expect(memory.bindingResult("type", "same-page", failure)).toMatchObject({
    accepted: false,
    retryable: false,
    code: "OBSERVATION_BINDING_EXHAUSTED",
    error: "ENTITY_NOT_CONFIRMED",
  });
  expect(memory.bindingResult("type", "changed-page", failure)).toMatchObject({
    retryable: true,
    attempts: 1,
  });
  expect(
    memory.bindingResult("type", "changed-page", { bindings: [binding] }),
  ).toMatchObject({ accepted: true });
  expect(memory.bindingResult("type", "changed-page", failure)).toMatchObject({
    attempts: 1,
  });
  expect(
    memory.bindingResult("type", "changed-page", {
      bindings: [
        { ...binding, readiness: "PARTIAL", reasons: ["OBSERVATION_DRIFTED"] },
      ],
    }),
  ).toMatchObject({ accepted: false, error: "OBSERVATION_DRIFTED" });
});

it("retains missing-region guidance without treating diagnostics as accepted evidence", () => {
  const { memory, binding } = fixture();
  const observationId = randomUUID();
  memory.ingest({
    coverage: [
      {
        criterionId: "check",
        targetId: "type",
        observationId,
        error: "SCOPE_NOT_OBSERVED",
      },
      {
        criterionId: "foreign",
        targetId: "type",
        observationId,
        error: "SCOPE_AMBIGUOUS",
      },
    ],
  });
  expect(memory.view().coverage[0]).toMatchObject({
    readiness: "MISSING",
    lastObservation: { observationId, error: "SCOPE_NOT_OBSERVED" },
  });
  expect(memory.view().coverage[0]!.nextAction).toContain("先进入该区域");
  expect(memory.ids()).toEqual([]);
  memory.ingest({ bindings: [binding] });
  expect(memory.view().coverage[0]).not.toHaveProperty("lastObservation");
});

it("rejects foreign attempts and never turns a counterexample into a pass", () => {
  const { binding, memory } = fixture();
  memory.ingest({ bindings: [{ ...binding, attemptId: randomUUID() }] });
  expect(memory.ids()).toEqual([]);
  const negative = {
    ...binding,
    evaluation: "MISMATCHED",
    facts: [{ ...binding.facts[0], actual: false, evaluation: "MISMATCHED" }],
  };
  memory.ingest({ bindings: [negative] });
  memory.deliveredRequest(
    [{ content: JSON.stringify(memory.view()) }],
    undefined,
  );
  expect(
    memory.resolve("check", "PASSED", [binding.id], []).error,
  ).toBeTruthy();
  expect(
    memory.resolve("check", "FAILED", [binding.id], []).error,
  ).toBeUndefined();
});

it("keeps bounded coverage and preserves the counterexample when later observations match", () => {
  const { binding, memory } = fixture();
  const negative = {
    ...binding,
    evaluation: "MISMATCHED",
    facts: [{ ...binding.facts[0], actual: false, evaluation: "MISMATCHED" }],
  };
  memory.ingest({
    bindings: [
      negative,
      ...Array.from({ length: 80 }, () => ({ ...binding, id: randomUUID() })),
    ],
  });
  expect(memory.ids()).toContain(binding.id);
  expect(Buffer.byteLength(JSON.stringify(memory.view()))).toBeLessThanOrEqual(
    12 * 1024,
  );
});

it("auto-selects only delivered business evidence and still rejects incomplete coverage", () => {
  const { binding } = fixture();
  const contract = observationContractSchema.parse({
    version: 3,
    targets: ["Mapping", "Legacy"].map((label, i) => ({
      targetId: `type-${i}`,
      label,
      identity: { text: label },
      phase: "CURRENT",
      assertions: [
        { assertionId: "enabled", label: "Enabled", expected: true },
      ],
      requiredEvidenceKinds: ["DOM"],
    })),
  });
  const memory = new BoundEvidence(
    [{ id: "check", observationContract: contract }],
    binding.runId,
    binding.attemptId,
  );
  const first = {
    ...binding,
    contractDigest: observationDigest(contract),
    targetId: "type-0",
    phase: "CURRENT" as const,
  };
  const second = {
    ...first,
    id: randomUUID(),
    targetId: "type-1",
    entityKey: "Legacy",
    scopeIdentity: "other-row",
  };
  memory.ingest({ bindings: [first, second] });
  expect(memory.submissionRefs("check").bindingIds).toEqual([]);
  memory.deliveredRequest(
    [{ content: JSON.stringify({ bindings: [first] }) }],
    undefined,
  );
  const partial = memory.submissionRefs("check");
  expect(partial.bindingIds).toEqual([first.id]);
  expect(
    memory.resolve("check", "PASSED", partial.bindingIds!, []).error,
  ).toContain("TARGET_NOT_CONFIRMED");
  memory.deliveredRequest(
    [{ content: JSON.stringify(memory.view()) }],
    undefined,
  );
  const complete = memory.submissionRefs("check");
  expect(complete.bindingIds).toEqual([first.id, second.id]);
  expect(
    memory.resolve("check", "PASSED", complete.bindingIds!, []).error,
  ).toBeUndefined();
  const cache = new BrowserObservations(undefined, true, memory);
  const result = resolveCriterionEvidence(
    criterionSubmissionSchema.parse({
      criterionId: "check",
      status: "PASSED",
      summary: "两个对象的状态均已验证。",
    }),
    {
      id: "check",
      description: "两个对象均启用",
      required: true,
      requiredEvidenceKinds: ["DOM"],
      observationContract: contract,
    },
    cache,
    new Map(
      binding.evidenceRefs.map((externalId) => [
        externalId,
        { externalId, kind: "DOM" as const, label: "状态", metadata: {} },
      ]),
    ),
  );
  expect(result.error).toBeUndefined();
  if (result.error) throw new Error(result.error.error);
  expect(result.result.bindingIds).toEqual([first.id, second.id]);
});

it("stops recapturing malformed state contracts after the first type diagnostic", () => {
  const { memory, binding } = fixture();
  binding.readiness = "PARTIAL";
  binding.evaluation = "UNKNOWN";
  binding.facts = [];
  binding.reasons = ["STATE_TYPE_MISMATCH:enabled"];
  expect(
    memory.bindingResult(binding.targetId, "page", {
      bindings: [binding],
      coverage: [],
    }),
  ).toMatchObject({
    code: "OBSERVATION_BINDING_EXHAUSTED",
    error: "STATE_TYPE_MISMATCH",
    attempts: 1,
    retryable: false,
  });
});

it("explains how to establish a missing reopen phase without endless screenshots", () => {
  const { memory, binding, contract } = fixture();
  contract.targets[0]!.phase = "REOPENED";
  binding.phase = "REOPENED";
  binding.phaseProven = false;
  binding.readiness = "PARTIAL";
  binding.reasons = ["PHASE_UNPROVEN"];
  const result = memory.bindingResult(binding.targetId, "same-page", {
    bindings: [binding],
  });
  expect(result).toMatchObject({ retryable: true });
  if (!("nextAction" in result)) throw new Error("Expected phase guidance");
  expect(result.nextAction).toContain("完整观察页面确认弹窗已关闭");
  expect(result.nextAction).toContain("同一业务记录");
  memory.bindingResult(binding.targetId, "same-page", { bindings: [binding] });
  expect(
    memory.bindingResult(binding.targetId, "same-page", {
      bindings: [binding],
    }),
  ).toMatchObject({ retryable: false });
});
