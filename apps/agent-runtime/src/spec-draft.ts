import {
  runtimeGeneratedSpecSchema,
  runtimeObservationTargetSchema,
  runtimeSpecCriterionSchema,
  runtimeSpecRequirementSchema,
  runtimeUncoveredRequirementSchema,
  localizationRequirementError,
  requirementNecessityError,
} from "@devproof/agent-runtime-protocol";
import { z } from "zod";

const text = z.string().trim().min(1).max(5_000);
const notes = z.array(text).max(100).default([]);

export const requirementPlanSchema = z.object({
  requirements: z
    .array(
      runtimeSpecRequirementSchema.omit({ id: true }).extend({
        changeBasis: runtimeSpecRequirementSchema.shape.changeBasis.describe(
          "依据来自次级来源时必填：引用 Issue 或实际 diff 增删行，并说明为何是本次必要验证。直接引用 Issue 的需求可省略。",
        ),
      }),
    )
    .min(1)
    .max(100),
});

export type SpecRequirement = z.infer<typeof runtimeSpecRequirementSchema>;

export const specCheckSchema = z.object({
  requirementId: z.string().trim().min(1).max(100),
  description: text,
  observationTargets: z.array(runtimeObservationTargetSchema).min(1).max(20),
  supportingSourceRefs: z
    .array(z.string().trim().min(1).max(500))
    .max(99)
    .default([]),
  requiredEvidenceKinds:
    runtimeSpecCriterionSchema.shape.requiredEvidenceKinds.default(["DOM"]),
});

/** Model-facing input; repeated audit fields are filled by the runtime. */
export const compactSpecSchema = z.object({
  summary: text,
  assumptions: notes,
  risks: notes,
  outOfScope: notes.describe(
    "按需说明不属于本次变更的回归范围及原因；不能放入真正未覆盖的需求。",
  ),
  uncoveredRequirements: z
    .array(runtimeUncoveredRequirementSchema)
    .max(100)
    .default([]),
  cases: z
    .array(
      z.object({
        name: runtimeGeneratedSpecSchema.shape.cases.element.shape.name,
        steps: z.array(text).min(1).max(100),
        preconditions: notes,
        testData: notes,
        cleanup: runtimeGeneratedSpecSchema.shape.cases.element.shape.cleanup,
        criteria: z.array(specCheckSchema).min(1).max(100),
      }),
    )
    .min(1)
    .max(100),
});

/** Only the generation format changes; execution still receives full criteria. */
export const referencedSpecSchema = compactSpecSchema.extend({
  cases: z
    .array(
      compactSpecSchema.shape.cases.element
        .omit({ criteria: true })
        .extend({
          checkIds: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
        })
        .strict(),
    )
    .min(1)
    .max(100),
});

export function expandSpecCheck(
  check: z.infer<typeof specCheckSchema>,
  requirement: SpecRequirement,
  id: string,
) {
  const { supportingSourceRefs, ...criterion } = check;
  return runtimeSpecCriterionSchema.parse({
    ...criterion,
    id,
    sourceRefs: [...new Set([requirement.sourceRef, ...supportingSourceRefs])],
    basis: {
      sourceRef: requirement.sourceRef,
      quote: requirement.quote,
      observationTarget: check.observationTargets
        .map((target) => target.label)
        .join("、")
        .slice(0, 500),
    },
  });
}

export function normalizeCompactSpec(
  raw: unknown,
  requirements: readonly SpecRequirement[],
) {
  const draft = compactSpecSchema.parse(raw);
  const byId = new Map(requirements.map((item) => [item.id, item]));
  return runtimeGeneratedSpecSchema.parse({
    ...draft,
    scopePolicy: "CHANGE_FOCUSED",
    requirements,
    scope: {
      inScope: requirements.map((item) => item.description),
      outOfScope: draft.outOfScope,
    },
    cases: draft.cases.map((testCase, caseIndex) => {
      const criteria = testCase.criteria.map((criterion, index) => {
        const requirement = byId.get(criterion.requirementId);
        if (!requirement)
          throw new Error(
            `未知需求编号：${criterion.requirementId}。请使用 define_requirements 返回的编号。`,
          );
        return expandSpecCheck(
          criterion,
          requirement,
          `case-${caseIndex + 1}-criterion-${index + 1}`,
        );
      });
      return {
        ...testCase,
        preconditions: testCase.preconditions.length
          ? testCase.preconditions
          : ["使用任务指定的验证环境和浏览器身份。"],
        rationale: [
          ...new Set(
            testCase.criteria.map(
              (item) => byId.get(item.requirementId)!.description,
            ),
          ),
        ]
          .join("\n")
          .slice(0, 5_000),
        sourceRefs: [
          ...new Set(criteria.flatMap((criterion) => criterion.sourceRefs)),
        ],
        criteria,
        steps: testCase.steps.map((action, index) => ({
          order: index + 1,
          action,
          expectedObservation: "记录实际结果，并按验收标准进行判定。",
        })),
      };
    }),
  });
}

export function defineSpecRequirements(
  raw: unknown,
  sourceContents: ReadonlyMap<string, string>,
  sources: ReadonlyMap<string, { kind: string }>,
  issueTexts: ReadonlyMap<string, string> = new Map(),
): SpecRequirement[] {
  const plan = requirementPlanSchema.parse(raw);
  return plan.requirements.map((item, index) => {
    if (!/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(item.description))
      throw new Error("需求描述必须使用中文；来源原文保持原样。");
    const content = sourceContents.get(item.sourceRef);
    if (!content?.includes(item.quote))
      throw new Error(
        `需求「${item.description}」必须引用实际读取来源中的原文。`,
      );
    const requirement = { ...item, id: `requirement-${index + 1}` };
    const scopeError = localizationRequirementError(requirement, issueTexts);
    if (scopeError) throw new Error(scopeError);
    const necessityError = requirementNecessityError(requirement, {
      sources,
      sourceContents,
    });
    if (necessityError) throw new Error(necessityError);
    return requirement;
  });
}
