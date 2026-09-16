import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  observationContractSchema,
  type ObservationBinding,
} from "@devproof/agent-runtime-protocol";
import { observationDigest } from "@devproof/agent-runtime-protocol/observation-digest";
import { BoundEvidence } from "./bound-evidence.js";

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
    binding,
    memory: new BoundEvidence(
      [{ id: "check", observationContract: contract }],
      runId,
      attemptId,
    ),
  };
}

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
