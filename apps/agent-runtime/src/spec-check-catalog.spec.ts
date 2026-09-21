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
  it("keeps UI checks while rejecting network assertions and permits a business-result correction", () => {
    const catalog = new SpecCheckCatalog();
    const result = catalog.define(
      {
        expectedRevision: 0,
        checks: [
          option,
          { ...option, description: "请求体 type 包含旧版对公转账枚举。" },
        ],
      },
      requirements,
      sources,
    );
    expect(result.saved).toHaveLength(1);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "NETWORK_REFERENCE_ONLY",
        inputIndex: 1,
      }),
    );
    const correction = catalog.define(
      {
        expectedRevision: catalog.revision,
        checks: [{ ...option, description: "可以选择旧版对公转账白名单。" }],
      },
      requirements,
      sources,
    );
    expect(correction.issues).toEqual([]);
  });
  it("identifies malformed assertion fields and preserves accepted v2 contracts", () => {
    const catalog = new SpecCheckCatalog();
    const assertion = {
      assertionId: "visible",
      subject: { kind: "SWITCH", label: "启用状态" },
      property: "VISIBLE",
      operator: "EQ",
      expected: true,
    };
    const target = {
      targetId: "legacy",
      label: "旧版配置",
      scope: { kind: "DIALOG", names: ["新增配置"] },
      entity: {
        controlKind: "SELECT",
        label: "类型",
        property: "SELECTED_LABEL",
        oneOf: ["旧版对公转账白名单"],
      },
      phase: "CURRENT",
      assertions: [assertion],
      requiredEvidenceKinds: ["DOM"],
      temporal: "SAME_OBSERVATION",
    };
    const check = {
      requirementId: "requirement-2",
      description: "旧版对公转账配置显示启用开关。",
      supportingSourceRefs: [ui],
      observationContract: { version: 2, targets: [target], comparisons: [] },
    };
    const { operator, ...missingOperator } = assertion;
    const invalid = catalog.define(
      {
        expectedRevision: 0,
        checks: [
          {
            ...check,
            observationContract: {
              ...check.observationContract,
              targets: [{ ...target, assertions: [missingOperator] }],
            },
          },
        ],
      },
      requirements,
      sources,
    );
    expect(invalid.saved).toEqual([]);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "observationContract.targets.0.assertions.0.operator",
          message: expect.stringContaining("EQ"),
        }),
      ]),
    );
    expect(
      catalog.define(
        { expectedRevision: 0, checks: [check] },
        requirements,
        sources,
      ),
    ).toMatchObject({ accepted: true, revision: 1 });
    expect(
      catalog.define(
        {
          expectedRevision: 1,
          checks: [
            { ...style, checkId: "check-1", supportingSourceRefs: [ui] },
          ],
        },
        requirements,
        sources,
      ),
    ).toMatchObject({
      accepted: false,
      issues: [expect.objectContaining({ code: "CONTRACT_DOWNGRADE" })],
    });
    expect(
      catalog.expand(draft(["check-1"]), requirements).cases[0]!.criteria[0]!
        .observationContract?.version,
    ).toBe(2);
  });

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

it("resolves referenced account bindings against the Case check order", () => {
  const catalog = new SpecCheckCatalog();
  catalog.define(
    {
      expectedRevision: 0,
      checks: [option, { ...style, supportingSourceRefs: [ui] }],
    },
    requirements,
    sources,
  );
  const base = draft(["check-2", "check-1"]);
  const expanded = catalog.expand(
    {
      ...base,
      cases: [
        {
          ...base.cases[0],
          accountRequirementsVersion: 2,
          accountRequirements: [
            {
              role: "subject",
              label: "权限测试用户",
              usage: "READ_EXISTING",
              rationale: "指定账号为权限验收对象",
              subjectBinding: {
                kind: "AUTH_SUBJECT",
                target: "指定用户权限",
                stepOrders: [1],
                criterionIds: ["check-1"],
                basis: { sourceRef: issue, quote: "新增旧版对公转账白名单" },
              },
            },
          ],
        },
      ],
    },
    requirements,
  );
  expect(
    expanded.cases[0]!.accountRequirements![0]!.subjectBinding!.criterionIds,
  ).toEqual([expanded.cases[0]!.criteria[1]!.id]);
});

it("generates concise business checks with repeated states and no generated DOM locators", () => {
  const localSources = new Map([
    [issue, "合规模型映射与旧版对公转账白名单的列表配置值显示启用。"],
  ]);
  const localRequirements = defineSpecRequirements(
    {
      requirements: [
        {
          description: "两种类型列表显示启用",
          sourceRef: issue,
          quote: "列表配置值显示启用",
        },
      ],
    },
    localSources,
    new Map([[issue, { kind: "LINEAR_ISSUE" }]]),
  );
  const catalog = new SpecCheckCatalog();
  const result = catalog.define(
    {
      expectedRevision: 0,
      checks: [
        {
          requirementId: "requirement-1",
          description: "两种类型的记录均显示启用。",
          businessCheck: {
            identityMatchMode: "DISPLAY_TEXT",
            subjects: ["合规模型映射", "旧版对公转账白名单"],
            state: { label: "配置值", equals: "启用" },
          },
        },
      ],
    },
    localRequirements,
    localSources,
  );
  expect(result.issues).toEqual([]);
  const expanded = catalog.expand(draft(["check-1"]), localRequirements);
  const criterion = expanded.cases[0]!.criteria[0]!;
  expect(criterion.description).toBe("两种类型的记录均显示启用。");
  expect(criterion.observationTargets).toBeUndefined();
  expect(criterion.observationContract?.version).toBe(3);
  expect(
    criterion.observationContract?.targets.map(
      (t) => t.assertions[0]!.expected,
    ),
  ).toEqual(["启用", "启用"]);
  expect(JSON.stringify(criterion.observationContract)).not.toContain(
    '"scope"',
  );
  expect(specCriterionIssues(criterion, localSources)).toEqual([]);
  const downgrade = catalog.define(
    {
      expectedRevision: catalog.revision,
      checks: [
        {
          checkId: "check-1",
          requirementId: "requirement-1",
          description: "两种类型的记录显示启用。",
          observationTargets: [{ label: "启用", expectedText: "启用" }],
        },
      ],
    },
    localRequirements,
    localSources,
  );
  expect(downgrade.issues[0]!.code).toBe("CONTRACT_DOWNGRADE");
});

it("rejects generated textual switch states and accepts their boolean correction", () => {
  const catalog = new SpecCheckCatalog();
  const check = {
    requirementId: "requirement-1",
    description: "旧版对公转账白名单的启用状态开关默认开启。",
    supportingSourceRefs: [ui],
    businessCheck: {
      identityMatchMode: "DISPLAY_TEXT",
      subjects: ["旧版对公转账白名单"],
      state: {
        property: "CHECKED",
        label: "启用状态",
        equals: "启用" as string | boolean,
      },
      when: "INITIAL_AFTER_OPEN",
    },
  };
  const rejected = catalog.define(
    { expectedRevision: 0, checks: [check] },
    requirements,
    sources,
  );
  expect(rejected.issues).toContainEqual(
    expect.objectContaining({ code: "INVALID_CHECK" }),
  );
  check.businessCheck.state.equals = true;
  expect(
    catalog.define(
      { expectedRevision: rejected.revision, checks: [check] },
      requirements,
      sources,
    ).saved,
  ).toHaveLength(1);
});
