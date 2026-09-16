import { describe, expect, it } from "vitest";
import { validateCaseAccountRequirements } from "./account-requirement-validation.js";
import {
  testAccountRequirementsSchema,
  caseAccountRequirements,
} from "./test-accounts.js";
import {
  resolveBusinessAccountRequest,
  accountRequestKindError,
} from "./account-request.js";

const sourceRef = "analysis-source://attempt/model";
const sourceContents = new Map([
  [sourceRef, "白名单用户字段 userId；验证账号登录后是否有访问权限。"],
]);
const requirements = (extra = {}) =>
  testAccountRequirementsSchema.parse([
    {
      role: "subject",
      label: "白名单用户",
      count: 1,
      usage: "CREATE_OR_MODIFY",
      rationale: "验证用户白名单",
      subjectBinding: {
        kind: "BUSINESS_INPUT",
        target: "userId",
        stepOrders: [1],
        basis: { sourceRef, quote: "白名单用户字段 userId" },
      },
      ...extra,
    },
  ]);
const testCase = (accountRequirements = requirements()) => ({
  name: "业务验证",
  accountRequirementsVersion: 2,
  accountRequirements,
  steps: [{ order: 1 }],
  criteria: [{ id: "check-1" }],
});
const validate = (value = testCase()) =>
  validateCaseAccountRequirements([value], {
    requireVersion: true,
    sourceContents,
  });

describe("business account declarations", () => {
  it.each([
    "LLM 产品新增与列表查看账号",
    "LLM 产品新增、编辑与列表查看账号",
    "LLM 产品清空下架时间编辑账号",
    "LLM 产品新增、编辑、克隆与列表查看账号",
    "LLM 产品列表查看与导出账号",
  ])("rejects the PROD-6754 operator declaration: %s", (label) => {
    const legacy = testAccountRequirementsSchema.parse([
      {
        role: "editor",
        label,
        usage: "READ_EXISTING",
        rationale: "1 个具备编辑或导出权限的账号即可。",
      },
    ]);
    expect(validate(testCase(legacy)).map((i) => i.code)).toContain(
      "ACCOUNT_SUBJECT_BINDING_REQUIRED",
    );
  });
  it("accepts ordinary resource creation without a business account", () =>
    expect(validate(testCase([]))).toEqual([]));
  it("requires explicit declarations only on new generation", () => {
    const {
      accountRequirementsVersion: _,
      accountRequirements: __,
      ...old
    } = testCase();
    expect(
      validateCaseAccountRequirements([old], { requireVersion: true })[0]?.code,
    ).toBe("ACCOUNT_REQUIREMENTS_VERSION_REQUIRED");
    expect(validateCaseAccountRequirements([old])).toEqual([]);
  });
  it("preserves account inputs and read-only account records", () => {
    expect(validate()).toEqual([]);
    const account = requirements({ usage: "READ_EXISTING" });
    account[0]!.subjectBinding!.kind = "BUSINESS_RECORD";
    expect(validate(testCase(account))).toEqual([]);
  });
  it("keeps authentication subjects, but requires a real criterion", () => {
    const account = requirements({ label: "登录用账号" });
    account[0]!.subjectBinding!.kind = "AUTH_SUBJECT";
    expect(validate(testCase(account))[0]?.code).toBe(
      "ACCOUNT_SUBJECT_CRITERION_UNKNOWN",
    );
    account[0]!.subjectBinding!.criterionIds = ["check-1"];
    expect(validate(testCase(account))).toEqual([]);
    expect(caseAccountRequirements(testCase(account))).toEqual(account);
  });
  it.each(["step", "source", "quote", "operator"])(
    "rejects invalid %s binding",
    (kind) => {
      const account = requirements();
      const binding = account[0]!.subjectBinding!;
      if (kind === "step") binding.stepOrders = [2];
      if (kind === "source")
        binding.basis.sourceRef = "analysis-source://another/attempt";
      if (kind === "quote") binding.basis.quote = "虚构字段";
      if (kind === "operator") binding.target = "操作账号";
      expect(validate(testCase(account))).toHaveLength(1);
    },
  );
});

describe("execution account requests", () => {
  const policy = {
    accountRequirements: { version: 2, requirements: requirements() },
  };
  const request = {
    mode: "DISCOVERED",
    subjectKind: "BUSINESS_INPUT",
    target: "用户ID",
    criterionId: "check-1",
    usage: "CREATE_OR_MODIFY",
    observation: {
      observationId: "b80dabfb-f968-4e6d-bc49-6480c956ea45",
      cursor: 0,
      quote: "[ref=e1] 用户ID",
      evidenceRefs: ["artifact://dom"],
    },
  };
  const evidence = new Map([
    ["artifact://dom", { kind: "DOM", content: request.observation.quote }],
  ]);
  it("uses declared slot permissions instead of caller-controlled response fields", () => {
    const result = resolveBusinessAccountRequest(
      policy,
      { mode: "DECLARED", slotIds: ["subject:1"] },
      ["check-1"],
      new Map(),
    );
    expect(result.slots[0]).toMatchObject({
      slotId: "subject:1",
      usage: "CREATE_OR_MODIFY",
    });
  });
  it("does not invent a declared slot for zero-account cases", () => {
    expect(() =>
      resolveBusinessAccountRequest(
        { accountRequirements: { version: 2, requirements: [] } },
        { mode: "DECLARED", slotIds: ["editor:1"] },
        [],
        new Map(),
      ),
    ).toThrow("声明");
  });
  it("allows discovered inputs only with the actual observation and current criterion", () => {
    expect(
      resolveBusinessAccountRequest(policy, request, ["check-1"], evidence)
        .slots[0]?.label,
    ).toBe("用户ID");
    expect(() =>
      resolveBusinessAccountRequest(policy, request, [], evidence),
    ).toThrow("验收");
    expect(() =>
      resolveBusinessAccountRequest(policy, request, ["check-1"], new Map()),
    ).toThrow("真实");
    expect(() =>
      resolveBusinessAccountRequest(
        policy,
        {
          ...request,
          observation: { ...request.observation, quote: "虚构用户ID" },
        },
        ["check-1"],
        evidence,
      ),
    ).toThrow("真实");
  });
  it("rejects replacements and alternative HITL forms", () => {
    expect(() =>
      resolveBusinessAccountRequest(
        {
          ...policy,
          testAccounts: [
            {
              slotId: "subject:1",
              account: "user-1",
              usage: "CREATE_OR_MODIFY",
            },
          ],
        },
        request,
        ["check-1"],
        evidence,
      ),
    ).toThrow("已提供");
    expect(
      accountRequestKindError(
        "BROWSER_HITL",
        {},
        { properties: { account: { type: "string" } } },
      ),
    ).toBeTruthy();
    expect(
      accountRequestKindError(
        "BROWSER_HITL",
        {},
        { properties: { instructions: { type: "string" } } },
      ),
    ).toBeNull();
  });
});
