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
  new Map([[sourceRef, { kind: "LINEAR_ISSUE" }]]),
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
        new Map([[sourceRef, { kind: "LINEAR_ISSUE" }]]),
      ),
    ).toThrow("实际读取来源");
  });
  it("does not silently discard mappings without a requirement list", () => {
    const spec = normalizeCompactSpec(draft, requirements.slice(0, 1));
    delete spec.requirements;
    expect(specRequirementCoverageError(spec)).toContain("需求清单");
  });
  it("preserves exclusions and all objects of a grouped business check without adding checks", () => {
    const spec = normalizeCompactSpec(
      {
        ...draft,
        outOfScope: ["权限与分页未涉及本次改动，不追加通用回归。"],
        cases: [
          {
            ...draft.cases[0],
            criteria: [
              {
                ...draft.cases[0]!.criteria[0],
                observationTargets: [
                  { label: "类型甲", expectedText: "甲" },
                  { label: "类型乙", expectedText: "乙" },
                ],
              },
            ],
          },
        ],
      },
      requirements.slice(0, 1),
    );
    expect(spec.scopePolicy).toBe("CHANGE_FOCUSED");
    expect(spec.scope.outOfScope).toEqual([
      "权限与分页未涉及本次改动，不追加通用回归。",
    ]);
    expect(spec.cases).toHaveLength(1);
    expect(spec.cases[0]!.criteria).toHaveLength(1);
    expect(spec.cases[0]!.criteria[0]!.observationTargets).toHaveLength(2);
    expect(specRequirementCoverageError(spec)).toBeNull();
  });
});

it("rejects login roles instead of producing a needless account HITL", () => {
  expect(() =>
    normalizeCompactSpec(
      {
        ...draft,
        cases: [
          {
            ...draft.cases[0],
            accountRequirements: [
              {
                role: "admin",
                label: "后台管理员账号（登录用）",
                usage: "READ_EXISTING",
                rationale: "登录后台",
              },
            ],
          },
        ],
      },
      requirements,
    ),
  ).toThrow("authRole");
  const result = normalizeCompactSpec(
    {
      ...draft,
      cases: [
        {
          ...draft.cases[0],
          authRole: "白名单管理员",
          accountRequirements: [],
        },
      ],
    },
    requirements,
  );
  expect(result.cases[0]).toMatchObject({
    authRole: "白名单管理员",
    accountRequirements: [],
  });
});
it("asks for concise generation without truncating saved evidence or removing necessary steps", () => {
  expect(
    compactSpecSchema.safeParse({ ...draft, summary: "冗长".repeat(151) })
      .success,
  ).toBe(false);
  const steps = Array.from({ length: 11 }, (_, i) => `必要业务操作 ${i + 1}`);
  const result = normalizeCompactSpec(
    { ...draft, cases: [{ ...draft.cases[0], steps }] },
    requirements,
  );
  expect(result.cases[0]!.steps.map((step) => step.action)).toEqual(steps);
  expect(result.cases[0]!.criteria[0]!.basis!.quote).toBe(
    plan.requirements[0]!.quote,
  );
});
