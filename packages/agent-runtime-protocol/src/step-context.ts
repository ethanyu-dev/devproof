import { z } from "zod";

/** Full model input, separate from the deliberately lossy trajectory previews. */
export const stepContextArchiveSchema = z.object({
  version: z.literal(1),
  encoding: z.literal("gzip-base64"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  byteLength: z
    .number()
    .int()
    .positive()
    .max(32 * 1024 * 1024),
  data: z
    .string()
    .min(1)
    .max(24 * 1024 * 1024),
});

export type StepContextArchive = z.infer<typeof stepContextArchiveSchema>;
