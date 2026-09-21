import { describe, expect, it } from "vitest";
import { specRequirementCoverageError } from "@devproof/agent-runtime-protocol";
import {
  compactSpecSchema,
  referencedSpecSchema,
  defineSpecRequirements,
  normalizeCompactSpec,
  specCheckSchema,
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
  it("does not expose network assertions or mandatory network evidence to generation", () => {
    const check = draft.cases[0]!.criteria[0]!;
    expect(
      specCheckSchema.safeParse({
        ...check,
        requiredEvidenceKinds: ["NETWORK"],
      }).success,
    ).toBe(false);
    expect(
      specCheckSchema.safeParse({
        ...check,
        observationTargets: [
          {
            ...check.observationTargets[0],
            network: {
              method: "POST",
              path: "/whitelist",
              part: "REQUEST_BODY",
              field: "type",
              equals: "LEGACY_CORPORATE",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects standalone network requirements while allowing network details in source quotes", () => {
    const quote = "保存后列表显示启用；请求体 config 为 true。";
    const define = (description: string) =>
      defineSpecRequirements(
        { requirements: [{ description, sourceRef, quote }] },
        new Map([[sourceRef, quote]]),
        new Map([[sourceRef, { kind: "TASK_BRIEF" }]]),
      );
    expect(() => define("请求体 config 为 true。")).toThrow("不单列验收需求");
    expect(define("保存后列表显示启用。")[0]?.quote).toBe(quote);
  });
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

it("preserves account provenance and resolves AUTH_SUBJECT criterion ordinals", () => {
  const accountSource = "analysis-source://attempt/accounts";
  const spec = normalizeCompactSpec(
    {
      ...draft,
      cases: [
        {
          ...draft.cases[0],
          accountRequirementsVersion: 2,
          accountRequirements: [
            {
              role: "subject",
              label: "权限验收账号",
              usage: "READ_EXISTING",
              rationale: "验证指定账号的权限",
              subjectBinding: {
                kind: "AUTH_SUBJECT",
                target: "指定用户权限",
                stepOrders: [1],
                criterionIds: ["1"],
                basis: { sourceRef: accountSource, quote: "指定用户权限" },
              },
            },
          ],
        },
      ],
    },
    requirements,
  );
  expect(spec.cases[0]!.accountRequirementsVersion).toBe(2);
  expect(spec.cases[0]!.accountRequirements![0]!.subjectBinding).toMatchObject({
    criterionIds: [spec.cases[0]!.criteria[0]!.id],
    basis: { sourceRef: accountSource },
  });
  expect(spec.cases[0]!.sourceRefs).toContain(accountSource);
});

it("requires an explicit identity matching mode for generated business checks", () => {
  const check = {
    requirementId: "requirement-1",
    description: "点击后周一选中",
    businessCheck: {
      subjects: ["周一"],
      state: { label: "选中状态", property: "CHECKED", equals: true },
    },
  };
  expect(specCheckSchema.safeParse(check).success).toBe(false);
  expect(
    specCheckSchema.safeParse({
      ...check,
      businessCheck: {
        ...check.businessCheck,
        identityMatchMode: "DISPLAY_TEXT",
      },
    }).success,
  ).toBe(true);
});

describe("generation size limits", () => {
  it("accepts 10 compact Cases with 5 checks each and rejects either overflow without truncation", () => {
    const testCase = draft.cases[0]!;
    const sized = (cases: number, checks: number) => ({
      ...draft,
      cases: Array.from({ length: cases }, () => ({
        ...testCase,
        criteria: Array.from({ length: checks }, () => testCase.criteria[0]),
      })),
    });
    expect(compactSpecSchema.parse(sized(10, 5)).cases).toHaveLength(10);
    expect(() => normalizeCompactSpec(sized(11, 1), requirements)).toThrow();
    expect(() => normalizeCompactSpec(sized(1, 6), requirements)).toThrow();
  });
  it("applies the same limits to referenced checks", () => {
    const { criteria, ...testCase } = draft.cases[0]!;
    const sized = (cases: number, checks: number) => ({
      ...draft,
      cases: Array.from({ length: cases }, () => ({
        ...testCase,
        checkIds: Array.from({ length: checks }, (_, i) => `check-${i}`),
      })),
    });
    expect(
      referencedSpecSchema.parse(sized(10, 5)).cases[0]!.checkIds,
    ).toHaveLength(5);
    expect(referencedSpecSchema.safeParse(sized(11, 1)).success).toBe(false);
    expect(referencedSpecSchema.safeParse(sized(1, 6)).success).toBe(false);
  });
});
