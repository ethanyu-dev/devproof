import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const modelUsageSchema = z.object({
  prompt_tokens: count.optional(),
  completion_tokens: count.optional(),
  total_tokens: count.optional(),
  input_tokens: count.optional(),
  output_tokens: count.optional(),
  prompt_cache_hit_tokens: count.optional(),
  prompt_cache_miss_tokens: count.optional(),
  prompt_tokens_details: z
    .object({ cached_tokens: count.optional() })
    .optional(),
  input_tokens_details: z
    .object({ cached_tokens: count.optional() })
    .optional(),
  completion_tokens_details: z
    .object({ reasoning_tokens: count.optional() })
    .optional(),
});

/** Numeric allowlist only: compatible gateways may put arbitrary data in usage. */
export function numericModelUsage(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(modelUsageSchema.shape)) {
    const parsed = schema.safeParse((value as Record<string, unknown>)[key]);
    if (parsed.success && parsed.data !== undefined) result[key] = parsed.data;
  }
  return result;
}

export const modelCallTelemetrySchema = z.object({
  modelCallId: z.string().uuid(),
  configurationId: z.string().uuid().optional(),
  configurationName: z.string().max(100).optional(),
  requestedModel: z.string().min(1).max(160),
  responseModel: z.string().max(160).optional(),
  responseId: z.string().max(240).optional(),
  startedAt: z.string().datetime(),
  durationMs: count.max(86_400_000),
  clockOffsetMs: z.number().finite().min(-86400000).max(86400000).optional(),
  clockUncertaintyMs: count.optional(),
  outcome: z.enum(["SUCCEEDED", "FAILED", "INTERRUPTED"]),
  usage: modelUsageSchema.optional(),
});
export type ModelCallTelemetry = z.infer<typeof modelCallTelemetrySchema>;

export const modelCallRegistrationSchema = z.object({
  modelCallId: z.string().uuid(),
  ownerKind: z.enum(["RUN", "SPEC_ANALYSIS", "ACCEPTANCE_REVIEW"]),
  ownerId: z.string().uuid(),
  workerId: z.string().min(1).max(240),
  leaseToken: z.string().uuid(),
  configurationId: z.string().uuid().optional(),
  configurationName: z.string().min(1).max(100),
  requestedModel: z.string().min(1).max(160),
});
export const modelCallSettlementSchema = z.object({
  workerId: z.string().min(1).max(240),
  leaseToken: z.string().uuid(),
  telemetry: modelCallTelemetrySchema,
});
export type ModelCallRegistration = z.infer<typeof modelCallRegistrationSchema>;
