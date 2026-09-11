import type { RuntimeGeneratedSpec } from "./index.js";

/** Coverage is independent of case count and must survive format corrections. */
export function specRequirementCoverageError(spec: RuntimeGeneratedSpec) {
  if (!spec.requirements) {
    // Previously persisted Specs have neither requirement mapping nor omissions.
    return spec.uncoveredRequirements?.length ||
      spec.cases.some((item) =>
        item.criteria.some((criterion) => criterion.requirementId),
      )
      ? "需求映射必须提供需求清单。"
      : null;
  }
  const requirements = new Map(
    spec.requirements.map((item) => [item.id, item]),
  );
  if (requirements.size !== spec.requirements.length)
    return "需求编号不能重复。";
  const covered = new Set<string>();
  for (const testCase of spec.cases) {
    for (const criterion of testCase.criteria) {
      const requirement = requirements.get(criterion.requirementId ?? "");
      if (!requirement)
        return `验收标准 ${criterion.id} 必须引用已确定的需求编号。`;
      if (!criterion.required)
        return `需求 ${requirement.id} 的覆盖标准必须参与最终判定。`;
      if (
        criterion.basis?.sourceRef !== requirement.sourceRef ||
        criterion.basis.quote !== requirement.quote
      )
        return `验收标准 ${criterion.id} 的依据与需求 ${requirement.id} 不一致。`;
      covered.add(requirement.id);
    }
  }
  const uncovered = new Set<string>();
  for (const item of spec.uncoveredRequirements ?? []) {
    if (!requirements.has(item.requirementId))
      return `未知的未覆盖需求：${item.requirementId}。`;
    if (uncovered.has(item.requirementId) || covered.has(item.requirementId))
      return `需求 ${item.requirementId} 的覆盖状态重复或矛盾。`;
    uncovered.add(item.requirementId);
  }
  const missing = [...requirements.keys()].filter(
    (id) => !covered.has(id) && !uncovered.has(id),
  );
  return missing.length
    ? `遗漏需求：${missing.join("、")}。请补充验收标准，或在 uncoveredRequirements 中明确不能验证的原因；不能删除需求。`
    : null;
}
