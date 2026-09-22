import { z } from "zod";

export const BOUND_EVIDENCE_CAPABILITIES = [
  "observation-contract-v2",
  "bound-evidence-v1",
  "reference-evidence-images-v1",
] as const;
export const BUSINESS_CHECK_CAPABILITY = "business-checks-v3";
export const OBSERVATION_CONTRACT_GUIDANCE = `针对具体对象的控件状态、默认值以及样式参照比较，使用 observationContract.version=2，并省略 observationTargets。单纯文字和选项发现继续使用 observationTargets；网络请求仅作参考，不进入验收标准；下述契约规则替代这些状态验收原有的文字目标规则。
契约分别声明 scope 区域、entity 身份、phase 阶段、assertions 属性断言、requiredEvidenceKinds 和 temporal=SAME_OBSERVATION。SELECTED_LABEL 是实际选中项，不是搜索词；区域、对象、阶段和全部断言必须同时成立，oneOf 只表示同一对象的等价名称。scope.names、entity.label 和 subject.label 使用来源明确的界面名称，不追加“开关”“选择器”等解释性词语；控件种类已由 kind 表达。
targetId/assertionId/comparisonId 先用本标准内唯一的短标识，API 固化时分配正式编号。默认状态用 INITIAL_AFTER_OPEN，步骤明确每个类型新开弹窗、选择类型、观察后关闭，不能手动打开开关来证明默认开启。普通当前状态用 CURRENT。
样式比较在 comparisons 中声明 subjectTargetId/referenceTargetId、需求支持的 dimensions、sourceRef 和原文 quote；两侧目标都要求 DOM 和 SCREENSHOT。不要增加来源未要求的像素、字体或精确颜色条件。所有对象名称和断言必须有来源依据。
每条 assertions 必须是对象，不能是元组，必须显式包含 operator 和 expected。布尔属性 CHECKED/VISIBLE/ENABLED 只支持 operator="EQ" 和布尔 expected；VALUE/TEXT 支持 EQ+字符串或 ONE_OF+字符串数组。
完整格式示例（名称、预期和来源须替换为当前需求证据）：{"version":2,"targets":[{"targetId":"type-a-default","label":"类型 A 默认启用","scope":{"kind":"DIALOG","names":["新增配置"]},"entity":{"controlKind":"SELECT","label":"类型","property":"SELECTED_LABEL","oneOf":["类型 A"]},"phase":"INITIAL_AFTER_OPEN","assertions":[{"assertionId":"enabled","subject":{"kind":"SWITCH","label":"启用状态"},"property":"CHECKED","operator":"EQ","expected":true}],"requiredEvidenceKinds":["DOM","SCREENSHOT"],"temporal":"SAME_OBSERVATION"}],"comparisons":[]}。
若格式校验失败，按 issues 的字段路径修正契约；不能改用 observationTargets 或删除默认状态/比较要求来绕过格式错误。`;
const id = z.string().trim().min(1).max(160);
const label = z.string().trim().min(1).max(500);
const subject = z.object({
  kind: z.enum(["SWITCH", "FIELD", "CONTROL"]),
  label,
});
const common = { assertionId: id, subject };
export const observationAssertionSchema = z.union([
  z
    .object({
      ...common,
      property: z.enum(["CHECKED", "VISIBLE", "ENABLED"]),
      operator: z.literal("EQ"),
      expected: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...common,
      property: z.enum(["VALUE", "TEXT"]),
      operator: z.literal("EQ"),
      expected: z.string().max(500),
    })
    .strict(),
  z
    .object({
      ...common,
      property: z.enum(["VALUE", "TEXT"]),
      operator: z.literal("ONE_OF"),
      expected: z.array(z.string().max(500)).min(1).max(10),
    })
    .strict(),
]);
export const observationTargetV2Schema = z
  .object({
    targetId: id,
    label,
    scope: z
      .object({
        kind: z.enum(["PAGE", "DIALOG", "FORM", "TABLE_ROW", "POPOVER"]),
        names: z.array(label).min(1).max(10),
      })
      .strict(),
    entity: z
      .object({
        controlKind: z.enum(["SELECT", "FIELD", "ROW"]),
        label,
        property: z.enum(["SELECTED_LABEL", "VALUE", "TEXT"]),
        oneOf: z.array(label).min(1).max(10),
      })
      .strict(),
    phase: z.enum([
      "CURRENT",
      "INITIAL_AFTER_OPEN",
      "AFTER_ACTION",
      "REOPENED",
    ]),
    assertions: z.array(observationAssertionSchema).min(1).max(8),
    requiredEvidenceKinds: z
      .array(z.enum(["DOM", "SCREENSHOT"]))
      .min(1)
      .max(2),
    temporal: z.literal("SAME_OBSERVATION"),
  })
  .strict();
