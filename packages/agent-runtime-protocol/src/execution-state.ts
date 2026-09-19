import { businessTestAccountSchema } from "./business-test-account.js";
import { testAccountBindingsSchema } from "./test-accounts.js";
export { businessTestAccountSchema } from "./business-test-account.js";
import { z } from "zod";

const text = z.string().trim().min(1).max(500);

export const executionRecordSchema = z.object({
  recordRef: text.optional(),
  id: text,
  type: text
    .describe(
      "平台观察到的业务类型编码；显示名称单独保存。优先引用 observedRecords 中的 recordRef。",
    )
    .optional(),
  displayType: text.optional(),
  resourceUrl: z.string().max(2000).optional(),
  account: text.optional(),
  accountAliases: z.array(text).max(20).default([]),
  ownership: z.enum(["CREATED_THIS_RUN", "EXISTING", "UNCONFIRMED"]),
  initialState: z
    .string()
    .max(2000)
    .describe(
      "修改前真实观察到的状态，以 JSON 保存；由平台从 observedRecords 继承，不填自然语言说明。",
    )
    .optional(),
  currentState: z.string().max(2000).optional(),
  baselineObservation: z
    .object({
      readKey: text,
      sequence: z.number().int().nonnegative(),
      timestamp: z.string().optional(),
    })
    .optional(),
  uiBaseline: z
    .object({
      observationId: z.string().uuid(),
      pageIdentity: z.string().max(2000),
      capturedAt: z.string().datetime(),
      values: z.array(z.string().max(500)).min(1).max(100),
      evidenceRefs: z.array(text).min(1).max(20),
    })
    .optional(),
  evidenceRefs: z.array(text).min(1).max(20),
  cleanup: z
    .object({
      instruction: text,
      status: z.enum(["PENDING", "COMPLETED", "BLOCKED", "RETAINED"]),
      resolution: z.enum(["DELETED", "RESTORED"]).optional(),
      retainedAtWriteKey: text.optional(),
      note: z.string().max(1000).optional(),
    })
    .optional(),
});

export const executionRecordDeltaSchema = executionRecordSchema
  .omit({ uiBaseline: true, baselineObservation: true })
  .partial()
  .extend({
    accountAliases: z.array(text).max(20).optional(),
    evidenceRefs: z.array(text).max(20).optional(),
    cleanup: executionRecordSchema.shape.cleanup
      .unwrap()
      .omit({ resolution: true, retainedAtWriteKey: true })
      .optional(),
  });

export const executionStateSchema = z.object({
  requestOrder: z.array(text).max(2000).default([]),
  requestOrderTruncated: z.boolean().default(false),
  readReceipts: z
    .array(
      z.object({
        key: text,
        url: z.string().max(2000),
        sequence: z.number().int(),
        timestamp: z.string().optional(),
        empty: z.boolean(),
        complete: z.boolean(),
        recordKeys: z.array(z.string().max(3000)).max(100),
        identitiesComplete: z.boolean().default(false),
        identities: z
          .array(
            z.object({
              id: text,
              type: text,
              accountAliases: z.array(text).max(20),
            }),
          )
          .max(100)
          .default([]),
        recordStates: z
          .record(z.string().max(3000), z.string().max(2000))
          .default({}),
        evidenceRefs: z.array(text).max(20),
      }),
    )
    .max(200)
    .default([]),
  cleanupConfirmations: z
    .array(
      z.object({
        recordRef: text,
        writeKey: text,
        readKey: text,
        source: z.enum(["NETWORK", "UI"]).optional(),
        evidenceRefs: z.array(text).max(20),
      }),
    )
    .max(50)
    .default([]),
  accounts: testAccountBindingsSchema.optional(),
  accountRevision: z.number().int().nonnegative().default(0),
  version: z.literal(1).default(1),
  phase: z
    .enum(["PREFLIGHT", "EXECUTING", "VERIFYING", "CLEANUP"])
    .default("PREFLIGHT"),
  step: z.string().max(1000).default("核对前置条件"),
  account: businessTestAccountSchema.optional(),
  preflightAbsences: z.array(z.string().max(3000)).max(100).default([]),
  existingRecordKeys: z.array(z.string().max(3000)).max(200).default([]),
  accountAliases: z.array(businessTestAccountSchema).max(20).default([]),
  records: z.array(executionRecordSchema).max(50).default([]),
  // Read-only candidates retain the baseline before a model registers cleanup.
  observedRecords: z.array(executionRecordSchema).max(100).default([]),
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
  writeHistoryTruncated: z.boolean().default(false),
  cleanupReview: z
    .object({
      status: z.literal("BLOCKED"),
      note: z.string().trim().min(1).max(1000),
      writeKeys: z.array(text).min(1).max(200),
      evidenceRefs: z.array(text).min(1).max(20),
    })
    .optional(),
  writes: z
    .array(
      z.object({
        key: text,
        sequence: z.number().int().optional(),
        timestamp: z.string().optional(),
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        url: z.string().max(2000),
        status: z.number().int().nullable(),
        confirmed: z.boolean().default(false),
        request: z.string().max(4000).optional(),
        response: z.string().max(4000).optional(),
        uiTypeLabel: text.optional(),
        evidenceRefs: z.array(text).max(20),
      }),
    )
    .max(200)
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
