import { ConflictException } from "@nestjs/common";
import {
  caseAccountRequirements,
  testAccountPlanSchema,
  type TestAccountPlan,
} from "@devproof/agent-runtime-protocol";
import { specificationDefinitionHash } from "@devproof/test-domain";

export function readAccountPlan(value: unknown): TestAccountPlan | null {
  if (value == null) return null;
  const parsed = testAccountPlanSchema.safeParse(value);
  if (!parsed.success)
    throw new ConflictException("测试账号计划无效，不能回退到原始账号需求。");
  return parsed.data;
}

/** The original Spec is immutable. All consumers use this effective definition. */
export function resolveCaseExecutionDefinition(
  definition: unknown,
  value: unknown,
) {
  const original = definition as Record<string, unknown>;
  const plan = readAccountPlan(value);
  if (!plan) return original;
  if (plan.version === 2) {
    if (plan.definitionHash !== specificationDefinitionHash(definition))
      throw new ConflictException(
        "测试账号计划与用例定义不一致，请重新核对需求。",
      );
    const requirements = caseAccountRequirements(definition);
    const removed = new Set(plan.resolution.removedRoles);
    if (
      (plan.resolution.kind === "DECLARED" && removed.size) ||
      [...removed].some((role) => !requirements.some((r) => r.role === role)) ||
      specificationDefinitionHash(
        requirements.filter((r) => !removed.has(r.role)),
      ) !== specificationDefinitionHash(plan.requirements)
    )
      throw new ConflictException(
        "测试账号计划不能修改角色用途或未声明的需求。",
      );
  }
  return {
    ...original,
    accountRequirements: plan.requirements,
    ...(plan.version === 2 ? { authRole: plan.effectiveAuthRole } : {}),
  };
}
