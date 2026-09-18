import { expect, it } from "vitest";
import {
  resolveAccountReplacement,
  accountReplacementState,
} from "./account-replacement.js";
const binding = {
  slotId: "subject:1",
  label: "目标账号",
  account: "old-user",
  aliases: ["old-alias"],
  usage: "CREATE_OR_MODIFY",
  requiredTypes: ["MAPPING"],
};
const policy = {
  testAccounts: [binding],
  executionState: {
    accounts: [binding],
    preflightAbsences: ["old"],
    writes: [
      {
        key: "w",
        method: "POST",
        url: "https://app.test/items",
        status: 200,
        confirmed: true,
        evidenceRefs: ["e"],
      },
    ],
    records: [
      {
        id: "1",
        account: "old-user",
        ownership: "CREATED_THIS_RUN",
        evidenceRefs: ["e"],
        cleanup: { status: "PENDING", instruction: "删除本轮创建" },
      },
    ],
  },
};
it("normalizes the actual single-role free-text replacement without carrying aliases or erasing cleanup debt", () => {
  const account = "025d306c-0748-448a-94f0-fc18dc8008da";
  const resolution = resolveAccountReplacement(
    { instructions: `换另一个账号吧 ${account}` },
    policy,
    {},
  )!;
  expect(resolution.accounts).toEqual([{ ...binding, account, aliases: [] }]);
  const state = accountReplacementState(policy, resolution.accounts);
  expect(state).toMatchObject({
    accountRevision: 1,
    preflightAbsences: [],
    records: [
      expect.objectContaining({
        account: "old-user",
        cleanup: expect.objectContaining({ status: "PENDING" }),
      }),
    ],
    writes: policy.executionState.writes,
  });
  expect(policy.testAccounts[0]!.account).toBe("old-user");
});
it("requires a role for ambiguous replacements and changes only the selected role", () => {
  const multi = {
    ...policy,
    testAccounts: [
      binding,
      { ...binding, slotId: "other:1", account: "other-user" },
    ],
  };
  expect(() =>
    resolveAccountReplacement(
      { instructions: "换另一个账号吧 qa@example.test" },
      multi,
      {},
    ),
  ).toThrow("多个账号角色");
  expect(
    resolveAccountReplacement(
      {
        resolution: {
          kind: "REPLACE_ACCOUNT",
          slotId: "other:1",
          account: "new-user",
        },
      },
      multi,
      {},
    )?.accounts,
  ).toEqual([
    binding,
    { ...multi.testAccounts[1], account: "new-user", aliases: [] },
  ]);
});
it.each(["继续执行", "可以先删除开展后续测试", "不要换账号 qa@example.test"])(
  "does not infer an account change from %s",
  (instructions) => {
    expect(
      resolveAccountReplacement({ instructions }, policy, {}),
    ).toBeUndefined();
  },
);
