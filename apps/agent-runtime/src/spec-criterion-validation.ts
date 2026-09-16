import {
  requiresNetworkEvidence,
  type RuntimeGeneratedSpec,
} from "@devproof/agent-runtime-protocol";

type Criterion = RuntimeGeneratedSpec["cases"][number]["criteria"][number];

export interface SpecCheckIssue {
  code: string;
  path: string;
  message: string;
  criterionId?: string;
  requirementId?: string;
  value?: unknown;
  boundSourceRefs?: string[];
  candidateSourceRefs?: string[];
}

/** Shared by check registration and final validation, so accepted checks stay valid. */
export function specCriterionIssues(
  criterion: Criterion,
  sourceContents: ReadonlyMap<string, string>,
): SpecCheckIssue[] {
  const issues: SpecCheckIssue[] = [];
  const add = (
    code: string,
    path: string,
    message: string,
    value?: unknown,
  ) => {
    issues.push({
      code,
      path,
      message: `验收标准 ${criterion.id} ${message}`,
      criterionId: criterion.id,
      ...(criterion.requirementId
        ? { requirementId: criterion.requirementId }
        : {}),
      ...(value === undefined ? {} : { value }),
      boundSourceRefs: criterion.sourceRefs,
    });
  };
  if (!/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(criterion.description))
    add(
      "CHINESE_REQUIRED",
      "description",
      "description 必须使用简体中文描述。",
      criterion.description,
    );
  for (const [index, ref] of criterion.sourceRefs.entries()) {
    if (!sourceContents.has(ref))
      add(
        "UNKNOWN_SOURCE",
        `sourceRefs[${index}]`,
        "引用了尚未观察到的来源。",
        ref,
      );
  }
  const basis = criterion.basis;
  if (!basis || !criterion.sourceRefs.includes(basis.sourceRef))
    add(
      "MISSING_BASIS",
      "basis",
      "缺少引用来源内的 basis。探索步骤和自拟测试标识不能作为产品要求。",
    );
  else if (!(sourceContents.get(basis.sourceRef) ?? "").includes(basis.quote))
    add(
      "QUOTE_NOT_FOUND",
      "basis.quote",
      "的 basis.quote 未出现在实际来源中；请引用支持该产品断言的原文。",
      basis.quote,
    );
  const targets = criterion.observationTargets ?? [];
  if (
    requiresNetworkEvidence(criterion.description) &&
    !criterion.requiredEvidenceKinds.includes("NETWORK")
  )
    add(
      "EVIDENCE_CAPABILITY_MISMATCH",
      "requiredEvidenceKinds",
      "检查接口参数或载荷时必须包含 NETWORK；DOM 只能证明页面状态。",
    );
  if (!targets.length && !criterion.observationContract)
    add(
      "MISSING_TARGETS",
      "observationTargets",
      "缺少 observationTargets；请为每个待验证对象声明 label 和可在页面或接口中核对的 expectedText。",
    );
  if (criterion.observationContract) {
    const contents = criterion.sourceRefs.map(
      (ref) => sourceContents.get(ref) ?? "",
    );
    for (const target of criterion.observationContract.targets) {
      for (const value of target.entity.oneOf)
        if (!contents.some((content) => content.includes(value)))
          add(
            "TARGET_TEXT_UNSUPPORTED",
            "observationContract.targets",
            "对象身份必须来自引用来源。",
            value,
          );
      if (
        target.requiredEvidenceKinds.some(
          (kind) => !criterion.requiredEvidenceKinds.includes(kind),
        )
      )
        add(
          "EVIDENCE_CAPABILITY_MISMATCH",
          "requiredEvidenceKinds",
          "必须包含所有结构化目标要求的证据类型。",
        );
    }
    for (const comparison of criterion.observationContract.comparisons)
      if (
        !criterion.sourceRefs.includes(comparison.sourceRef) ||
        !sourceContents.get(comparison.sourceRef)?.includes(comparison.quote)
      )
        add(
          "QUOTE_NOT_FOUND",
          "observationContract.comparisons",
          "视觉比较必须引用支持比较要求的来源原文。",
        );
  }
  const labels = new Set<string>();
  const texts = new Set<string>();
  for (const [index, target] of targets.entries()) {
    const path = `observationTargets[${index}]`;
    if (labels.has(target.label))
      add(
        "DUPLICATE_TARGET",
        `${path}.label`,
        "的 observationTargets.label 必须唯一。",
        target.label,
      );
    if (texts.has(target.expectedText))
      add(
        "AMBIGUOUS_TARGET",
        `${path}.expectedText`,
        "的 observationTargets.expectedText 必须能区分各对象，不能用相同文字代替多个对象。请使用各对象实际可见的类型或区域锚点。",
        target.expectedText,
      );
    labels.add(target.label);
    texts.add(target.expectedText);
    const values: Array<[string, string]> = [
      [`${path}.expectedText`, target.expectedText],
      ...(target.alternatives ?? []).map(
        (value, alternativeIndex) =>
          [`${path}.alternatives[${alternativeIndex}]`, value] as [
            string,
            string,
          ],
      ),
    ];
    for (const [field, value] of values) {
      if (
        criterion.sourceRefs.some((ref) =>
          (sourceContents.get(ref) ?? "").includes(value),
        )
      )
        continue;
      add(
        "TARGET_TEXT_UNSUPPORTED",
        field,
        "的 observationTargets.expectedText 及 alternatives 必须来自已读取的来源；核对并通过 supportingSourceRefs 补充支持该对象的界面证据，不能编造类型名或内部枚举。",
        value,
      );
      // Candidates are hints, never automatically added as evidence.
      issues[issues.length - 1]!.candidateSourceRefs = [...sourceContents]
        .filter(
          ([ref, content]) =>
            !criterion.sourceRefs.includes(ref) && content.includes(value),
        )
        .slice(0, 10)
        .map(([ref]) => ref);
    }
  }
  return issues;
}
