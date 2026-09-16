import {
  isLoginOnlyAccountRequirement,
  type TestAccountRequirement,
} from "./test-accounts.js";

export interface AccountRequirementCase {
  name: string;
  accountRequirementsVersion?: number | undefined;
  accountRequirements?: readonly TestAccountRequirement[] | undefined;
  steps: readonly { order: number }[];
  criteria: readonly { id: string }[];
}
export interface AccountRequirementIssue {
  caseName: string;
  role?: string;
  path: string;
  code: string;
  message: string;
}

/** Structural and provenance checks. A real quote alone is not semantic proof. */
export function validateCaseAccountRequirements(
  cases: readonly AccountRequirementCase[],
  options: {
    requireVersion?: boolean;
    sourceContents?: ReadonlyMap<string, string>;
  } = {},
): AccountRequirementIssue[] {
  const issues: AccountRequirementIssue[] = [];
  cases.forEach((testCase, index) => {
    const fail = (code: string, path: string, message: string, role?: string) =>
      issues.push({
        caseName: testCase.name,
        ...(role ? { role } : {}),
        path: `cases.${index}.${path}`,
        code,
        message,
      });
    if (
      options.requireVersion &&
      (testCase.accountRequirementsVersion !== 2 ||
        !testCase.accountRequirements)
    ) {
      fail(
        "ACCOUNT_REQUIREMENTS_VERSION_REQUIRED",
        "accountRequirements",
        "新用例必须填写 accountRequirementsVersion: 2 和 accountRequirements；没有被测业务账号时填 []，操作身份放入 authRole。",
      );
      return;
    }
    for (const [i, requirement] of (
      testCase.accountRequirements ?? []
    ).entries()) {
      const path = `accountRequirements.${i}`;
      if (isLoginOnlyAccountRequirement(requirement)) {
        fail(
          "EXECUTOR_IDENTITY_NOT_SUBJECT",
          path,
          "后台操作身份应填 authRole，不能声明为业务测试账号。",
          requirement.role,
        );
        continue;
      }
      const binding = requirement.subjectBinding;
      if (!binding) {
        if (testCase.accountRequirementsVersion === 2 || options.requireVersion)
          fail(
            "ACCOUNT_SUBJECT_BINDING_REQUIRED",
            path,
            "账号需求必须说明实际使用的业务字段或被测账号、步骤和来源；仅有新增、编辑、导出权限不构成业务账号需求。",
            requirement.role,
          );
        continue;
      }
      if (
        binding.stepOrders.some(
          (order) => !testCase.steps.some((step) => step.order === order),
        )
      )
        fail(
          "ACCOUNT_SUBJECT_STEP_UNKNOWN",
          `${path}.subjectBinding.stepOrders`,
          "账号用途必须引用当前用例的实际步骤。",
          requirement.role,
        );
      if (
        (binding.kind === "AUTH_SUBJECT" && !binding.criterionIds?.length) ||
        binding.criterionIds?.some(
          (id) => !testCase.criteria.some((criterion) => criterion.id === id),
        )
      )
        fail(
          "ACCOUNT_SUBJECT_CRITERION_UNKNOWN",
          `${path}.subjectBinding.criterionIds`,
          "被测登录或权限账号必须关联当前用例的验收标准。",
          requirement.role,
        );
      if (
        /^(?:执行人|操作账号|后台操作身份|后台登录账号|登录身份|operator|executor)$/iu.test(
          binding.target,
        )
      )
        fail(
          "EXECUTOR_IDENTITY_NOT_SUBJECT",
          `${path}.subjectBinding.target`,
          "请指明被测业务对象；执行操作所需身份放入 authRole。",
          requirement.role,
        );
      if (
        options.sourceContents &&
        !options.sourceContents
          .get(binding.basis.sourceRef)
          ?.includes(binding.basis.quote)
      )
        fail(
          "ACCOUNT_SUBJECT_SOURCE_INVALID",
          `${path}.subjectBinding.basis`,
          "账号用途必须引用本次分析已读取来源的准确原文。",
          requirement.role,
        );
    }
  });
  return issues;
}

export function accountRequirementIssuesMessage(
  issues: readonly AccountRequirementIssue[],
) {
  return issues.length
    ? issues
        .map(
          (issue) =>
            `${issue.code} ${issue.path}「${issue.caseName}」${issue.role ? ` ${issue.role}` : ""}：${issue.message}`,
        )
        .join("\n")
    : null;
}
