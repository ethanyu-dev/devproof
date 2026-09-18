import {
  testAccountSlots,
  isLoginOnlyAccountRequirement,
  type TestAccountRequirement,
} from "@devproof/agent-runtime-protocol";

/** Only case-local execution instructions belong in the browser task goal. */
export function caseExecutionGoal(testCase: {
  name: string;
  preconditions: readonly string[];
  testData?: readonly string[];
  steps: ReadonlyArray<{ order: number; action: string }>;
  cleanup?: readonly string[];
  accountRequirementsVersion?: number | undefined;
  accountRequirements?: readonly TestAccountRequirement[] | undefined;
}) {
  const requirements =
    testCase.accountRequirementsVersion === 2
      ? (testCase.accountRequirements ?? [])
      : (testCase.accountRequirements ?? []).filter(
          (item) => !isLoginOnlyAccountRequirement(item),
        );
  const section = (label: string, values: readonly string[] = []) =>
    values.length
      ? [`${label}：`, ...[...new Set(values)].map((value) => `- ${value}`)]
      : [];
  return [
    testCase.name,
    ...section("前置条件", testCase.preconditions),
    ...section("测试数据", testCase.testData),
    ...section(
      "账号角色与执行前检查",
      testAccountSlots(requirements).map(
        (slot) =>
          `${slot.slotId}（${slot.label}）：${slot.usage === "READ_EXISTING" ? "只读" : "创建或修改"}；类型：${slot.requiredTypes.join("、") || "按场景核对"}${slot.constraints.length ? `；${[...new Set(slot.constraints)].join("；")}` : ""}。`,
      ),
    ),
    ...(requirements.length
      ? [
          "先只读核对全部角色的前置条件，再开始业务写入。既有记录导致前置冲突时，触发 DATA_PRECONDITION 人工接管，用户可处理浏览器或明确授权处置指定记录后继续；无法处置时记录受影响项 INCONCLUSIVE，不再次索取替换账号。",
        ]
      : []),
    "操作步骤：",
    ...testCase.steps.map((step) => `${step.order}. ${step.action}`),
    ...section("清理", testCase.cleanup),
  ].join("\n");
}