export const visualComparisonRequirementSchema = z
  .object({
    comparisonId: id,
    subjectTargetId: id,
    referenceTargetId: id,
    dimensions: z.array(label).min(1).max(8),
    sourceRef: label,
    quote: z.string().trim().min(1).max(2000),
  })
  .strict();
const observationContractV2Schema = z
  .object({
    version: z.literal(2),
    targets: z.array(observationTargetV2Schema).min(1).max(20),
    comparisons: z
      .array(visualComparisonRequirementSchema)
      .max(100)
      .default([]),
  })
  .strict()
  .superRefine((contract, ctx) => {
    const targets = new Map(contract.targets.map((t) => [t.targetId, t]));
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (targets.size !== contract.targets.length)
      issue("Target IDs must be unique.");
    for (const target of contract.targets) {
      if (
        new Set(target.assertions.map((a) => a.assertionId)).size !==
        target.assertions.length
      )
        issue("Assertion IDs must be unique within a target.");
      if (
        target.entity.property === "SELECTED_LABEL" &&
        target.entity.controlKind !== "SELECT"
      )
        issue("SELECTED_LABEL requires a SELECT entity.");
      if (!target.requiredEvidenceKinds.includes("DOM"))
        issue("Structured assertions require DOM evidence.");
    }
    if (
      new Set(contract.comparisons.map((c) => c.comparisonId)).size !==
      contract.comparisons.length
    )
      issue("Comparison IDs must be unique.");
    for (const comparison of contract.comparisons) {
      if (comparison.subjectTargetId === comparison.referenceTargetId)
        issue("A comparison requires two different targets.");
      for (const targetId of [
        comparison.subjectTargetId,
        comparison.referenceTargetId,
      ])
        if (
          !targets.get(targetId)?.requiredEvidenceKinds.includes("SCREENSHOT")
        )
          issue("Comparison targets must exist and require screenshots.");
    }
  });
/** Business identity is independent of the value being verified. Locators are runtime evidence. */
export const businessCheckSchema = z
  .object({
    subjects: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
    identityMatchMode: z.enum(["EXACT", "DISPLAY_TEXT"]).optional(),
    state: z
      .object({
        property: z.enum(["TEXT", "CHECKED", "VALUE", "VISIBLE"]).optional(),
        matchMode: z.enum(["EXACT", "DISPLAY_TEXT"]).optional(),
        label: z.string().trim().min(1).max(80),
        equals: z
          .union([z.boolean(), z.string().max(500)])
          .describe(
            "开关、勾选等布尔状态使用 true/false；列表配置值等可见文字使用字符串。",
          ),
      })
      .strict(),
    when: observationTargetV2Schema.shape.phase.default("CURRENT"),
    compareWith: z.string().trim().min(1).max(120).optional(),
    dimensions: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
  })
  .strict()
  .superRefine((check, ctx) => {
    if (
      check.state.matchMode === "DISPLAY_TEXT" &&
      check.state.property !== "TEXT"
    )
      ctx.addIssue({
        code: "custom",
        path: ["state", "matchMode"],
        message: "DISPLAY_TEXT is only valid for TEXT assertions.",
      });
    if (
      check.state.property &&
      ["CHECKED", "VISIBLE"].includes(check.state.property) !==
        (typeof check.state.equals === "boolean")
    )
      ctx.addIssue({
        code: "custom",
        path: ["state", "equals"],
        message:
          "CHECKED/VISIBLE require a boolean; TEXT/VALUE require a string.",
      });
    if (new Set(check.subjects).size !== check.subjects.length)
      ctx.addIssue({
        code: "custom",
        message: "Business subjects must be unique.",
      });
    if (check.compareWith && check.subjects.includes(check.compareWith))
      ctx.addIssue({
        code: "custom",
        message: "Comparison reference must differ from the subjects.",
      });
    if (Boolean(check.compareWith) !== Boolean(check.dimensions.length))
      ctx.addIssue({
        code: "custom",
        message:
          "Comparison reference and dimensions must be supplied together.",
      });
  });
