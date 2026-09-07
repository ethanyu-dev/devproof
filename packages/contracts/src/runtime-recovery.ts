import { z } from "zod";

export const runtimeRecoveryClosureStateSchema = z.enum([
  "OBSERVED",
  "REQUESTED",
  "CLOSING",
  "VERIFIED",
  "RETRY_WAIT",
  "WAITING_RUNTIME",
  "NEEDS_OPERATOR",
]);
export const runtimeRecoveryWriteOutcomeStateSchema = z.enum([
  "UNASSESSED",
  "NOT_APPLICABLE",
  "UNKNOWN",
  "NO_WRITE_VERIFIED",
  "CONFIRMED",
  "RESOLVED",
]);
export const runtimeRecoveryQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  state: runtimeRecoveryClosureStateSchema.optional(),
  writeState: runtimeRecoveryWriteOutcomeStateSchema.optional(),
  runtimeId: z.string().uuid().optional(),
  view: z.enum(["pending", "all"]).optional(),
});
export type RuntimeRecoveryQuery = z.infer<typeof runtimeRecoveryQuerySchema>;

export interface RuntimeRecoveryCounts {
  pending: number;
  needsOperator: number;
  awaitingWrite: number;
}
const recoveryNoteSchema = z.string().trim().min(10).max(2000);
const recoveryEvidenceRefsSchema = z
  .array(z.string().trim().min(1).max(1000))
  .min(1)
  .max(50);
export const runtimeRecoveryRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(200).optional() })
  .strict();
export const runtimeRecoveryRetrySchema = z
  .object({ expectedVersion: z.number().int().min(1) })
  .strict();
export const runtimeRecoveryResolveWriteOutcomeSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    idempotencyKey: z.string().uuid(),
    outcome: z.enum(["NO_WRITE", "VERIFIED", "COMPENSATED"]),
    note: recoveryNoteSchema,
    evidenceRefs: recoveryEvidenceRefsSchema,
  })
  .strict();
export const runtimeDrainCreateSchema = z
  .object({
    snapshotDigest: z.string().min(1).max(200),
    note: recoveryNoteSchema.optional(),
  })
  .strict();
export const runtimeDrainAttestSchema = z
  .object({
    snapshotDigest: z.string().min(1).max(200),
    idempotencyKey: z.string().uuid(),
    note: recoveryNoteSchema,
    evidenceRefs: recoveryEvidenceRefsSchema,
    infrastructureTerminated: z.literal(true),
  })
  .strict();

export const runtimeDrainResumeSchema = z
  .object({
    snapshotDigest: z.string().min(1).max(200),
    note: recoveryNoteSchema,
    evidenceRefs: recoveryEvidenceRefsSchema,
    profileStoragePreserved: z.literal(true),
  })
  .strict();

export interface RuntimeDrainResumeToken {
  runtimeId: string;
  drainId: string;
  instanceKey: string;
  pairingToken: string;
  expiresAt: string;
}

export interface RuntimeRecoverySummary {
  id: string;
  sessionId: string;
  runtimeId: string;
  sourceRunId: string | null;
  reason: string;
  closureState: z.infer<typeof runtimeRecoveryClosureStateSchema>;
  writeOutcomeState: z.infer<typeof runtimeRecoveryWriteOutcomeStateSchema>;
  attempts: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  version: number;
  scopeSnapshot: unknown;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}
export interface RuntimeRecoveryPage {
  items: Array<
    RuntimeRecoverySummary & {
      runtimeName: string | null;
      sourceRunGoal: string | null;
    }
  >;
  nextCursor: string | null;
  total: number;
}
export interface RuntimeRecoveryDetail extends RuntimeRecoverySummary {
  evidence: unknown;
  guards: unknown;
}
export interface RuntimeDrainSessionSummary {
  sessionId: string;
  fencingToken: string;
  status: string;
  closureVerifiedAt: string | null;
}
export interface RuntimeDrainOperationSummary {
  id: string;
  snapshotDigest: string;
  state: string;
  resumedAt: string | null;
  frozenSessions: RuntimeDrainSessionSummary[];
}
export interface RuntimeDrainPreview {
  runtimeId: string;
  connectionGeneration: string;
  hostInstanceId: string | null;
  snapshotDigest: string;
  sessions: RuntimeDrainSessionSummary[];
  drainState: string;
  existingDrain: RuntimeDrainOperationSummary | null;
}
export type RuntimeRecoveryResolveWriteOutcome = z.infer<
  typeof runtimeRecoveryResolveWriteOutcomeSchema
>;
export type RuntimeDrainAttest = z.infer<typeof runtimeDrainAttestSchema>;
