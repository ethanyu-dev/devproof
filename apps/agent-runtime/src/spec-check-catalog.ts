import { z } from "zod";
import {
  expandSpecCheck,
  normalizeCompactSpec,
  referencedSpecSchema,
  specCheckSchema,
  type SpecRequirement,
} from "./spec-draft.js";
import {
  specCriterionIssues,
  type SpecCheckIssue,
} from "./spec-criterion-validation.js";

const checkUpdateSchema = specCheckSchema
  .extend({
    checkId: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const defineChecksSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  checks: z.array(checkUpdateSchema).min(1).max(100),
});

/** V3 generation does not see the execution contract's DOM schema. */
export const defineBusinessChecksSchema = defineChecksSchema.extend({
  checks: z
    .array(
      checkUpdateSchema.omit({ observationContract: true }).extend({
        description: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .describe(
            "一句业务结果，尽量 80 字以内；对象和预期另填，不复述操作。",
          ),
      }),
    )
    .min(1)
    .max(100),
});

type Check = z.infer<typeof specCheckSchema>;
type CatalogIssue = SpecCheckIssue & { inputIndex?: number; checkId?: string };

// Union errors otherwise hide the actionable field (for example a missing EQ
// operator). Return the closest branch's leaf errors without weakening parsing.
function actionableIssues(
  issues: readonly z.core.$ZodIssue[],
): z.core.$ZodIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code !== "invalid_union") return [issue];
    const branches = issue.errors.map(actionableIssues);
    const closest = branches.reduce((best, branch) =>
      branch.length < best.length ? branch : best,
    );
    return closest.map((child) => ({
      ...child,
      path: [...issue.path, ...child.path],
    }));
  });
}

/** Attempt-local state. Failed items never replace previously accepted checks. */
export class SpecCheckCatalog {
  constructor(private readonly businessChecksEnabled = true) {}
  private readonly checks = new Map<string, Check>();
  revision = 0;

  get ids() {
    return [...this.checks.keys()];
  }

  define(
    raw: unknown,
    requirements: readonly SpecRequirement[],
    sourceContents: ReadonlyMap<string, string>,
  ) {
    const batch = defineChecksSchema
      .extend({ checks: z.array(z.unknown()).min(1).max(100) })
      .parse(raw);
    if (batch.expectedRevision !== this.revision)
      throw new Error(
        `验收标准表版本已变化：expectedRevision 必须为 ${this.revision}；请仅修正失败条目。`,
      );
    const byId = new Map(requirements.map((item) => [item.id, item]));
    const accepted: Array<{
      inputIndex: number;
      checkId: string;
      requirementId: string;
    }> = [];
    const issues: CatalogIssue[] = [];
    const updated = new Set<string>();
    let changed = false;
    batch.checks.forEach((item, inputIndex) => {
      const parsed = checkUpdateSchema.safeParse(item);
      if (!parsed.success) {
        issues.push(
          ...actionableIssues(parsed.error.issues)
            .slice(0, 30)
            .map((issue) => ({
              inputIndex,
              code: "INVALID_CHECK",
              path: issue.path.join("."),
              message: issue.message,
            })),
        );
        return;
      }
      const { checkId, ...check } = parsed.data;
      const fail = (code: string, path: string, message: string) =>
        issues.push({
          inputIndex,
          ...(checkId ? { checkId } : {}),
          requirementId: check.requirementId,
          code,
          path,
          message,
        });
      if (checkId && (!this.checks.has(checkId) || updated.has(checkId))) {
        fail(
          "INVALID_CHECK_ID",
          "checkId",
          "checkId 必须来自已保存的标准表，且同一批次不能重复修改。",
        );
        return;
      }
      if (
        !this.businessChecksEnabled &&
        (check.businessCheck || check.observationContract?.version === 3)
      ) {
        fail(
          "CONTRACT_UNSUPPORTED",
          "businessCheck",
          "当前控制面未启用业务验收格式，请使用本任务协商的格式。",
        );
        return;
      }
      const requirement = byId.get(check.requirementId);
      if (!requirement) {
        fail(
          "UNKNOWN_REQUIREMENT",
          "requirementId",
          "请使用 define_requirements 返回的需求编号。",
        );
        return;
      }
      if (
        checkId &&
        this.checks.get(checkId)!.requirementId !== check.requirementId
      ) {
        fail(
          "REQUIREMENT_CHANGED",
          "requirementId",
          "已保存标准的需求映射不可更换；不同需求请定义新标准。",
        );
        return;
      }
      if (
        checkId &&
        (this.checks.get(checkId)!.observationContract ||
          this.checks.get(checkId)!.businessCheck) &&
        !check.observationContract &&
        !check.businessCheck
      ) {
        fail(
          "CONTRACT_DOWNGRADE",
          "observationContract",
          "已保存的对象状态契约不能退回文字目标；请修正原 observationContract。",
        );
        return;
      }
      if (
        check.businessCheck &&
        (check.observationContract || check.observationTargets)
      ) {
        fail(
          "CONFLICTING_CHECK_FORMAT",
          "businessCheck",
          "业务验收不能同时声明旧版观察目标或契约。",
        );
        return;
      }
      const errors = specCriterionIssues(
        expandSpecCheck(check, requirement, checkId ?? `input-${inputIndex}`),
        sourceContents,
      );
      if (errors.length) {
        issues.push(
          ...errors.map((issue) => ({
            ...issue,
            inputIndex,
            ...(checkId ? { checkId } : {}),
          })),
        );
        return;
      }
      // Identical retries reuse their IDs instead of growing the catalog.
      const serialized = JSON.stringify(check);
      const existingId =
        checkId ??
        [...this.checks].find(
          ([, value]) => JSON.stringify(value) === serialized,
        )?.[0];
      if (!existingId && this.checks.size >= 500) {
        fail("CHECK_LIMIT", "checks", "验收标准表最多保存 500 项。");
        return;
      }
      const id = existingId ?? `check-${this.checks.size + 1}`;
      if (JSON.stringify(this.checks.get(id)) !== serialized) {
        this.checks.set(id, check);
        changed = true;
      }
      updated.add(id);
      accepted.push({
        inputIndex,
        checkId: id,
        requirementId: check.requirementId,
      });
    });
    if (changed) this.revision += 1;
    return {
      accepted: issues.length === 0,
      revision: this.revision,
      saved: accepted,
      issues,
      catalog: [...this.checks].map(([checkId, check]) => ({
        checkId,
        requirementId: check.requirementId,
        description: check.description,
      })),
      nextAction:
        "已保存项保留。仅重提交失败项；修改已保存项时携带 checkId 和当前 expectedRevision。最终 Case 通过 checkIds 引用。",
    };
  }

