import { describe, expect, it } from "vitest";
import {
  runtimeCriterionSchema,
  specRequirementCoverageError,
  type RuntimeEvidenceRef,
} from "@devproof/agent-runtime-protocol";
import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";
import { BrowserObservations } from "./browser-observation.js";
import {
  criterionSubmissionSchema,
  resolveCriterionEvidence,
} from "./criterion-evidence.js";
import { SpecCheckCatalog } from "./spec-check-catalog.js";
import { defineSpecRequirements } from "./spec-draft.js";
import { specCriterionIssues } from "./spec-criterion-validation.js";

const issue = "analysis-source://attempt/issue";
const ui = "analysis-source://attempt/i18n";
const sources = new Map([
  [issue, "新增旧版对公转账白名单，样式参考 ZDR。"],
  [ui, '"LEGACY_CORPORATE": "旧版对公转账白名单", "ZDR": "零数据留存 (ZDR)"'],
]);
const requirements = defineSpecRequirements(
  {
    requirements: [
      {
        description: "支持旧版对公转账白名单",
        sourceRef: issue,
        quote: "新增旧版对公转账白名单",
      },
      {
        description: "配置样式参考 ZDR",
        sourceRef: issue,
        quote: "样式参考 ZDR",
      },
    ],
  },
  sources,
  new Map([
    [issue, { kind: "LINEAR_ISSUE" }],
    [ui, { kind: "GITHUB_FILE" }],
  ]),
);
const option = {
  requirementId: "requirement-1",
  description: "类型下拉包含旧版对公转账白名单。",
  observationTargets: [
    { label: "对公转账类型", expectedText: "旧版对公转账白名单" },
  ],
};
const style = {
  requirementId: "requirement-2",
  description: "旧版对公转账配置区域与 ZDR 的结构和交互一致。",
  observationTargets: [
    { label: "对公转账配置区域", expectedText: "旧版对公转账白名单" },
    { label: "ZDR 配置区域", expectedText: "零数据留存 (ZDR)" },
  ],
  requiredEvidenceKinds: ["DOM", "SCREENSHOT"],
};
const draft = (checkIds = ["check-1", "check-2"]) => ({
  summary: "验证新增类型与 ZDR 配置样式",
  cases: [
    {
      name: "检查配置区域",
      steps: ["独立打开两种类型的配置区域并对照结构和交互。"],
      checkIds,
    },
  ],
});

