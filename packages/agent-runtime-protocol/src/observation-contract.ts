import { z } from "zod";

export const BOUND_EVIDENCE_CAPABILITIES = [
  "observation-contract-v2",
  "bound-evidence-v1",
  "reference-evidence-images-v1",
] as const;
export const OBSERVATION_CONTRACT_GUIDANCE = `针对具体对象的控件状态、默认值以及样式参照比较，使用 observationContract.version=2，并省略 observationTargets。单纯文字、选项发现和网络验收继续使用 observationTargets；下述契约规则替代这些状态验收原有的文字目标规则。
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
export const observationContractSchema = z
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
