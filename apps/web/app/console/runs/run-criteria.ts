interface CriterionResult {
  criterionId: string;
  status: string;
  summary: string;
  blockingReason?: string | null;
  evidenceRefs?: string[];
}

export interface DisplayCriterion {
  description: string;
  id: string;
  required: boolean;
  status: string | null;
  summary: string | null;
  basis: string[];
  environmentBlocked?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Old runs embedded provenance in description. Keep immutable snapshots intact
 * and present both generations through the same concise view.
 */
export function displayCriteria(detail: {
  criteriaSnapshot: unknown;
  criterionResults: CriterionResult[];
}): DisplayCriterion[] {
  const definitions = Array.isArray(detail.criteriaSnapshot)
    ? detail.criteriaSnapshot.flatMap((raw): DisplayCriterion[] => {
        const value = record(raw);
        if (typeof value.id !== "string") return [];
        const result = detail.criterionResults.find(
          (item) => item.criterionId === value.id,
        );
        const original =
          typeof value.description === "string" ? value.description : value.id;
        const boundary = original.search(
          /\n(?:验收对象：|来源原文：|Spec 来源：)/u,
        );
        let description = boundary < 0 ? original : original.slice(0, boundary);
        const basis = boundary < 0 ? [] : [original.slice(boundary).trim()];
        const source = record(value.basis);
        if (typeof source.observationTarget === "string")
          basis.push(`验收对象：${source.observationTarget}`);
        if (typeof source.quote === "string")
          basis.push(`来源原文：${source.quote}`);
        if (Array.isArray(source.sourceRefs)) {
          const refs = source.sourceRefs.filter(
            (ref): ref is string => typeof ref === "string",
          );
          if (refs.length) basis.push(`Spec 来源：${refs.join(", ")}`);
        }
        for (const rawTarget of Array.isArray(value.observationTargets)
          ? value.observationTargets
          : []) {
          const target = record(rawTarget);
          // Only remove redundant enum qualifiers when the display name is also
          // present. Never rewrite expected API values or behavioral conditions.
          if (
            typeof target.expectedText !== "string" ||
            !description.includes(target.expectedText)
          )
            continue;
          for (const alternative of Array.isArray(target.alternatives)
            ? target.alternatives
            : []) {
            if (
              typeof alternative !== "string" ||
              !/^[A-Z][A-Z0-9_]+$/u.test(alternative)
            )
              continue;
            const simplified = description
              .replaceAll(` ${alternative} 对应的`, "")
              .replaceAll(`${alternative} 对应的`, "");
            if (simplified !== description) {
              basis.push(`类型标识：${target.expectedText} · ${alternative}`);
              description = simplified;
            }
          }
        }
        return [
          {
            description: description.trim(),
            id: value.id,
            required: value.required !== false,
            status: result?.status ?? null,
            summary: result?.summary ?? null,
            environmentBlocked:
              result?.status === "INCONCLUSIVE" &&
              ["DATA_PRECONDITION", "ENVIRONMENT_UNAVAILABLE"].includes(
                result.blockingReason ?? "",
              ) &&
              Boolean(result.evidenceRefs?.length),
            basis: [...new Set(basis)],
          },
        ];
      })
    : [];
  return definitions.length
    ? definitions
    : detail.criterionResults.map((result) => ({
        description: result.summary,
        id: result.criterionId,
        required: true,
        status: result.status,
        summary: null,
        environmentBlocked:
          result.status === "INCONCLUSIVE" &&
          ["DATA_PRECONDITION", "ENVIRONMENT_UNAVAILABLE"].includes(
            result.blockingReason ?? "",
          ) &&
          Boolean(result.evidenceRefs?.length),
        basis: [],
      }));
}