export const observationTargetV3Schema = z
  .object({
    targetId: id,
    label,
    identity: z
      .object({
        text: label,
        matchMode: z.enum(["EXACT", "DISPLAY_TEXT"]).optional(),
      })
      .strict(),
    phase: observationTargetV2Schema.shape.phase,
    assertions: z
      .array(
        z
          .object({
            assertionId: id,
            property: z
              .enum(["TEXT", "CHECKED", "VALUE", "VISIBLE"])
              .optional(),
            matchMode: z.enum(["EXACT", "DISPLAY_TEXT"]).optional(),
            label,
            expected: z.union([z.boolean(), z.string().max(500)]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    requiredEvidenceKinds:
      observationTargetV2Schema.shape.requiredEvidenceKinds,
  })
  .strict();
const observationContractV3Schema = z
  .object({
    version: z.literal(3),
    targets: z.array(observationTargetV3Schema).min(1).max(21),
    comparisons: z
      .array(visualComparisonRequirementSchema)
      .max(100)
      .default([]),
  })
  .strict()
  .superRefine((contract, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    const targets = new Map(contract.targets.map((t) => [t.targetId, t]));
    if (targets.size !== contract.targets.length)
      issue("Target IDs must be unique.");
    if (
      new Set(contract.targets.map((t) => t.identity.text)).size !==
      targets.size
    )
      issue("Each target must identify a distinct business subject.");
    for (const target of contract.targets) {
      for (const assertion of target.assertions)
        if (
          assertion.matchMode === "DISPLAY_TEXT" &&
          assertion.property !== "TEXT"
        )
          issue("DISPLAY_TEXT is only valid for TEXT assertions.");
      if (
        target.assertions.some((a) => a.expected === undefined) &&
        (!contract.comparisons.some(
          (c) => c.referenceTargetId === target.targetId,
        ) ||
          contract.comparisons.some(
            (c) => c.subjectTargetId === target.targetId,
          ))
      )
        issue(
          "Capture-only assertions are reserved for visual reference targets.",
        );
      if (!target.requiredEvidenceKinds.includes("DOM"))
        issue("Business state requires DOM evidence.");
      if (
        new Set(target.assertions.map((a) => a.assertionId)).size !==
        target.assertions.length
      )
        issue("Assertion IDs must be unique within a target.");
    }
    if (
      new Set(contract.comparisons.map((c) => c.comparisonId)).size !==
      contract.comparisons.length
    )
      issue("Comparison IDs must be unique.");
    for (const c of contract.comparisons) {
      if (c.subjectTargetId === c.referenceTargetId)
        issue("Comparison requires two different targets.");
      for (const id of [c.subjectTargetId, c.referenceTargetId])
        if (!targets.get(id)?.requiredEvidenceKinds.includes("SCREENSHOT"))
          issue("Comparison targets must exist and require screenshots.");
    }
  });
export const observationContractSchema = z.union([
  observationContractV2Schema,
  observationContractV3Schema,
]);
export type ObservationTargetV3 = z.infer<typeof observationTargetV3Schema>;

/** The compiler supplies IDs/evidence plumbing; generation supplies only business obligations. */
export function compileBusinessCheck(
  check: z.infer<typeof businessCheckSchema>,
  basis: { sourceRef: string; quote: string },
  kinds: readonly string[],
): z.infer<typeof observationContractV3Schema> {
  const subjects = [
    ...check.subjects,
    ...(check.compareWith ? [check.compareWith] : []),
  ];
  return observationContractV3Schema.parse({
    version: 3,
    targets: subjects.map((subject, i) => ({
      targetId: `subject-${i + 1}`,
      label: subject,
      identity: {
        text: subject,
        ...(check.identityMatchMode
          ? { matchMode: check.identityMatchMode }
          : {}),
      },
      phase: i < check.subjects.length ? check.when : "CURRENT",
      assertions: [
        {
          assertionId: "state",
          label: check.state.label,
          ...(check.state.property ? { property: check.state.property } : {}),
          ...(check.state.matchMode
            ? { matchMode: check.state.matchMode }
            : {}),
          ...(i < check.subjects.length
            ? { expected: check.state.equals }
            : {}),
        },
      ],
      requiredEvidenceKinds: [
        "DOM",
        ...(check.compareWith || kinds.includes("SCREENSHOT")
          ? ["SCREENSHOT"]
          : []),
      ],
    })),
    comparisons: check.compareWith
      ? check.subjects.map((_, i) => ({
          comparisonId: `comparison-${i + 1}`,
          subjectTargetId: `subject-${i + 1}`,
          referenceTargetId: `subject-${subjects.length}`,
          dimensions: check.dimensions,
          ...basis,
        }))
      : [],
  });
}
export const BUSINESS_CHECK_GUIDANCE = `对象状态验收只填写 businessCheck：subjects（必须分别覆盖的业务对象）、state（label 与 equals）、when（仅默认值、操作后、重新打开时需要指定）。不同对象可以有相同状态值。不要填写 DOM 区域、控件类型、定位器、引用 ID 或 observationContract，执行阶段根据实际页面选择取证位置。
示例：{"subjects":["合规模型映射","旧版对公转账白名单"],"state":{"label":"配置值","equals":"启用"}}。默认启用使用 equals=true、when="INITIAL_AFTER_OPEN"，不得手动开启来证明默认值。视觉对比才填写 compareWith 和 dimensions，参照对象不是新增测试需求。
列表显示文字使用 state.property=TEXT；开关选中状态使用 CHECKED；输入值使用 VALUE；显示/隐藏使用 VISIBLE 和布尔预期，subjects 绑定仍存在的业务对象（例如实际选中的产品分类），断言 label 使用目标控件名称。隐藏取证要求完整目标区域根节点的 DOM，视口未出现不能证明隐藏。操作提到“开关”不代表列表断言是布尔值。
网络请求只供 Agent 参考，不生成 observationTargets[].network、不要求 NETWORK 证据，也不把请求方法、路径、参数或响应字段改写为 businessCheck。验收保留用户可见的业务结果；接口细节按需放在 testData。
必须显式填写 identityMatchMode：普通按钮名称设置 DISPLAY_TEXT，忽略汉字间排版空格；ID、SKU、账号仍使用 EXACT。
多选按钮的选中状态同样使用 CHECKED。每个星期是独立 subject，不能把周一到周日写成 alternatives；要求“仅选中”时，还要验证其他对象为 false。工作日、全选、周末分开定义 AFTER_ACTION 检查，再次打开使用 REOPENED；不要用最终列表文字代替按钮状态。
展示文字可使用 state.property=TEXT、state.matchMode=DISPLAY_TEXT，容忍汉字间排版空格和时间范围分隔符两侧空格；VALUE 仍精确匹配。
普通文字发现继续使用 observationTargets；expectedText 只能是实际界面文字，不能填“列表展示目标记录”等需求句子。description 尽量一句话、80 字以内，步骤只保留业务动作及必要顺序，不规定点击路线。不要把每个字段或取证动作生成独立标准。`;
export type ObservationContract = z.infer<typeof observationContractSchema>;
export type ObservationTargetV2 = z.infer<typeof observationTargetV2Schema>;

const evaluation = z.enum(["MATCHED", "MISMATCHED", "UNKNOWN"]);
export const observationBindingSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  attemptId: z.string().uuid(),
  criterionId: id,
  targetId: id,
  contractDigest: z.string().length(64),
  observationId: z.string().uuid(),
  captureId: z.string().uuid(),
  sourceCommandId: z.string().uuid(),
  scopeIdentity: id,
  entityKey: label,
  phase: observationTargetV2Schema.shape.phase,
  phaseProven: z.boolean(),
  regionEpoch: id.optional(),
  facts: z
    .array(
      z.object({
        assertionId: id,
        nodeId: id,
        property: label,
        actual: z.union([z.boolean(), z.string().max(500)]).optional(),
        evaluation,
      }),
    )
    .max(8),
  evaluation,
  readiness: z.enum(["PARTIAL", "READY"]),
  evidenceRefs: z.array(z.string().max(500)).max(20),
  capturedAt: z.string().datetime(),
  reasons: z.array(z.string().max(500)).max(20),
});
export type ObservationBinding = z.infer<typeof observationBindingSchema>;
export const bindObservationInputSchema = z
  .object({
    targetId: id,
    observationId: z.string().uuid(),
    scopeRef: id,
    entityRef: id,
    assertionRefs: z.record(id, id),
  })
  .strict();
export const readBindingsInputSchema = z
  .object({
    bindingIds: z.array(z.string().uuid()).min(1).max(20).optional(),
    continuationToken: z.string().max(2000).optional(),
  })
  .strict();
export const readEvidenceImagesInputSchema = z
  .object({ bindingIds: z.array(z.string().uuid()).min(1).max(2) })
  .strict();
export const visualComparisonInputSchema = z
  .object({
    supersedesReviewId: z.string().uuid().optional(),
    comparisonId: id,
    bindingIds: z.tuple([z.string().uuid(), z.string().uuid()]),
    deliveryId: z.string().uuid(),
    verdict: z.enum(["EQUIVALENT", "DIFFERENT", "UNKNOWN"]),
    rationale: z.string().trim().min(1).max(2000),
    dimensions: z.array(label).min(1).max(8),
  })
  .strict();
export const visualComparisonReviewSchema = visualComparisonInputSchema.extend({
  id: z.string().uuid(),
  criterionId: id,
  contractDigest: z.string().length(64),
});
export type VisualComparisonReview = z.infer<
  typeof visualComparisonReviewSchema
>;
