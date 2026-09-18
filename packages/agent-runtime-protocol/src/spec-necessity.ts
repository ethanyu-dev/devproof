import type { RuntimeGeneratedSpec } from "./index.js";

export const SPEC_NECESSITY_GUIDANCE = `优先验证本次改动必要的业务结果，不按页面功能清单生成全面回归。
先确定 任务说明、Issue 或 PR 明确要求和实际改动直接影响的行为，再固定 requirements。Route Spec、整页文档、未改动代码是理解行为的依据，不会自动成为本次验收范围。需求依据来自次级来源时，必须提供 changeBasis：引用已读任务说明、Issue、PR 验收要求或 diff 的原文，并用 reason 说明该行为与本次需求/改动的具体关系；diff 引用须包含实际增删行（保留 +/-）。不能只写“文档有定义”或“属于同一页面”。
按独立业务结果划分需求和验收，操作步骤数量不等于验收数量。同一结果的相关字段、保存后的列表展示和重新打开后的持久化核对可以合为一个业务检查；不同条件或相反状态仍须分别判断。行为和前置条件相同的多个业务类型可共用一个需求/检查，通过 observationTargets 分别列出对象并全部取证，不能只测代表类型。前置条件或业务分支不同才拆 Case，不为减少单例验收数而增加大量 Case。
默认不追加通用权限、分页、排序、完整 CRUD、重复启停、逐字段 POST/PUT 校验或独立的重复只读 Case。只有 任务说明、Issue 或 PR 明确要求或实际变更直接影响时才纳入。登录、打开页面、定位控件、获取测试账号、截图和清理属于执行准备/操作/取证，不单列产品验收；清理和数据归属要求仍须执行。
默认采用能证明业务结果的 UI 证据；只有接口契约本身属于本次要求或变更影响时才强制 NETWORK。显式要求的样式对照、负向场景、边界行为和接口契约必须保留，不能为了精简删掉。
同一条件、对象和结果优先在一个 Case 中验证一次，不为覆盖率重复设计只读 Case 和生命周期 Case。Case 独立启动所需的基础观察放在步骤中，不自动升级为验收。先完成必要行为，再收尾，不补充无范围依据的探索分支。
不设置固定 Case/验收数量配额，也不为了“精简”把未验证的要求判为通过。无关回归范围可按需写入 outOfScope 并说明原因；真正的需求缺失仍写入 uncoveredRequirements。`;

type Requirement = NonNullable<RuntimeGeneratedSpec["requirements"]>[number];
type Context = {
  sources: ReadonlyMap<string, { kind: string }>;
  sourceContents: ReadonlyMap<string, string>;
};

/** Provenance gate, not a semantic entailment judge: the model must explain relevance. */
export function requirementNecessityError(
  requirement: Requirement,
  { sources, sourceContents }: Context,
) {
  const source = sources.get(requirement.sourceRef);
  if (!source) return `需求 ${requirement.id} 引用了未知来源。`;
  if (!sourceContents.get(requirement.sourceRef)?.includes(requirement.quote))
    return `需求 ${requirement.id} 的依据原文未出现在实际来源中。`;
  const proof = requirement.changeBasis;
  // Issue requirements need no additional model-generated metadata.
  if (["LINEAR_ISSUE", "TASK_BRIEF"].includes(source.kind) && !proof)
    return null;
  if (!proof)
    return `需求 ${requirement.id} 来自次级来源，缺少 changeBasis。请引用任务说明、Issue、PR 验收要求或实际 diff 并说明本次必须验证的原因；仅属页面已有能力的内容放入 outOfScope，不生成必需验收。`;
  const kind = sources.get(proof.sourceRef)?.kind;
  if (
    ![
      "LINEAR_ISSUE",
      "TASK_BRIEF",
      "GITHUB_PULL_REQUEST",
      "GITHUB_DIFF",
    ].includes(kind ?? "")
  )
    return `需求 ${requirement.id} 的 changeBasis 必须引用已读取的任务说明、Issue、PR 明确验收要求或实际 diff；整页文档和实现文件不能独自扩展范围。`;
  if (!sourceContents.get(proof.sourceRef)?.includes(proof.quote))
    return `需求 ${requirement.id} 的 changeBasis.quote 未出现在对应来源中。`;
  if (
    kind === "GITHUB_DIFF" &&
    !/^[+-](?![+-]{2})[^\r\n]*\S/m.test(proof.quote)
  )
    return `需求 ${requirement.id} 的 changeBasis.quote 必须包含 diff 的实际增删行（保留 +/-），不能只引用上下文或文件名。`;
  if (!/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(proof.reason))
    return `需求 ${requirement.id} 的 changeBasis.reason 必须用中文说明本次变更与待验证行为的关系。`;
  return null;
}

/** Only new generation opts in; reading/rerunning historical Specs is unchanged. */
export function specNecessityError(
  spec: RuntimeGeneratedSpec,
  context: Context,
) {
  if (spec.scopePolicy !== "CHANGE_FOCUSED") return null;
  for (const requirement of spec.requirements ?? []) {
    const error = requirementNecessityError(requirement, context);
    if (error) return error;
  }
  if (!spec.requirements) {
    for (const testCase of spec.cases) {
      for (const criterion of testCase.criteria) {
        // Legacy full-output generation can cite the Issue directly. Secondary
        // sources require a requirement list to retain the change justification.
        if (
          criterion.basis &&
          !["LINEAR_ISSUE", "TASK_BRIEF"].includes(
            context.sources.get(criterion.basis.sourceRef)?.kind ?? "",
          )
        )
          return `验收 ${criterion.id} 来自次级来源，请提供 requirements 及 changeBasis，并用 requirementId 映射；不能直接把整页能力升级为本次必需验收。`;
      }
    }
  }
  return null;
}
