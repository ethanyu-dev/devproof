import { z } from "zod";
export const savedCriterionObservationSchema = z.object({
  id: z.string().uuid(),
  criterionId: z.string().min(1).max(160),
  target: z.string().min(1).max(500),
  observationId: z.string().uuid(),
  cursor: z.number().int().nonnegative(),
  quote: z.string().min(1).max(4000),
  contextQuotes: z.array(z.string().max(1000)).max(8),
  evidenceRefs: z.array(z.string().min(1).max(500)).max(20),
  url: z.string().max(2048).optional(),
});
export type SavedCriterionObservation = z.infer<
  typeof savedCriterionObservationSchema
>;
