import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ObjectEvidence } from "./object-evidence";
import { observationContractSchema } from "@devproof/agent-runtime-protocol";

it.each([2, 3] as const)(
  "renders both bound images and isolates comparison reviews by attempt (v%s)",
  (version) => {
    const attemptId = randomUUID(),
      runId = randomUUID();
    const oldContract = observationContractSchema.parse({
      version: 2,
      targets: ["新类型", "参照类型"].map((name, i) => ({
        targetId: `type-${i}`,
        label: name,
        scope: { kind: "DIALOG", names: ["新增"] },
        entity: {
          controlKind: "SELECT",
          label: "类型",
          property: "SELECTED_LABEL",
          oneOf: [name],
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
      })),
      comparisons: [
        {
          comparisonId: "style",
          subjectTargetId: "type-0",
          referenceTargetId: "type-1",
          dimensions: ["开关形式"],
          sourceRef: "fixture",
          quote: "形式相同",
        },
      ],
    });
    if (oldContract.version !== 2) throw new Error("Fixture error");
    const contract =
      version === 2
        ? oldContract
        : observationContractSchema.parse({
            version: 3,
            comparisons: oldContract.comparisons,
            targets: oldContract.targets.map((t, i) => ({
              targetId: t.targetId,
              label: t.label,
              identity: { text: t.label },
              phase: t.phase,
              requiredEvidenceKinds: t.requiredEvidenceKinds,
              assertions: [
                {
                  assertionId: "enabled",
                  label: "启用状态",
                  ...(i === 0 ? { expected: true } : {}),
                },
              ],
            })),
          });
    const rows = contract.targets.map((t) => ({
      id: randomUUID(),
      facts: {
        runId,
        attemptId,
        criterionId: "default",
        targetId: t.targetId,
        contractDigest: "a".repeat(64),
        observationId: randomUUID(),
        captureId: randomUUID(),
        sourceCommandId: randomUUID(),
        scopeIdentity: "dialog",
        entityKey: t.label,
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
        evidenceRefs: [`artifact://${t.targetId}`],
        capturedAt: new Date().toISOString(),
        reasons: [],
      },
    }));
    const event = {
      id: randomUUID(),
      attemptId,
      payload: {
        comparisonId: "style",
        bindingIds: rows.map((r) => r.id),
        deliveryId: randomUUID(),
        verdict: "EQUIVALENT",
        rationale: "两侧均为同一形式的开关。",
        dimensions: ["开关形式"],
        criterionId: "default",
        contractDigest: "a".repeat(64),
      },
    };
    const props = {
      criterionId: "default",
      criteria: [
        {
          id: "default",
          description: "默认启用且形式与参照一致",
          observationContract: contract,
        },
      ],
      rows,
      attemptId,
      evidence: rows.map((r) => ({
        externalId: r.facts.evidenceRefs[0]!,
        kind: "SCREENSHOT",
        downloadUrl: `/${r.facts.targetId}.jpg`,
      })),
      events: [event],
    };
    const html = renderToStaticMarkup(createElement(ObjectEvidence, props));
    expect(html).toContain("比较结果一致");
    expect(html).toContain("启用状态");
    if (version === 3) expect(html).toContain("参照已记录");
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('src="/type-0.jpg"');
    expect(html).toContain('src="/type-1.jpg"');
    const otherAttempt = renderToStaticMarkup(
      createElement(ObjectEvidence, {
        ...props,
        attemptId: randomUUID(),
        historyTruncated: true,
      }),
    );
    expect(otherAttempt).toContain("尚未比较");
    expect(otherAttempt).not.toContain("<img ");
    expect(otherAttempt).toContain("覆盖情况可能不完整");
  },
);