describe("SpecCheckCatalog", () => {
  it("requires delivered evidence for both expanded comparison targets in browser execution", () => {
    const catalog = new SpecCheckCatalog();
    catalog.define(
      {
        expectedRevision: 0,
        checks: [{ ...style, supportingSourceRefs: [ui] }],
      },
      requirements,
      sources,
    );
    const expanded = catalog.expand(draft(["check-1"]), requirements).cases[0]!
      .criteria[0]!;
    const criterion = runtimeCriterionSchema.parse({
      ...expanded,
      requireObservedEvidence: true,
      basis: {
        quote: expanded.basis!.quote,
        observationTarget: expanded.basis!.observationTarget,
        sourceRefs: expanded.sourceRefs,
      },
    });
    const observations = new BrowserObservations(undefined, true);
    const artifacts = [
      { id: "comparison-dom", kind: "DOM" },
      { id: "comparison-image", kind: "SCREENSHOT" },
    ];
    observations.capture(
      runtimeActionCommandInputSchema.parse({
        commandType: "page.snapshot",
        payload: {},
      }),
      {
        status: "SUCCEEDED",
        result: {
          url: "https://example.com/whitelist-config",
          content:
            '- <div> "旧版对公转账白名单" [ref=f262e201]\n- <div> "零数据留存 (ZDR)" [ref=f262e202]',
        },
        artifacts,
      },
    );
    observations.deliverCurrentPage(observations.currentPage(true));
    const evidence = new Map<string, RuntimeEvidenceRef>(
      artifacts.map((item) => [
        `artifact://${item.id}`,
        {
          externalId: `artifact://${item.id}`,
          kind: item.kind as RuntimeEvidenceRef["kind"],
          label: "配置区域证据",
          metadata: {},
        },
      ]),
    );
    const citations = [
      { target: "对公转账配置区域", ref: "f262e201" },
      { target: "ZDR 配置区域", ref: "f262e202" },
    ];
    const submit = (refs: typeof citations) =>
      resolveCriterionEvidence(
        criterionSubmissionSchema.parse({
          criterionId: criterion.id,
          status: "PASSED",
          summary: "已观察双方配置区域。",
          citations: refs,
        }),
        criterion,
        observations,
        evidence,
      );
    expect(submit(citations.slice(0, 1)).error?.code).toBe("QUOTE_NOT_EXACT");
    expect(submit(citations).error).toBeUndefined();
    const missingScreenshot = new Map(evidence);
    missingScreenshot.delete("artifact://comparison-image");
    expect(
      resolveCriterionEvidence(
        criterionSubmissionSchema.parse({
          criterionId: criterion.id,
          status: "PASSED",
          summary: "缺少截图证据。",
          citations,
        }),
        criterion,
        observations,
        missingScreenshot,
      ).error,
    ).toBeDefined();
  });

  it("keeps valid items and pinpoints the extra UI source needed by an Issue-based assertion", () => {
    const catalog = new SpecCheckCatalog();
    const result = catalog.define(
      { expectedRevision: 0, checks: [option, style] },
      requirements,
      sources,
    );
    expect(result).toMatchObject({
      accepted: false,
      revision: 1,
      saved: [{ inputIndex: 0, checkId: "check-1" }],
      issues: [
        {
          inputIndex: 1,
          requirementId: "requirement-2",
          code: "TARGET_TEXT_UNSUPPORTED",
          path: "observationTargets[1].expectedText",
          value: "零数据留存 (ZDR)",
          boundSourceRefs: [issue],
          candidateSourceRefs: [ui],
        },
      ],
    });
    expect(catalog.ids).toEqual(["check-1"]);
    expect(() => catalog.expand(draft(), requirements)).toThrow(
      "未知或未通过校验的 checkId",
    );

    const repaired = catalog.define(
      {
        expectedRevision: 1,
        checks: [{ ...style, supportingSourceRefs: [ui] }],
      },
      requirements,
      sources,
    );
    expect(repaired).toMatchObject({
      accepted: true,
      revision: 2,
      saved: [{ checkId: "check-2" }],
    });
    const spec = catalog.expand(draft(), requirements);
    expect(specRequirementCoverageError(spec)).toBeNull();
    expect(spec.cases[0]!.criteria[1]).toMatchObject({
      id: "case-1-check-2",
      required: true,
      requirementId: "requirement-2",
      basis: { sourceRef: issue, quote: "样式参考 ZDR" },
      sourceRefs: [issue, ui],
      observationTargets: style.observationTargets,
      requiredEvidenceKinds: ["DOM", "SCREENSHOT"],
    });
    expect(spec.cases[0]!.sourceRefs).toEqual([issue, ui]);
    expect(spec.cases[0]).not.toHaveProperty("checkIds");
    expect(spec.cases[0]!.criteria[1]).not.toHaveProperty(
      "supportingSourceRefs",
    );
    for (const criterion of spec.cases[0]!.criteria)
      expect(specCriterionIssues(criterion, sources)).toEqual([]);
  });

  it("updates one check with optimistic concurrency and preserves unrelated checks and immutable requirement mapping", () => {
    const catalog = new SpecCheckCatalog();
    catalog.define(
      {
        expectedRevision: 0,
        checks: [option, { ...style, supportingSourceRefs: [ui] }],
      },
      requirements,
      sources,
    );
    const before = catalog.expand(draft(), requirements);
    const update = {
      ...style,
      supportingSourceRefs: [ui],
      checkId: "check-2",
      description: "两个配置区域的开关结构与交互一致。",
    };
    expect(
      catalog.define(
        { expectedRevision: 1, checks: [update] },
        requirements,
        sources,
      ),
    ).toMatchObject({ accepted: true, revision: 2 });
    const after = catalog.expand(draft(), requirements);
    expect(after.cases[0]!.criteria[0]).toEqual(before.cases[0]!.criteria[0]);
    expect(after.cases[0]!.criteria[1]!.id).toBe(
      before.cases[0]!.criteria[1]!.id,
    );
    expect(after.cases[0]!.criteria[1]!.description).toBe(update.description);
    expect(() =>
      catalog.define(
        { expectedRevision: 1, checks: [update] },
        requirements,
        sources,
      ),
    ).toThrow("版本已变化");
    const invalid = catalog.define(
      {
        expectedRevision: 2,
        checks: [{ ...update, requirementId: "requirement-1" }],
      },
      requirements,
      sources,
    );
    expect(invalid.issues[0]!.code).toBe("REQUIREMENT_CHANGED");
    expect(catalog.expand(draft(), requirements)).toEqual(after);
    // Invalid content must also leave the previously saved check intact.
    catalog.define(
      {
        expectedRevision: 2,
        checks: [{ ...update, supportingSourceRefs: [] }],
      },
      requirements,
      sources,
    );
    expect(catalog.expand(draft(), requirements)).toEqual(after);
  });

  it("reports all failing fields, rejects unseen evidence, and saves structurally valid siblings", () => {
    const catalog = new SpecCheckCatalog();
    const result = catalog.define(
      {
        expectedRevision: 0,
        checks: [
          {
            ...option,
            observationTargets: [
              {
                label: "类型",
                expectedText: "臆造文字",
                alternatives: ["另一臆造值"],
              },
            ],
            supportingSourceRefs: ["analysis-source://missing"],
          },
          { description: "缺少必要字段" },
          option,
        ],
      },
      requirements,
      sources,
    );
    expect(result.saved).toEqual([
      { inputIndex: 2, checkId: "check-1", requirementId: "requirement-1" },
    ]);
    expect(result.issues.map((item) => item.code)).toContain("UNKNOWN_SOURCE");
    expect(
      result.issues
        .filter((item) => item.code === "TARGET_TEXT_UNSUPPORTED")
        .map((item) => item.path),
    ).toEqual([
      "observationTargets[0].expectedText",
      "observationTargets[0].alternatives[0]",
    ]);
    expect(
      result.issues.some(
        (item) => item.inputIndex === 1 && item.code === "INVALID_CHECK",
      ),
    ).toBe(true);
  });

  it("reuses identical submissions and expands shared checks to independent execution criteria", () => {
    const catalog = new SpecCheckCatalog();
    catalog.define(
      { expectedRevision: 0, checks: [option] },
      requirements,
      sources,
    );
    expect(
      catalog.define(
        { expectedRevision: 1, checks: [option] },
        requirements,
        sources,
      ),
    ).toMatchObject({ revision: 1, saved: [{ checkId: "check-1" }] });
    const firstCase = draft(["check-1"]).cases[0]!;
    const spec = catalog.expand(
      {
        ...draft(),
        cases: [firstCase, { ...firstCase, name: "独立复核类型" }],
      },
      requirements,
    );
    expect(spec.cases.map((item) => item.criteria[0]!.id)).toEqual([
      "case-1-check-1",
      "case-2-check-1",
    ]);
    spec.cases[0]!.criteria[0]!.observationTargets![0]!.expectedText =
      "修改结果副本";
    expect(
      spec.cases[1]!.criteria[0]!.observationTargets![0]!.expectedText,
    ).toBe("旧版对公转账白名单");
    expect(
      catalog.expand(draft(["check-1"]), requirements).cases[0]!.criteria[0]!
        .observationTargets![0]!.expectedText,
    ).toBe("旧版对公转账白名单");
    expect(specRequirementCoverageError(spec)).toContain(
      "遗漏需求：requirement-2",
    );
  });

  it("rejects repeated references and inline criterion overrides", () => {
    const catalog = new SpecCheckCatalog();
    catalog.define(
      { expectedRevision: 0, checks: [option] },
      requirements,
      sources,
    );
    expect(() =>
      catalog.expand(draft(["check-1", "check-1"]), requirements),
    ).toThrow("重复引用");
    expect(() =>
      catalog.expand(
        {
          ...draft(),
          cases: [{ ...draft(["check-1"]).cases[0], criteria: [style] }],
        },
        requirements,
      ),
    ).toThrow();
  });
});
