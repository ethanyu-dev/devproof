import { z } from "zod";

const text = z.string().trim().min(1).max(500);
export const businessTestAccountSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N}._@+:-]*$/u,
    "请填写账号标识；操作说明请使用处置意见，不要填入账号。",
  )
  .refine(
    (value) => !/(?:删除|重新创建|允许你|先把|再创建|帮我|重试)/u.test(value),
    "请填写手机号、UUID、邮箱或用户 ID，不要填写操作说明。",
  );

export const executionRecordSchema = z.object({
  id: text,
  type: text.optional(),
  resourceUrl: z.string().max(2000).optional(),
  account: text.optional(),
  accountAliases: z.array(text).max(20).default([]),
  ownership: z.enum(["CREATED_THIS_RUN", "EXISTING", "UNCONFIRMED"]),
  initialState: z.string().max(2000).optional(),
  currentState: z.string().max(2000).optional(),
  evidenceRefs: z.array(text).min(1).max(20),
  cleanup: z
    .object({
      instruction: text,
      status: z.enum(["PENDING", "COMPLETED", "BLOCKED"]),
      note: z.string().max(1000).optional(),
    })
    .optional(),
});

export const executionStateSchema = z.object({
  version: z.literal(1).default(1),
  phase: z
    .enum(["PREFLIGHT", "EXECUTING", "VERIFYING", "CLEANUP"])
    .default("PREFLIGHT"),
  step: z.string().max(1000).default("核对前置条件"),
  account: businessTestAccountSchema.optional(),
  preflightAbsences: z.array(z.string().max(3000)).max(100).default([]),
  existingRecordKeys: z.array(z.string().max(3000)).max(200).default([]),
  accountConflict: z.string().max(1000).optional(),
  accountAliases: z.array(businessTestAccountSchema).max(20).default([]),
  records: z.array(executionRecordSchema).max(50).default([]),
  // Observed after a matching POST, awaiting its complete business receipt.
  pendingRecords: z
    .array(
      executionRecordSchema.pick({
        id: true,
        type: true,
        resourceUrl: true,
        accountAliases: true,
        currentState: true,
        evidenceRefs: true,
      }),
    )
    .max(50)
    .default([]),
  writes: z
    .array(
      z.object({
        key: text,
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        url: z.string().max(2000),
        status: z.number().int().nullable(),
        confirmed: z.boolean().default(false),
        request: z.string().max(4000).optional(),
        response: z.string().max(4000).optional(),
        evidenceRefs: z.array(text).max(20),
      }),
    )
    .max(32)
    .default([]),
});
export type ExecutionState = z.infer<typeof executionStateSchema>;
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

export function readExecutionState(
  policy: Record<string, unknown>,
): ExecutionState {
  const parsed = executionStateSchema.safeParse(policy.executionState);
  return parsed.success ? parsed.data : executionStateSchema.parse({});
}
