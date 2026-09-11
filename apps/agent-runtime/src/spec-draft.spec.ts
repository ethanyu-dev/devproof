import { describe, expect, it } from "vitest";
import { specRequirementCoverageError } from "@devproof/agent-runtime-protocol";
import {
  compactSpecSchema,
  defineSpecRequirements,
  normalizeCompactSpec,
} from "./spec-draft.js";

const sourceRef = "analysis-source://attempt/issue";
const sourceText = "新增 LEGACY_CORPORATE 旧版对公转账白名单，样式参考 ZDR。";
const plan = {
  requirements: [
    {
      description: "支持旧版对公转账白名单",
      sourceRef,
      quote: "LEGACY_CORPORATE 旧版对公转账白名单",
    },
    { description: "样式参考 ZDR", sourceRef, quote: "样式参考 ZDR" },
  ],
};
const requirements = defineSpecRequirements(
  plan,
  new Map([[sourceRef, sourceText]]),
);
const draft = {
  summary: "验证白名单配置",
  cases: [
    {
      name: "检查白名单类型",
      steps: ["打开白名单配置并检查新增类型。"],
      criteria: [
        {
          requirementId: "requirement-1",
          description: "可以选择旧版对公转账白名单。",
          observationTargets: [
            {
              label: "对公转账类型",
              expectedText: "旧版对公转账白名单",
              alternatives: ["LEGACY_CORPORATE"],
            },
          ],
        },
      ],
    },
  ],
};

describe("compact Spec", () => {
  it("fills execution fields while preserving the separately defined scope", () => {
    expect(
      compactSpecSchema.shape.cases.element.safeParse(draft.cases[0]).success,
    ).toBe(true);
    const spec = normalizeCompactSpec(draft, requirements);
    expect(spec.scope.inScope).toEqual(
      plan.requirements.map((item) => item.description),
    );
    expect(spec.cases[0]).toMatchObject({
      authRole: "default",
      priority: "MEDIUM",
      testData: [],
      cleanup: [],
      sourceRefs: [sourceRef],
      steps: [{ order: 1 }],
      criteria: [
        {
          required: true,
          requiredEvidenceKinds: ["DOM"],
          requirementId: "requirement-1",
          basis: { sourceRef, quote: plan.requirements[0]!.quote },
        },
      ],
    });
    expect(specRequirementCoverageError(spec)).toContain(
      "遗漏需求：requirement-2",
    );
  });
  it("requires an explicit explanation for an uncovered requirement", () => {
    const spec = normalizeCompactSpec(
      {
        ...draft,
        uncoveredRequirements: [
          {
            requirementId: "requirement-2",
            reason: "需求未明确样式比较范围，等待确认。",
          },
        ],
      },
      requirements,
    );
    expect(specRequirementCoverageError(spec)).toBeNull();
    spec.uncoveredRequirements!.push({
      requirementId: "requirement-1",
      reason: "待确认。",
    });
    expect(specRequirementCoverageError(spec)).toContain("矛盾");
  });
  it("does not accept an unknown ID, changed provenance or non-required coverage", () => {
    const spec = normalizeCompactSpec(draft, requirements.slice(0, 1));
    spec.cases[0]!.criteria[0]!.requirementId = "invented";
    expect(specRequirementCoverageError(spec)).toContain("已确定的需求");
    spec.cases[0]!.criteria[0]!.requirementId = "requirement-1";
    spec.cases[0]!.criteria[0]!.basis!.quote = "自拟行为";
    expect(specRequirementCoverageError(spec)).toContain("不一致");
    spec.cases[0]!.criteria[0]!.required = false;
    expect(specRequirementCoverageError(spec)).toContain("参与最终判定");
  });
  it("checks each requirement against its own source, not a neighboring file", () => {
    expect(() =>
      defineSpecRequirements(
        plan,
        new Map([
          [sourceRef, "其他内容"],
          ["another-file", sourceText],
        ]),
      ),
    ).toThrow("实际读取来源");
  });
  it("does not silently discard mappings without a requirement list", () => {
    const spec = normalizeCompactSpec(draft, requirements.slice(0, 1));
    delete spec.requirements;
    expect(specRequirementCoverageError(spec)).toContain("需求清单");
  });
});
