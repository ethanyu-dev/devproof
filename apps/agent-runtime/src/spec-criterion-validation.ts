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
  if (criterion.observationContract?.version === 3) {
    for (const [ti, target] of criterion.observationContract.targets.entries())
      for (const [ai, assertion] of target.assertions.entries())
        if (
          assertion.property &&
          assertion.expected !== undefined &&
          (assertion.property === "CHECKED") !==
            (typeof assertion.expected === "boolean")
        )
          add(
            "STATE_TYPE_MISMATCH",
            `observationContract.targets[${ti}].assertions[${ai}].expected`,
            "状态值类型必须与目标属性一致：CHECKED 为布尔值，TEXT/VALUE 为字符串。",
          );
    if (requiresNetworkEvidence(criterion.description))
      add(
        "EVIDENCE_CHANNEL_MISMATCH",
        "observationContract",
        "网络字段必须使用 observationTargets[].network；businessCheck 只验证界面状态。请保留原业务义务并分别声明网络字段与界面检查。",
      );
  }
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
  if (
    criterion.observationContract?.version === 3 &&
    criterion.description.length > 160
  )
    add(
      "DESCRIPTION_TOO_LONG",
      "description",
      "业务描述最多 160 字，建议压缩为 80 字以内的一句话；对象和预期放 businessCheck。",
      criterion.description,
    );
  if (criterion.observationContract) {
    const contents = criterion.sourceRefs.map(
      (ref) => sourceContents.get(ref) ?? "",
    );
    for (const target of criterion.observationContract.targets) {
      for (const value of "identity" in target
        ? [target.identity.text]
        : target.entity.oneOf)
        if (!contents.some((content) => content.includes(value)))
          add(
            "TARGET_TEXT_UNSUPPORTED",
            "observationContract.targets",
            "对象身份必须来自引用来源。",
            value,
          );
      if ("identity" in target)
        for (const assertion of target.assertions)
          if (
            typeof assertion.expected === "string" &&
            !contents.some((content) =>
              content.includes(assertion.expected as string),
            )
          )
            add(
              "TARGET_TEXT_UNSUPPORTED",
              "observationContract.targets.assertions",
              "预期字面值必须有来源依据；需求描述不能改写成不存在的页面文字。",
              assertion.expected,
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
  const networkChecks = new Set<string>();
  for (const [index, target] of targets.entries()) {
    const path = `observationTargets[${index}]`;
    if (labels.has(target.label))
      add(
        "DUPLICATE_TARGET",
        `${path}.label`,
        "的 observationTargets.label 必须唯一。",
        target.label,
      );
    if (texts.has(target.expectedText) && !target.network)
      add(
        "AMBIGUOUS_TARGET",
        `${path}.expectedText`,
        "用相同状态验证多个对象时，请改用 businessCheck.subjects + state，分别绑定各对象；不要为区分对象把需求句子拼进 expectedText。",
        target.expectedText,
      );
    if (target.network && !criterion.requiredEvidenceKinds.includes("NETWORK"))
      add(
        "EVIDENCE_CAPABILITY_MISMATCH",
        `${path}.network`,
        "结构化请求检查必须包含 NETWORK 证据。",
      );
    if (target.network) {
      const signature = JSON.stringify(target.network);
      if (networkChecks.has(signature))
        add(
          "AMBIGUOUS_TARGET",
          `${path}.network`,
          "多个对象必须有各自的请求筛选条件，不能重复同一检查冒充分别覆盖。",
        );
      networkChecks.add(signature);
      const values = [
        target.network.equals,
        ...target.network.where.map((w) => w.equals),
      ].filter((v): v is string => typeof v === "string");
      for (const value of values)
        if (
          !criterion.sourceRefs.some((ref) =>
            (sourceContents.get(ref) ?? "").includes(value),
          )
        )
          add(
            "TARGET_TEXT_UNSUPPORTED",
            `${path}.network`,
            "网络字段预期和对象筛选值必须有来源依据。",
            value,
          );
    }
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
