import { z } from "zod";
import {
  executionAccountRequirementsSchema,
  testAccountBindingsSchema,
  testAccountSlots,
  testAccountInputSlotsSchema,
} from "./test-accounts.js";
import { businessTestAccountSchema } from "./business-test-account.js";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function accountRequestKindError(
  kind: string,
  context: Record<string, unknown>,
  responseSchema: Record<string, unknown>,
) {
  return kind !== "TEST_ACCOUNT" &&
    (context.accountRequest !== undefined ||
      context.purpose === "BUSINESS_TEST_SUBJECT" ||
      Object.keys(object(responseSchema.properties)).some(
        (key) => key === "account" || key === "accounts",
      ))
    ? "业务账号输入必须使用 TEST_ACCOUNT 并通过用途校验；登录接管不收集账号标识。"
    : null;
}

export const businessAccountRequestSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("DECLARED"),
      slotIds: z.array(z.string().min(1).max(100)).min(1).max(50),
    })
    .strict(),
  z
    .object({
      mode: z.literal("DISCOVERED"),
      subjectKind: z.enum([
        "BUSINESS_INPUT",
        "BUSINESS_RECORD",
        "AUTH_SUBJECT",
      ]),
      target: z.string().trim().min(1).max(200),
      criterionId: z.string().min(1).max(160),
      usage: z.enum(["CREATE_OR_MODIFY", "READ_EXISTING"]),
      requiredTypes: z
        .array(z.string().trim().min(1).max(1000))
        .max(20)
        .default([]),
      observation: z.object({
        observationId: z.string().uuid(),
        cursor: z.number().int().nonnegative(),
        quote: z.string().trim().min(1).max(4000),
        evidenceRefs: z.array(z.string().min(1).max(500)).min(1).max(20),
      }),
    })
    .strict(),
]);

/** Pure validation shared by the executor and the final API boundary. */
export function resolveBusinessAccountRequest(
  policy: Record<string, unknown>,
  request: unknown,
  criterionIds: readonly string[],
  evidence: ReadonlyMap<string, { kind: string; content?: string | undefined }>,
) {
  const requirements = executionAccountRequirementsSchema.parse(
    policy.accountRequirements,
  );
  const parsed = businessAccountRequestSchema.safeParse(request);
  if (!parsed.success)
    throw new Error(
      "TEST_ACCOUNT 必须提供 accountRequest，说明已声明槽位或引用实际观察证明遗漏的业务账号需求；后台登录请使用 BROWSER_HITL。",
    );
  const supplied = testAccountBindingsSchema.parse(policy.testAccounts ?? []);
  const response = object(object(policy.resume).response);
  const state = object(policy.executionState);
  if (
    supplied.length ||
    [
      response.account,
      state.account,
      ...Object.values(object(response.accounts)),
    ].some((value) => businessTestAccountSchema.safeParse(value).success)
  )
    throw new Error(
      "用户已提供账号，不重复索取替换账号；继续可验证项并记录受影响项无法判定。",
    );
  const input = parsed.data;
  if (input.mode === "DECLARED") {
    const slots = testAccountSlots(requirements.requirements);
    if (
      new Set(input.slotIds).size !== input.slotIds.length ||
      input.slotIds.some((id) => !slots.some((s) => s.slotId === id))
    )
      throw new Error("只能请求当前执行计划声明的业务账号槽位。");
    return {
      request: input,
      slots: testAccountInputSlotsSchema.parse(
        slots.filter((s) => input.slotIds.includes(s.slotId)),
      ),
    };
  }
  if (!criterionIds.includes(input.criterionId))
    throw new Error("补充账号需求必须关联当前验收标准。");
  if (
    /^(?:执行人|操作账号|后台操作身份|后台登录账号|登录身份|operator|executor)$/iu.test(
      input.target,
    )
  )
    throw new Error("后台操作身份不是业务测试对象，请使用登录接管。");
  if (!input.observation.quote.includes(input.target))
    throw new Error("观察原文必须包含实际业务字段或被测对象。");
  if (
    !input.observation.evidenceRefs.some((ref) => {
      const item = evidence.get(ref);
      return (
        item &&
        ["DOM", "NETWORK"].includes(item.kind) &&
        item.content?.includes(input.observation.quote)
      );
    })
  )
    throw new Error("补充账号需求必须引用本次执行的真实 DOM 或网络原文。");
  return {
    request: input,
    slots: testAccountInputSlotsSchema.parse([
      {
        slotId: "discovered:1",
        label: input.target,
        usage: input.usage,
        requiredTypes: input.requiredTypes,
      },
    ]),
  };
}
