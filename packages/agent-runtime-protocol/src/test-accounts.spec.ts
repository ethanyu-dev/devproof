import { describe, expect, it } from "vitest";
import {
  accountInputResponseSchema,
  businessAccountRequirementsError,
  accountInputSlots,
  caseAccountRequirements,
  testAccountRequirementsSchema,
  testAccountSlots,
} from "./test-accounts.js";

describe("test account requirements", () => {
  it("does not multiply accounts by acceptance checks or resource types", () => {
    const requirements = testAccountRequirementsSchema.parse([
      {
        role: "subject",
        label: "生命周期",
        count: 1,
        usage: "CREATE_OR_MODIFY",
        requiredTypes: ["MODEL", "LEGACY"],
        rationale: "同账号的不同类型互不冲突",
      },
    ]);
    expect(testAccountSlots(requirements)).toHaveLength(1);
  });
  it("keeps zero-account read-only cases explicit", () => {
    expect(
      caseAccountRequirements({
        accountRequirements: [],
        name: "查看测试账号",
      }),
    ).toEqual([]);
  });
  it("migrates A/B as two roles without inventing account values", () => {
    const slots = testAccountSlots(
      caseAccountRequirements({
        testData: ["账号A 用于新增模型，账号B 用于旧版转账"],
      }),
    );
    expect(slots).toHaveLength(2);
    expect(slots.every((s) => !("account" in s))).toBe(true);
  });
  it("rejects duplicate roles", () => {
    const r = {
      role: "subject",
      label: "对象",
      usage: "READ_EXISTING",
      rationale: "查看",
    };
    expect(testAccountRequirementsSchema.safeParse([r, r]).success).toBe(false);
  });
  it("preserves every legacy multi-account input instead of forcing one account", () => {
    const slots = accountInputSlots(
      {},
      {
        required: ["accountA", "accountB"],
        properties: {
          accountA: { description: "模型映射账号" },
          accountB: { description: "转账账号" },
        },
      },
      {},
    );
    expect(slots.map((s) => s.slotId)).toEqual(["accountA", "accountB"]);
    expect(accountInputResponseSchema(slots).required).toEqual(["accounts"]);
  });
  it("replaces only the requested role and preserves its usage", () => {
    const slots = accountInputSlots(
      {
        testAccounts: [
          { slotId: "model:1", account: "user-a", usage: "CREATE_OR_MODIFY" },
          { slotId: "reader:1", account: "user-b", usage: "READ_EXISTING" },
        ],
      },
      {},
      { slotIds: ["reader:1"], usage: "CREATE_OR_MODIFY" },
    );
    expect(slots).toMatchObject([
      { slotId: "reader:1", usage: "READ_EXISTING" },
    ]);
    expect(() =>
      accountInputSlots(
        {
          testAccounts: [
            { slotId: "reader:1", account: "user-b", usage: "READ_EXISTING" },
          ],
        },
        {},
        { slotIds: ["invented"] },
      ),
    ).toThrow();
  });
});

it("rejects executor login roles at generation and excludes them when replaying historical specs", () => {
  const requirements = testAccountRequirementsSchema.parse([
    {
      role: "ops_admin",
      label: "白名单配置后台管理员账号（登录用）",
      usage: "READ_EXISTING",
      rationale: "登录后台",
    },
    {
      role: "subject",
      label: "被配置白名单的业务账号",
      usage: "CREATE_OR_MODIFY",
      rationale: "验证新增和编辑",
    },
  ]);
  expect(
    businessAccountRequirementsError([
      { name: "只读页面", accountRequirements: requirements },
    ]),
  ).toContain("authRole");
  expect(
    caseAccountRequirements({ accountRequirements: requirements }).map(
      (x) => x.role,
    ),
  ).toEqual(["subject"]);
});
it("preserves actual business subjects used to verify login permissions", () => {
  const requirements = testAccountRequirementsSchema.parse([
    {
      role: "admin",
      label: "管理员权限测试对象",
      usage: "READ_EXISTING",
      rationale: "核对该业务账号能否登录被测产品",
    },
  ]);
  expect(
    businessAccountRequirementsError([
      { name: "账号权限", accountRequirements: requirements },
    ]),
  ).toBeNull();
  expect(
    caseAccountRequirements({ accountRequirements: requirements }),
  ).toEqual(requirements);
});
