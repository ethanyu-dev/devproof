import { describe, expect, it } from "vitest";
import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";
import type { RuntimeEvidenceRef } from "@devproof/agent-runtime-protocol";
import { BrowserObservations } from "./browser-observation.js";
import {
  criterionSubmissionSchema,
  resolveCriterionEvidence,
} from "./criterion-evidence.js";

const content =
  '- <label> "白名单类型" [ref=f262e130]\n- <div title="合规模型映射"> "合规模型映射" [ref=f262e201] [box=615,152,192,32]';
const criterion = {
  id: "case-2-criterion-1",
  description: "类型下拉中可以找到合规模型映射。",
  required: true,
  requireObservedEvidence: true,
  requiredEvidenceKinds: ["DOM", "SCREENSHOT"] as const,
  observationTargets: [
    {
      label: "MODEL_NAME_MAPPING_WHITELIST 业务类型",
      expectedText: "合规模型映射",
    },
  ],
};
const input = {
  criterionId: criterion.id,
  status: "PASSED",
  summary: "类型下拉中已找到合规模型映射。",
  citations: [
    { target: criterion.observationTargets[0]!.label, ref: "f262e201" },
  ],
};

function fixture(kinds = ["DOM", "SCREENSHOT"], observedContent = content) {
  const observations = new BrowserObservations(undefined, true);
  const raw = {
    status: "SUCCEEDED",
    result: { content: observedContent, url: "https://example.com" },
    artifacts: kinds.map((kind, id) => ({ id: `evidence-${id}`, kind })),
  };
  observations.capture(
    runtimeActionCommandInputSchema.parse({
      commandType: "page.snapshot",
      payload: {},
    }),
    raw,
  );
  const evidence = new Map<string, RuntimeEvidenceRef>(
    raw.artifacts.map((a) => [
      `artifact://${a.id}`,
      {
        externalId: `artifact://${a.id}`,
        kind: a.kind as RuntimeEvidenceRef["kind"],
        label: "",
        metadata: {},
      },
    ]),
  );
  const resolve = (value: unknown = input) =>
    resolveCriterionEvidence(
      criterionSubmissionSchema.parse(value),
      {
        ...criterion,
        requiredEvidenceKinds: [...criterion.requiredEvidenceKinds],
      },
      observations,
      evidence,
    );
  return { observations, resolve, raw, evidence };
}

