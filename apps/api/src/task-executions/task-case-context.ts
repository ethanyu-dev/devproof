/** Only case-local execution instructions belong in the browser task goal. */
export function caseExecutionGoal(testCase: {
  name: string;
  preconditions: readonly string[];
  testData?: readonly string[];
  steps: ReadonlyArray<{ order: number; action: string }>;
  cleanup?: readonly string[];
}) {
  const section = (label: string, values: readonly string[] = []) =>
    values.length ? [`${label}：`, ...values.map((value) => `- ${value}`)] : [];
  return [
    testCase.name,
    ...section("前置条件", testCase.preconditions),
    ...section("测试数据", testCase.testData),
    "操作步骤：",
    ...testCase.steps.map((step) => `${step.order}. ${step.action}`),
    ...section("清理", testCase.cleanup),
  ].join("\n");
}
