import { describe, expect, it } from "vitest";
import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";
import { BrowserObservations } from "./browser-observation.js";
import {
  criterionSubmissionSchema,
  resolveCriterionEvidence,
} from "./criterion-evidence.js";
const criterion = {
  id: "switches",
  description: "两种类型默认开启",
  required: true,
  requiredEvidenceKinds: ["DOM", "SCREENSHOT"] as ("DOM" | "SCREENSHOT")[],
  requireObservedEvidence: true,
  observationTargets: [
    { label: "模型映射", expectedText: "合规模型映射" },
    { label: "旧版转账", expectedText: "旧版对公转账白名单" },
  ],
};
function capture(cache: BrowserObservations, type: string, prefix: string) {
  const raw = {
    status: "SUCCEEDED",
    result: {
      content: `- <span title="${type}"> "${type}" [ref=${prefix}e1]\n- <label> "启用状态" [ref=${prefix}e2]\n- <button role="switch" aria-checked="true"> "启用" [ref=${prefix}e3]`,
      url: "https://test.example.com/list",
    },
    artifacts: [
      { id: `${prefix}-dom`, kind: "DOM" },
      { id: `${prefix}-screen`, kind: "SCREENSHOT" },
    ],
  };
  cache.capture(
    runtimeActionCommandInputSchema.parse({
      commandType: "page.snapshot",
      payload: {},
    }),
    raw,
  );
  cache.deliverCurrentPage(cache.currentPage(true));
  cache.rememberCriterionFacts([criterion]);
}
describe("criterion observation memory", () => {
  it("retains both selected types and switch context across navigation and restart without making old refs actionable", () => {
    const cache = new BrowserObservations(undefined, true);
    capture(cache, "旧版对公转账白名单", "f1");
    capture(cache, "合规模型映射", "f2");
    const facts = cache.retainedCriterionFacts();
    expect(facts).toHaveLength(2);
    expect(
      facts.every((f) =>
        f.contextQuotes.some((q) => q.includes('aria-checked="true"')),
      ),
    ).toBe(true);
    const resumed = new BrowserObservations(undefined, true);
    resumed.restoreCriterionFacts(facts);
    expect(resumed.citation("f1e1")).toBeUndefined();
    const evidence = new Map(
      facts.flatMap((f) =>
        f.evidenceRefs.map(
          (externalId) =>
            [
              externalId,
              {
                externalId,
                kind: externalId.endsWith("-dom")
                  ? ("DOM" as const)
                  : ("SCREENSHOT" as const),
                label: "",
                metadata: {},
              },
            ] as const,
        ),
      ),
    );
    const result = resolveCriterionEvidence(
      criterionSubmissionSchema.parse({
        criterionId: criterion.id,
        status: "PASSED",
        summary: "已分别观察两种类型默认开启。",
        savedObservationIds: facts.map((f) => f.id),
      }),
      criterion,
      resumed,
      evidence,
    );
    expect(result.error).toBeUndefined();
    expect(
      ("result" in result ? result.result : undefined)?.observations,
    ).toHaveLength(2);
    expect(
      resumed.savedCitation(facts[0]!.id, "another-criterion"),
    ).toBeUndefined();
  });
  it("does not pin undelivered candidate pages or fabricated quotes", () => {
    const cache = new BrowserObservations(undefined, true);
    cache.capture(
      runtimeActionCommandInputSchema.parse({
        commandType: "page.snapshot",
        payload: {},
      }),
      {
        status: "SUCCEEDED",
        result: { content: '- <span> "合规模型映射" [ref=f1e1]' },
        artifacts: [{ id: "proof", kind: "DOM" }],
      },
    );
    expect(cache.rememberCriterionFacts([criterion])).toBe(false);
    expect(cache.retainedCriterionFacts()).toEqual([]);
  });
  it("deduplicates equivalent observations with fresh refs", () => {
    const cache = new BrowserObservations(undefined, true);
    capture(cache, "合规模型映射", "f1");
    capture(cache, "合规模型映射", "f2");
    expect(cache.retainedCriterionFacts()).toHaveLength(1);
  });
});