describe("criterion citations", () => {
  it("normalizes display comparison while retaining the exact citation and rejecting rewritten quotations", () => {
    const actual = '- <button aria-pressed="true"> "周 一" [ref=f262e201]';
    const { observations, evidence } = fixture(undefined, actual);
    observations.deliverCurrentPage(observations.currentPage(true));
    const target = {
      label: input.citations[0]!.target,
      expectedText: "周一",
      matchMode: "DISPLAY_TEXT" as const,
    };
    const c = {
      ...criterion,
      requiredEvidenceKinds: [...criterion.requiredEvidenceKinds],
      observationTargets: [target],
    };
    const result = resolveCriterionEvidence(
      criterionSubmissionSchema.parse(input),
      c,
      observations,
      evidence,
    );
    expect(result.error).toBeUndefined();
    if (result.error) throw new Error(result.error.error);
    expect(result.result?.observations?.[0]?.quote).toBe(actual);
    const rewritten = resolveCriterionEvidence(
      criterionSubmissionSchema.parse({
        ...input,
        citations: [],
        observations: [
          {
            ...result.result!.observations![0],
            quote: actual.replace("周 一", "周一"),
          },
        ],
      }),
      c,
      observations,
      evidence,
    );
    expect(rewritten.error?.code).toBe("QUOTE_NOT_EXACT");
  });
  it("binds a delivered node to its exact quote and matching DOM and screenshot", () => {
    const { observations, resolve } = fixture();
    observations.deliverCurrentPage(observations.currentPage(true));
    const resolved = resolve();
    expect(resolved.error).toBeUndefined();
    if (resolved.error) throw new Error(resolved.error.error);
    expect(resolved.result).not.toHaveProperty("citations");
    expect(resolved.result.evidenceRefs).toEqual([
      "artifact://evidence-0",
      "artifact://evidence-1",
    ]);
    expect(resolved.result.observations?.[0]).toMatchObject({
      cursor: 0,
      quote: content.split("\n")[1],
    });
  });

  it("rejects unread, invented and stale refs without attaching unrelated artifacts", () => {
    const { observations, resolve } = fixture();
    expect(resolve().error?.code).toBe("CITATION_NOT_AVAILABLE");
    observations.deliverCurrentPage(observations.currentPage(true));
    expect(
      resolve({
        ...input,
        citations: [{ ...input.citations[0], ref: "f262e999" }],
      }).error?.code,
    ).toBe("CITATION_NOT_AVAILABLE");
    observations.capture(
      runtimeActionCommandInputSchema.parse({
        commandType: "page.click",
        payload: { target: { ref: "f262e201" } },
      }),
      { status: "SUCCEEDED", result: {} },
    );
    expect(resolve().error?.code).toBe("CITATION_NOT_AVAILABLE");
  });

  it("binds refreshed refs only to artifacts from the new observation", () => {
    const { observations, raw } = fixture();
    observations.deliverCurrentPage(observations.currentPage(true));
    observations.capture(
      runtimeActionCommandInputSchema.parse({
        commandType: "page.snapshot",
        payload: {},
      }),
      {
        ...raw,
        result: { content: content.replaceAll("f262e", "f263e") },
        artifacts: [
          { id: "new-dom", kind: "DOM" },
          { id: "new-screen", kind: "SCREENSHOT" },
          { id: "unrelated", kind: "NETWORK" },
        ],
      },
    );
    observations.deliverCurrentPage(observations.currentPage(true));
    expect(observations.citation("f262e201")).toBeUndefined();
    expect(observations.citation("f263e201")?.evidenceRefs).toEqual([
      "artifact://new-dom",
      "artifact://new-screen",
    ]);
  });

  it("reports the original synthesized-quote failure and missing DOM together", () => {
    const { observations, resolve } = fixture(["SCREENSHOT"]);
    observations.deliverCurrentPage(observations.currentPage(true));
    const snapshot = observations.currentPage(true).snapshot!;
    const rejected = resolve({
      ...input,
      citations: [],
      evidenceRefs: ["artifact://evidence-0"],
      observations: [
        {
          target: input.citations[0]!.target,
          observationId: snapshot.observationId,
          cursor: 0,
          quote:
            '<label> "白名单类型"；<div title="合规模型映射"> "合规模型映射"',
        },
      ],
    });
    expect(rejected.error).toMatchObject({
      code: "QUOTE_NOT_EXACT",
      criterionId: criterion.id,
    });
    expect(
      rejected.error?.issues.map((issue) => issue.expected).join("\n"),
    ).toContain("MISSING_EVIDENCE_KIND");
  });

  it("returns a correction instead of throwing when merged evidence exceeds protocol limits", () => {
    const { observations, resolve } = fixture();
    observations.deliverCurrentPage(observations.currentPage(true));
    const snapshot = observations.currentPage(true).snapshot!;
    const rejected = resolve({
      ...input,
      observations: Array.from({ length: 20 }, () => ({
        target: input.citations[0]!.target,
        observationId: snapshot.observationId,
        cursor: 0,
        quote: content.split("\n")[1],
      })),
    });
    expect(rejected.error).toMatchObject({
      code: "INVALID_ARGUMENTS",
      criterionId: criterion.id,
      issues: [expect.objectContaining({ path: "observations" })],
    });
  });

  it("does not accept a different business object or a misspelled artifact ID", () => {
    const { observations, resolve } = fixture();
    observations.deliverCurrentPage(observations.currentPage(true));
    expect(
      resolve({
        ...input,
        citations: [{ ...input.citations[0], ref: "f262e130" }],
      }).error?.code,
    ).toBe("OBSERVED_VALUE_MISMATCH");
    expect(
      resolve({ ...input, evidenceRefs: ["artifact://misspelled"] }).error
        ?.code,
    ).toBe("UNKNOWN_EVIDENCE_REF");
  });

  it("keeps partial reads scoped and excludes unseen tail nodes", () => {
    const { observations, resolve, raw } = fixture();
    observations.capture(
      runtimeActionCommandInputSchema.parse({
        commandType: "page.snapshot",
        payload: {},
      }),
      {
        ...raw,
        result: {
          content: '- <span> "其他内容" [ref=f262e2]\n'.repeat(700) + content,
        },
      },
    );
    observations.deliverCurrentPage(observations.currentPage());
    expect(resolve().error?.code).toBe("CITATION_NOT_AVAILABLE");
  });
});
