import { BadRequestException } from "@nestjs/common";
import {
  businessTestAccountSchema,
  testAccountBindingsSchema,
  readExecutionState,
} from "@devproof/agent-runtime-protocol";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
function accountValue(value: unknown) {
  const parsed = businessTestAccountSchema.safeParse(value);
  if (!parsed.success)
    throw new BadRequestException("请提供有效的 UUID、邮箱、手机号或用户 ID。");
  return parsed.data;
}
/** Normalize an explicit human replacement; never infer deletion permission. */
export function resolveAccountReplacement(
  response: Record<string, unknown>,
  policy: Record<string, unknown>,
  context: unknown,
) {
  const previous = testAccountBindingsSchema.parse(policy.testAccounts ?? []);
  const resolution = object(response.resolution);
  const instructions =
    typeof response.instructions === "string"
      ? response.instructions.trim()
      : "";
  let account: string | undefined;
  if (resolution.kind === "REPLACE_ACCOUNT")
    account = accountValue(resolution.account);
  else if (
    /换(?:一个|另一个|个|号|账号)|更换.{0,8}账号|替换.{0,8}账号|replace.{0,12}account/iu.test(
      instructions,
    ) &&
    !/不(?:要|用|必|需).*换|不要替换/iu.test(instructions)
  ) {
    const values = [
      ...new Set(
        instructions.match(
          /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b1\d{10}\b/giu,
        ) ?? [],
      ),
    ];
    if (values.length !== 1)
      throw new BadRequestException(
        "更换账号需要一个明确的账号标识；可使用 resolution: {kind: REPLACE_ACCOUNT, slotId, account} 指定角色。",
      );
    account = accountValue(values[0]);
  } else return undefined;
  const requestedSlot = resolution.slotId ?? object(context).slotId;
  if (!previous.length) {
    if (requestedSlot !== undefined)
      throw new BadRequestException("账号角色不存在。");
    return {
      response: {
        ...response,
        account,
        resolution: { kind: "REPLACE_ACCOUNT", account },
      },
      account,
      accounts: undefined,
    };
  }
  const slot = requestedSlot
    ? previous.find((b) => b.slotId === requestedSlot)
    : previous.length === 1
      ? previous[0]
      : undefined;
  if (!slot)
    throw new BadRequestException(
      "存在多个账号角色，请通过 resolution.slotId 指定更换哪个角色。",
    );
  return {
    response: {
      ...response,
      accounts: { [slot.slotId]: account },
      resolution: { kind: "REPLACE_ACCOUNT", slotId: slot.slotId, account },
    },
    account: undefined,
    accounts: previous.map((b) =>
      b.slotId === slot.slotId ? { ...b, account: account!, aliases: [] } : b,
    ),
  };
}

export function accountReplacementState(
  policy: Record<string, unknown>,
  accounts: ReturnType<typeof testAccountBindingsSchema.parse> | undefined,
  account?: string,
) {
  const previous = readExecutionState(policy);
  return {
    ...previous,
    accountRevision: previous.accountRevision + 1,
    accounts,
    account: accounts ? undefined : account,
    accountAliases: [],
    // Prior records and writes retain their ownership and cleanup obligations.
    preflightAbsences: [],
    step: "人工已更换账号；按当前分配重新查询前置条件，保留旧账号的清理责任。",
  };
}
