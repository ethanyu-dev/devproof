import { z } from "zod";
// This review has no browser or external-source tools: only saved report facts.
export const acceptanceReviewResultSchema = z.object({
  score: z.number().int().min(0).max(100).nullable(),
  recommendation: z.enum([
    "RECOMMENDED",
    "NEEDS_VALIDATION",
    "NOT_RECOMMENDED",
    "SCOPED_ONLY",
    "PENDING",
  ]),
  summary: z.string().trim().min(1).max(1500),
  releaseReason: z.string().trim().min(1).max(2000),
  focusAreas: z
    .array(
      z.object({
        criterionKey: z.string().min(1).max(1000),
        impact: z.string().trim().min(1).max(1000),
        nextStep: z.string().trim().min(1).max(1000),
      }),
    )
    .max(50),
});
export const acceptanceReviewClaimSchema = z.object({
  workerId: z.string().min(1).max(240),
});
export const acceptanceReviewOutcomeSchema = z
  .object({
    workerId: z.string().min(1).max(240),
    leaseToken: z.string().uuid(),
    result: acceptanceReviewResultSchema.optional(),
    model: z.string().min(1).max(160).optional(),
    error: z.string().min(1).max(2000).optional(),
  })
  .refine(
    (v) => Boolean(v.result) !== Boolean(v.error),
    "Provide a result or an error.",
  );
export type AcceptanceReviewResult = z.infer<
  typeof acceptanceReviewResultSchema
>;
export interface AcceptanceReviewLease {
  id: string;
  leaseToken: string;
  deadlineAt: string;
  context: string;
  modelCandidates: Array<{
    configurationId?: string | undefined;
    apiKey: string;
    baseUrl: string;
    displayName: string;
    modelId: string;
  }>;
}
export const acceptanceReviewClaimOutputSchema = z.object({
  task: z
    .object({
      id: z.string().uuid(),
      leaseToken: z.string().uuid(),
      deadlineAt: z.string().datetime(),
      context: z.string().max(220000),
      modelCandidates: z
        .array(
          z.object({
            configurationId: z.string().uuid().optional(),
            apiKey: z.string(),
            baseUrl: z.string().url(),
            displayName: z.string(),
            modelId: z.string(),
          }),
        )
        .min(1)
        .max(10),
    })
    .nullable(),
});
