import { describe, expect, it } from "vitest";
import { specificationDefinitionHash } from "@devproof/test-domain";
import {
  testAccountRequirementsSchema,
  testAccountPlanSchema,
} from "@devproof/agent-runtime-protocol";
import {
  resolveCaseExecutionDefinition,
  readAccountPlan,
} from "./case-account-definition.js";
import { caseExecutionGoal } from "./task-case-context.js";

const definition = {
  name: "新增模型",
  authRole: "default",
  preconditions: [],
  steps: [{ order: 1, action: "创建模型" }],
  accountRequirements: testAccountRequirementsSchema.parse([
    {
      role: "editor",
      label: "产品编辑账号",
      usage: "CREATE_OR_MODIFY",
      rationale: "需要编辑权限",
    },
  ]),
};
const plan = () =>
  testAccountPlanSchema.parse({
    version: 2,
    definitionHash: specificationDefinitionHash(definition),
    revision: "b80dabfb-f968-4e6d-bc49-6480c956ea45",
    requirements: [],
    bindings: [],
    requestedAt: new Date().toISOString(),
    effectiveAuthRole: "模型编辑员",
    resolution: {
      kind: "REVIEWED_CORRECTION",
      removedRoles: ["editor"],
      reason: "操作身份误分类",
    },
  });

describe("effective account definition", () => {
  it("uses the correction for execution without mutating the original Spec", () => {
    const effective = resolveCaseExecutionDefinition(definition, plan());
    expect(effective).toMatchObject({
      authRole: "模型编辑员",
      accountRequirements: [],
    });
    expect(caseExecutionGoal(effective as typeof definition)).not.toContain(
      "账号角色",
    );
    expect(definition.accountRequirements).toHaveLength(1);
  });
  it("rejects stale definitions, unauthorized requirement changes, and corrupt plans", () => {
    expect(() =>
      resolveCaseExecutionDefinition(
        { ...definition, name: "另一个用例" },
        plan(),
      ),
    ).toThrow("不一致");
    const invalid = plan();
    if (invalid.version === 2) invalid.resolution.removedRoles = [];
    expect(() => resolveCaseExecutionDefinition(definition, invalid)).toThrow(
      "不能修改",
    );
    expect(() => readAccountPlan({ version: 2 })).toThrow("不能回退");
  });
});
