/** Inspect test intent, not the presence of English characters or enum names. */
export function testsLocalization(value: string) {
  return /多语言|本地化|国际化|翻译|语言切换|切换.{0,30}(?:语言|英文|中文)|(?:英文|英语|中文|法语|日语|德语)(?:环境|版本|界面|页面).{0,45}(?:名称|显示名|文案|翻译)|(?:中英文|双语).{0,30}(?:一致|显示|名称|验证)|locali[sz]ation|internationali[sz]ation|multilingual|language switching|translation|translate.{0,50}(?:labels|text|English)|(?:switch|change).{0,30}(?:language|locale)/iu.test(
    value,
  );
}

export const SPEC_EXECUTION_SCOPE_GUIDANCE =
  "测试范围由任务说明、Issue 或 PR 中的明确需求决定。默认不生成语言切换、翻译一致性或跨语言品牌环境测试；PR 的 i18n 文件、英文枚举和 Route Spec 的多语言标签不能扩展测试范围。普通英文界面的功能测试仍保留。多语言需求必须在对应 requirement 中声明 testScope=LOCALIZATION，并通过 intentEvidence 引用任务说明、Issue 或 PR 验收要求中的明确原文。混合用例只移除无依据的语言步骤与验收，保留普通功能覆盖。同类型的创建、修改和清理优先组织为一个生命周期用例，分别记录验收。不同写入用例不能把文档示例账号当作已分配资源；缺少独立账号时明确声明需提供测试数据。浏览器验收优先使用用户可见结果；需要请求方法、参数、请求体或响应数据时 requiredEvidenceKinds 必须包含 NETWORK，JSON 按结构核对。";

type Requirement = {
  id: string;
  description: string;
  testScope?: string | undefined;
  intentEvidence?: { sourceRef: string; quote: string } | undefined;
  issueEvidence?: { sourceRef: string; quote: string } | undefined;
};
export function localizationRequirementError(
  requirement: Requirement,
  issueTexts: ReadonlyMap<string, string>,
) {
  if (
    requirement.testScope !== "LOCALIZATION" &&
    !testsLocalization(requirement.description)
  )
    return null;
  const proof = requirement.intentEvidence ?? requirement.issueEvidence;
  if (
    !proof ||
    !issueTexts.get(proof.sourceRef)?.includes(proof.quote) ||
    !testsLocalization(proof.quote) ||
    /(?:不需要|无需|不涉及|不包含|不做|不测试|out of scope|do not test|no need).{0,30}(?:多语言|本地化|翻译|英文|locali|translation|language)/iu.test(
      proof.quote,
    )
  )
    return `需求 ${requirement.id} 的多语言验证缺少明确测试意图。移除次级来源扩展的多语言范围，或提供 intentEvidence 的来源和原文。`;
  return null;
}

export function specCapabilityError(
  spec: {
    requirements?: Requirement[] | undefined;
    cases: Array<{
      name: string;
      preconditions: string[];
      steps: Array<{ action: string }>;
      criteria: Array<{
        id: string;
        description: string;
        requirementId?: string | undefined;
        requiredEvidenceKinds: string[];
      }>;
    }>;
  },
  issueTexts: ReadonlyMap<string, string>,
) {
  const requirements = new Map((spec.requirements ?? []).map((r) => [r.id, r]));
  for (const requirement of requirements.values()) {
    const error = localizationRequirementError(requirement, issueTexts);
    if (error) return error;
  }
  for (const testCase of spec.cases) {
    const authorized = testCase.criteria.some((c) => {
      const r = requirements.get(c.requirementId ?? "");
      return (
        r?.testScope === "LOCALIZATION" &&
        !localizationRequirementError(r, issueTexts)
      );
    });
    if (
      !authorized &&
      testsLocalization(
        [
          testCase.name,
          ...testCase.preconditions,
          ...testCase.steps.map((s) => s.action),
          ...testCase.criteria.map((c) => c.description),
        ].join("\n"),
      )
    )
      return `用例「${testCase.name}」包含无明确需求依据的多语言步骤或验收，请移除额外范围并保留普通功能检查。`;
    for (const criterion of testCase.criteria) {
      if (
        requiresNetworkEvidence(criterion.description) &&
        !criterion.requiredEvidenceKinds.includes("NETWORK")
      )
        return `验收 ${criterion.id} 检查接口请求或响应，必须使用 NETWORK 证据；不能用 DOM 证明请求参数。可改为独立的用户可见功能验收。`;
    }
  }
  return null;
}

export function requiresNetworkEvidence(description: string) {
  return /请求体|请求参数|请求.{0,12}(?:携带|包含|参数|POST|PUT|PATCH|DELETE)|响应(?:体|数据|JSON)|request (?:body|payload|parameters)|response (?:body|json)/iu.test(
    description,
  );
}