  expand(raw: unknown, requirements: readonly SpecRequirement[]) {
    const spec = referencedSpecSchema.parse(raw);
    const expanded = normalizeCompactSpec(
      {
        ...spec,
        cases: spec.cases.map(({ checkIds, ...testCase }) => {
          if (new Set(checkIds).size !== checkIds.length)
            throw new Error(`用例「${testCase.name}」重复引用 checkId。`);
          return {
            ...testCase,
            accountRequirements: testCase.accountRequirements?.map(
              (requirement) => ({
                ...requirement,
                ...(requirement.subjectBinding
                  ? {
                      subjectBinding: {
                        ...requirement.subjectBinding,
                        criterionIds:
                          requirement.subjectBinding.criterionIds?.map((id) => {
                            const index = checkIds.indexOf(id);
                            if (index < 0)
                              throw new Error(
                                `账号用途引用的 checkId 不属于当前用例：${id}`,
                              );
                            return String(index + 1);
                          }),
                      },
                    }
                  : {}),
              }),
            ),
            criteria: checkIds.map((id) => {
              const check = this.checks.get(id);
              if (!check)
                throw new Error(
                  `未知或未通过校验的 checkId：${id}。请先调用 define_checks。`,
                );
              return check;
            }),
          };
        }),
      },
      requirements,
    );
    // Preserve the registry identity in execution diagnostics without sharing mutable objects.
    expanded.cases.forEach((testCase, caseIndex) => {
      const ids = new Map(
        testCase.criteria.map((criterion, index) => [
          criterion.id,
          `case-${caseIndex + 1}-${spec.cases[caseIndex]!.checkIds[index]}`,
        ]),
      );
      for (const requirement of testCase.accountRequirements ?? []) {
        if (requirement.subjectBinding?.criterionIds)
          requirement.subjectBinding.criterionIds =
            requirement.subjectBinding.criterionIds.map((id) => ids.get(id)!);
      }
      testCase.criteria.forEach((criterion, index) => {
        criterion.id = `case-${caseIndex + 1}-${spec.cases[caseIndex]!.checkIds[index]}`;
      });
    });
    return expanded;
  }
}
