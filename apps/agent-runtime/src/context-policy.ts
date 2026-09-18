import { z } from "zod";

const bytes = z
  .number()
  .int()
  .min(1024)
  .max(1024 * 1024);
export const contextRetentionSchema = z
  .object({
    detailedTurns: z.number().int().min(1).max(8).default(2),
    summaryTurns: z.number().int().min(0).max(32).default(12),
    toolResultBytes: bytes.default(8 * 1024),
    keyResultBytes: bytes.default(16 * 1024),
    savedObservationBytes: bytes.default(48 * 1024),
    objectEvidenceBytes: bytes.default(32 * 1024),
    observationIndexBytes: bytes.default(16 * 1024),
  })
  .strict();
export type ContextRetention = z.infer<typeof contextRetentionSchema>;
export const DEFAULT_CONTEXT_RETENTION = contextRetentionSchema.parse({});
export const DEFAULT_CONTEXT_MAX_BYTES = 512 * 1024;

// Provider limits are deployment configuration, never guessed from a model name.
export const modelContextLimitsSchema = z.record(
  z.string().min(1),
  z
    .object({
      contextWindowTokens: z.number().int().min(4096),
      outputReserveTokens: z.number().int().min(1).default(8192),
      imageTokensPerImage: z.number().int().min(1).default(8192),
    })
    .strict()
    .refine((v) => v.outputReserveTokens < v.contextWindowTokens, {
      message: "Output reserve must be smaller than the context window.",
    }),
);
export type ModelContextLimits = z.infer<typeof modelContextLimitsSchema>;

export function parseContextJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Deliberately conservative text estimate, not a provider tokenizer. Images have
 * their own configured allowance; base64 transport bytes are never token counts.
 * Shared fallback input uses the smallest configured candidate allowance. */
export function contextWindowBudget(
  modelIds: readonly string[],
  limits: ModelContextLimits,
  imageCount: number,
) {
  const configured = modelIds.flatMap((modelId) => {
    const limit = limits[modelId];
    return limit
      ? [
          {
            modelId,
            ...limit,
            textAllowance: Math.max(
              0,
              limit.contextWindowTokens -
                limit.outputReserveTokens -
                imageCount * limit.imageTokensPerImage -
                1024,
            ),
          },
        ]
      : [];
  });
  return {
    maxTextBytes: configured.length
      ? Math.min(...configured.map((v) => v.textAllowance))
      : null,
    configured,
    unconfiguredModels: modelIds.filter((id) => !limits[id]),
    estimateMethod: "UTF8_BYTES_PLUS_CONFIGURED_IMAGE_ALLOWANCE" as const,
    framingReserveTokens: 1024,
  };
}
