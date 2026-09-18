import { z } from "zod";

export const directControlClaimsSchema = z
  .object({
    version: z.literal(1),
    audience: z.string().uuid(),
    sessionId: z.string().uuid(),
    userId: z.string().uuid(),
    teamId: z.string().uuid(),
    fencingToken: z.string().regex(/^\d+$/u),
    controlGeneration: z.number().int().nonnegative(),
    expiresAt: z.number().int(),
    issuedAt: z.number().int(),
    nonce: z.string().uuid(),
  })
  .strict();
export type DirectControlClaims = z.infer<typeof directControlClaimsSchema>;
export type BrowserConnection =
  | { transport: "relay" }
  | { transport: "direct"; url: string; ticket: string; expiresAt: number };
