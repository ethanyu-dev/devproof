import { describe, expect, it } from "vitest";
import { caseExecutionGoal } from "./task-case-context.js";

describe("case execution goal", () => {
  it("keeps case prerequisites, data and cleanup while excluding analysis and duplicate checks", () => {
    const generated = {
      name: "白名单类型选项核对（只读）",
      preconditions: ["已登录，具备白名单页面读取权限。"],
      testData: ["使用已有 ZDR 记录，只读。"],
      steps: [
        {
          order: 1,
          action: "展开白名单类型下拉。",
          expectedObservation: "记录实际结果，并按验收标准进行判定。",
        },
      ],
      cleanup: ["关闭弹窗，不提交表单。"],
      criteria: [{ description: "合规模型映射选项存在。" }],
      assumptions: ["其他写入用例需要四个账号。"],
      risks: ["PR checks 返回 403。"],
      rationale: "src/views/whitelist-config/index.tsx",
      sourceRefs: ["analysis-source://source"],
    };
    const goal = caseExecutionGoal(generated);
    for (const required of [
      generated.name,
      ...generated.preconditions,
      ...generated.testData,
      generated.steps[0]!.action,
      ...generated.cleanup,
    ])
      expect(goal).toContain(required);
    for (const excluded of [
      generated.steps[0]!.expectedObservation,
      generated.criteria[0]!.description,
      ...generated.assumptions,
      ...generated.risks,
      generated.rationale,
      ...generated.sourceRefs,
    ])
      expect(goal).not.toContain(excluded);
  });

  it("supports old cases without test data or cleanup", () => {
    const goal = caseExecutionGoal({
      name: "旧用例",
      preconditions: ["已登录"],
      steps: [{ order: 1, action: "查看页面" }],
    });
    expect(goal).toContain("查看页面");
    expect(goal).not.toMatch(/undefined|测试数据|清理/u);
  });
  it("delivers structured account constraints to the executor even without prose test data", () => {
    const goal = caseExecutionGoal({
      name: "创建白名单",
      preconditions: [],
      steps: [],
      accountRequirements: [
        {
          role: "subject",
          label: "无白名单记录的账号",
          count: 1,
          usage: "CREATE_OR_MODIFY",
          requiredTypes: ["MODEL_NAME_MAPPING_WHITELIST"],
          constraints: ["账号已存在，且该类型记录不存在"],
          rationale: "同一账号验证两次状态切换",
        },
      ],
    });
    expect(goal).toContain("subject:1");
    expect(goal).toContain("MODEL_NAME_MAPPING_WHITELIST");
    expect(goal).toContain("账号已存在，且该类型记录不存在");
    expect(goal).toContain("先只读核对全部角色");
  });
});

it("writes shared account rules once and excludes login identities and repeated rationale", () => {
  const role = {
    role: "subject",
    label: "业务对象",
    count: 2,
    usage: "CREATE_OR_MODIFY" as const,
    requiredTypes: ["MODEL"],
    constraints: ["该类型记录不存在", "该类型记录不存在"],
    rationale: "两个独立对象用于对照",
  };
  const goal = caseExecutionGoal({
    name: "生命周期",
    preconditions: [],
    steps: [{ order: 1, action: "新增并编辑" }],
    accountRequirements: [
      role,
      { ...role, role: "admin", label: "后台账号（登录用）" },
    ],
  });
  expect(goal.match(/先只读核对全部角色/g)).toHaveLength(1);
  expect(goal).toContain("subject:2");
  expect(goal).not.toContain("admin:1");
  expect(goal).not.toContain(role.rationale);
});
