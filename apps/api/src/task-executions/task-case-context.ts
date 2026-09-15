import {
  testAccountSlots,
  type TestAccountRequirement,
} from "@devproof/agent-runtime-protocol";

/** Only case-local execution instructions belong in the browser task goal. */
export function caseExecutionGoal(testCase: {
  name: string;
  preconditions: readonly string[];
  testData?: readonly string[];
  steps: ReadonlyArray<{ order: number; action: string }>;
  cleanup?: readonly string[];
  accountRequirements?: readonly TestAccountRequirement[] | undefined;
}) {
  const section = (label: string, values: readonly string[] = []) =>
    values.length ? [`${label}：`, ...values.map((value) => `- ${value}`)] : [];
  return [
    testCase.name,
    ...section("前置条件", testCase.preconditions),
    ...section("测试数据", testCase.testData),
    ...section(
      "账号角色与执行前检查",
      testAccountSlots(testCase.accountRequirements ?? []).map(
        (slot) =>
          `${slot.slotId}（${slot.label}）：${slot.usage === "READ_EXISTING" ? "只读" : "创建或修改"}；业务类型：${slot.requiredTypes.join("、") || "按场景核对"}；约束：${slot.constraints.join("；")}。${slot.rationale}。先只读核对全部角色的前置条件，再开始业务写入。用户已提供但账号不可用或不满足前置条件时，将受影响项记录为 INCONCLUSIVE（无法判定）并说明原因，不再次索取替换账号。`,
      ),
    ),
    "操作步骤：",
    ...testCase.steps.map((step) => `${step.order}. ${step.action}`),
    ...section("清理", testCase.cleanup),
  ].join("\n");
}
