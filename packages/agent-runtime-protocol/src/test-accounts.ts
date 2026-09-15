import { z } from "zod";
import { businessTestAccountSchema } from "./business-test-account.js";

const notes = z.array(z.string().trim().min(1).max(1000)).max(20).default([]);
export const testAccountRequirementSchema = z.object({
  role: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/),
  label: z.string().trim().min(1).max(200),
  count: z.number().int().min(1).max(20).default(1),
  usage: z.enum(["CREATE_OR_MODIFY", "READ_EXISTING"]),
  requiredTypes: notes,
  constraints: notes,
  rationale: z.string().trim().min(1).max(1000),
});
export const testAccountRequirementsSchema = z
  .array(testAccountRequirementSchema)
  .max(20)
  .superRefine((items, ctx) => {
    if (new Set(items.map((item) => item.role)).size !== items.length)
      ctx.addIssue({ code: "custom", message: "测试账号角色不能重复。" });
    if (items.reduce((sum, item) => sum + item.count, 0) > 50)
      ctx.addIssue({
        code: "custom",
        message: "每个 Case 最多分配 50 个测试账号。",
      });
  });
export const testAccountBindingSchema = z.object({
  slotId: z.string().min(1).max(100),
  label: z.string().max(200).optional(),
  account: businessTestAccountSchema,
  aliases: z.array(businessTestAccountSchema).max(20).default([]),
  usage: z.enum(["CREATE_OR_MODIFY", "READ_EXISTING"]),
  requiredTypes: notes,
});
export const testAccountBindingsSchema = z
  .array(testAccountBindingSchema)
  .max(50);
export const testAccountInputSlotsSchema = z
  .array(
    testAccountBindingSchema
      .pick({ slotId: true, usage: true, requiredTypes: true })
      .extend({ label: z.string().min(1).max(200) }),
  )
  .max(50);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Prefer allocated roles. Legacy multi-field requests keep all requested subjects. */
export function accountInputSlots(
  policy: Record<string, unknown>,
  responseSchema: unknown,
  context: Record<string, unknown>,
) {
  const bindings = testAccountBindingsSchema.parse(policy.testAccounts ?? []);
  if (bindings.length) {
    const ids = Array.isArray(context.slotIds)
      ? context.slotIds
      : bindings.map((b) => b.slotId);
    if (
      !ids.length ||
      ids.some(
        (id) =>
          typeof id !== "string" || !bindings.some((b) => b.slotId === id),
      )
    )
      throw new Error("请用已分配的 slotId 指定需要补充的账号角色。");
    return bindings
      .filter((b) => ids.includes(b.slotId))
      .map((b) => ({
        slotId: b.slotId,
        label: b.label ?? b.slotId,
        usage: b.usage,
        requiredTypes: b.requiredTypes,
      }));
  }
  const schema = record(responseSchema);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  if (required.length <= 1) return [];
  const properties = record(schema.properties);
  return testAccountInputSlotsSchema.parse(
    required.map((key) => ({
      slotId: key,
      label: String(record(properties[key]).description ?? key).slice(0, 200),
      usage:
        context.usage === "READ_EXISTING"
          ? "READ_EXISTING"
          : "CREATE_OR_MODIFY",
      requiredTypes: Array.isArray(context.requiredTypes)
        ? context.requiredTypes
        : [],
    })),
  );
}
export function accountInputResponseSchema(
  slots: z.infer<typeof testAccountInputSlotsSchema>,
) {
  const field = { type: "string", minLength: 1, maxLength: 200 };
  return slots.length
    ? {
        type: "object",
        properties: {
          accounts: {
            type: "object",
            properties: Object.fromEntries(
              slots.map((s) => [s.slotId, { ...field, description: s.label }]),
            ),
            required: slots.map((s) => s.slotId),
            additionalProperties: false,
          },
        },
        required: ["accounts"],
        additionalProperties: false,
      }
    : {
        type: "object",
        properties: { account: field },
        required: ["account"],
        additionalProperties: false,
      };
}
export const testAccountPlanSchema = z.object({
  version: z.literal(1),
  revision: z.string().uuid(),
  requirements: testAccountRequirementsSchema,
  bindings: testAccountBindingsSchema,
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});
export type TestAccountRequirement = z.infer<
  typeof testAccountRequirementSchema
>;
export type TestAccountBinding = z.infer<typeof testAccountBindingSchema>;
export type TestAccountPlan = z.infer<typeof testAccountPlanSchema>;
export function testAccountSlots(
  requirements: readonly TestAccountRequirement[],
) {
  return requirements.flatMap((requirement) =>
    Array.from({ length: requirement.count }, (_, index) => ({
      ...requirement,
      slotId: `${requirement.role}:${index + 1}`,
      label:
        requirement.count === 1
          ? requirement.label
          : `${requirement.label} ${index + 1}`,
    })),
  );
}

/** Old Specs remain executable; names such as 账号A describe roles, never values. */
export function caseAccountRequirements(
  definition: unknown,
): TestAccountRequirement[] {
  const d =
    definition && typeof definition === "object"
      ? (definition as Record<string, unknown>)
      : {};
  if (d.accountRequirements !== undefined)
    return testAccountRequirementsSchema.parse(d.accountRequirements);
  const text = JSON.stringify([d.name, d.preconditions, d.testData, d.steps]);
  if (
    /不需要业务测试账号|无需业务测试账号|本用例不写入数据|本用例未产生写入/u.test(
      text,
    )
  )
    return [];
  if (!/测试账号|业务账号|独立.{0,8}账号|账号[A-Z]/u.test(text)) return [];
  const roles = [
    ...new Set(
      text
        .match(/账号\s*[A-Z](?![a-zA-Z])/gu)
        ?.map((role) => role.replace(/\s/g, "")) ?? [],
    ),
  ];
  return testAccountRequirementsSchema.parse([
    {
      role: "test_subject",
      label: roles.length ? roles.join("、") : "业务测试对象",
      count: Math.max(1, roles.length),
      usage: /只读|READ_EXISTING/u.test(String(d.name))
        ? "READ_EXISTING"
        : "CREATE_OR_MODIFY",
      requiredTypes: [],
      constraints: Array.isArray(d.testData)
        ? d.testData
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.slice(0, 1000))
            .slice(0, 20)
        : [],
      rationale:
        "历史 Spec 声明的业务测试账号；执行前核对其用途和数据前置条件。",
    },
  ]);
}
