import { z } from "zod";
import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";

export const AGENT_RUNTIME_PROTOCOL = {
  major: 2,
  minor: 1,
  name: "devproof-agent-runtime",
} as const;

export const runLifecycleSchema = z.enum([
  "QUEUED",
  "PREPARING",
  "RUNNING",
  "WAITING_HUMAN",
  "COMPLETED",
  "CANCELLED",
  "TIMED_OUT",
]);

export const executionDispositionSchema = z.enum([
  "EXECUTED",
  "NOT_RUN",
  "BLOCKED",
  "AGENT_ERROR",
  "PROVIDER_ERROR",
  "BROWSER_UNAVAILABLE",
  "RUNTIME_LOST",
]);

export const productVerdictSchema = z.enum([
  "PASSED",
  "FAILED",
  "INCONCLUSIVE",
]);

export const criterionStatusSchema = productVerdictSchema;

export const runtimeFailureClassSchema = z.enum([
  "TOOL_EXECUTION",
  "PROVIDER",
  "LIFECYCLE_PROTOCOL",
  "BROWSER_RUNTIME",
  "TIMEOUT",
  "RUNTIME_LOST",
  "UNKNOWN",
]);

export const runtimeCapabilitySchema = z.enum([
  "BROWSER_VERIFICATION",
  "ISSUE_ANALYSIS",
]);

export const agentProviderSchema = z.enum([
  "OPENAI",
  "CODEX",
  "CLAUDE",
  "CUSTOM",
  "GENERIC",
]);

export const runtimeEvidenceKindSchema = z.enum([
  "SCREENSHOT",
  "DOM",
  "NETWORK",
  "CONSOLE",
  "BUSINESS_REFERENCE",
  "ARTIFACT",
]);

export const runtimeEvidenceRefSchema = z.object({
  externalId: z.string().trim().min(1).max(500),
  kind: runtimeEvidenceKindSchema,
  label: z.string().trim().max(500).default(""),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const runtimeBusinessReferenceSchema = runtimeEvidenceRefSchema.extend({
  externalId: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^reference:\/\/[a-z0-9][a-z0-9/._~-]*$/iu),
  kind: z.literal("BUSINESS_REFERENCE"),
});

export const runtimeProtocolVersionSchema = z.object({
  major: z.literal(AGENT_RUNTIME_PROTOCOL.major),
  minor: z.number().int().nonnegative(),
  name: z.literal(AGENT_RUNTIME_PROTOCOL.name),
});

export const runtimeCriterionSchema = z.object({
  description: z.string().trim().min(1).max(4_000),
  id: z.string().trim().min(1).max(160),
  required: z.boolean().default(true),
  requiredEvidenceKinds: z
    .array(runtimeEvidenceKindSchema)
    .max(6)
    .default([])
    .transform((values) => Array.from(new Set(values))),
});

export const runtimeTaskSnapshotSchema = z.object({
  attemptId: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  businessReferences: z
    .array(runtimeBusinessReferenceSchema)
    .max(100)
    .default([]),
  criteria: z.array(runtimeCriterionSchema).min(1).max(100),
  deadlineAt: z.string().datetime(),
  hardDeadlineAt: z.string().datetime().optional(),
  environment: z.record(z.string(), z.unknown()).default({}),
  executionPolicy: z.record(z.string(), z.unknown()).default({}),
  goal: z.string().trim().min(1).max(20_000),
  model: z
    .object({
      name: z.string().trim().min(1).max(160),
      provider: agentProviderSchema,
      reasoningEffort: z.string().trim().min(1).max(80).optional(),
    })
    .optional(),
  runId: z.string().uuid(),
  teamId: z.string().uuid(),
  traceId: z.string().regex(/^[a-f0-9]{32}$/u),
});

export const runtimeTaskLeaseSchema = z.object({
  fencingToken: z.string().regex(/^\d+$/u),
  leaseExpiresAt: z.string().datetime(),
  leaseToken: z.string().uuid(),
  snapshot: runtimeTaskSnapshotSchema,
  taskId: z.string().uuid(),
});

export const runtimeTaskClaimInputSchema = z.object({
  capabilities: z.array(runtimeCapabilitySchema).min(1).max(8),
  protocol: runtimeProtocolVersionSchema,
  workerId: z.string().trim().min(1).max(200),
});

export const runtimeTaskClaimOutputSchema = z.object({
  task: runtimeTaskLeaseSchema.nullable(),
});

const leasedTaskInputSchema = z.object({
  fencingToken: z.string().regex(/^\d+$/u),
  leaseToken: z.string().uuid(),
  workerId: z.string().trim().min(1).max(200),
});

export const runtimeTaskHeartbeatInputSchema = leasedTaskInputSchema;

export const runtimeTaskHeartbeatOutputSchema = z.object({
  deadlineAt: z.string().datetime().optional(),
  directive: z.enum(["CONTINUE", "CANCEL"]),
  hardDeadlineAt: z.string().datetime().optional(),
  leaseExpiresAt: z.string().datetime(),
  extension: z
    .object({
      extendedByMs: z.number().int().positive(),
      reason: z.literal("SLOW_MODEL"),
    })
    .optional(),
});

const runtimeTraceContextSchema = z.object({
  attemptNumber: z.number().int().positive(),
  segmentId: z.string().trim().min(1).max(240),
});

const runtimeTraceStepContextSchema = runtimeTraceContextSchema.extend({
  step: z.number().int().positive(),
});

export const runtimeTraceEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent.segment.started"),
    payload: runtimeTraceContextSchema.extend({
      inputPreview: z.unknown(),
      model: z.string().trim().min(1).max(160),
      provider: z.string().trim().min(1).max(80),
    }),
  }),
  z.object({
    kind: z.literal("agent.segment.completed"),
    payload: runtimeTraceContextSchema.extend({
      durationMs: z.number().int().nonnegative(),
      errorMessage: z.string().max(4_000).optional(),
      status: z.enum(["SUCCEEDED", "FAILED", "WAITING_HUMAN"]),
    }),
  }),
  z.object({
    kind: z.literal("agent.model.started"),
    payload: runtimeTraceStepContextSchema.extend({
      inputPreview: z.unknown(),
      model: z.string().trim().min(1).max(160),
      provider: z.string().trim().min(1).max(80),
    }),
  }),
  z.object({
    kind: z.literal("agent.model.completed"),
    payload: runtimeTraceStepContextSchema.extend({
      durationMs: z.number().int().nonnegative(),
      inputPreview: z.unknown(),
      model: z.string().trim().min(1).max(160),
      outputPreview: z.unknown(),
      provider: z.string().trim().min(1).max(80),
      responseId: z.string().trim().min(1).max(240),
      usage: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({
    kind: z.literal("agent.model.failed"),
    payload: runtimeTraceStepContextSchema.extend({
      durationMs: z.number().int().nonnegative(),
      errorMessage: z.string().max(4_000),
      inputPreview: z.unknown(),
      model: z.string().trim().min(1).max(160),
      provider: z.string().trim().min(1).max(80),
    }),
  }),
  z.object({
    kind: z.literal("agent.tool.started"),
    payload: runtimeTraceStepContextSchema.extend({
      callId: z.string().trim().min(1).max(240),
      inputPreview: z.unknown(),
      name: z.string().trim().min(1).max(160),
    }),
  }),
  z.object({
    kind: z.literal("agent.tool.completed"),
    payload: runtimeTraceStepContextSchema.extend({
      callId: z.string().trim().min(1).max(240),
      durationMs: z.number().int().nonnegative(),
      inputPreview: z.unknown(),
      name: z.string().trim().min(1).max(160),
      outputPreview: z.unknown(),
      status: z.enum(["SUCCEEDED", "FAILED"]),
    }),
  }),
  z.object({
    kind: z.literal("agent.tool.failed"),
    payload: runtimeTraceStepContextSchema.extend({
      callId: z.string().trim().min(1).max(240),
      durationMs: z.number().int().nonnegative(),
      errorMessage: z.string().max(4_000),
      inputPreview: z.unknown(),
      name: z.string().trim().min(1).max(160),
    }),
  }),
]);

export type RuntimeTraceEvent = z.infer<typeof runtimeTraceEventSchema>;

export const runtimeTaskEventInputSchema = leasedTaskInputSchema.extend({
  event: z.object({
    eventId: z.string().uuid(),
    kind: z.string().trim().min(1).max(160),
    occurredAt: z.string().datetime(),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
});

export const runtimeBrowserAcquireInputSchema = leasedTaskInputSchema.extend({
  execution: z
    .object({
      availabilityPolicy: z.enum(["WAIT", "FAIL_FAST"]).default("WAIT"),
      profile: z
        .object({
          key: z.string().trim().min(1).max(160).optional(),
          mode: z.enum(["PERSISTENT", "EPHEMERAL"]).default("EPHEMERAL"),
        })
        .default({ mode: "EPHEMERAL" }),
      requiredCapabilities: z
        .array(z.string().trim().min(1).max(120))
        .max(50)
        .default(["browser"]),
      targetUrl: z.string().url().max(2_048).optional(),
    })
    .default({
      availabilityPolicy: "WAIT",
      profile: { mode: "EPHEMERAL" },
      requiredCapabilities: ["browser"],
    }),
});

export const runtimeBrowserAcquireOutputSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      browserExecutionId: z.string().uuid(),
      expiresAt: z.string().datetime(),
      fencingToken: z.string().regex(/^\d+$/u),
      leaseId: z.string().uuid(),
      runnerId: z.string().uuid(),
      runnerKind: z.literal("BROWSER"),
      status: z.literal("ACQUIRED"),
    }),
    z.object({
      browserExecutionId: z.string().uuid(),
      reason: z.enum([
        "NO_MATCHING_RUNNER",
        "NO_AVAILABLE_SLOT",
        "SESSION_OPEN_FAILED",
      ]),
      retryAfterMs: z.number().int().min(1).max(60_000),
      status: z.literal("WAITING_CAPACITY"),
    }),
  ],
);

export const runtimeBrowserCommandInputSchema = leasedTaskInputSchema.extend({
  command: runtimeActionCommandInputSchema,
});

export const runtimeBrowserReleaseInputSchema = leasedTaskInputSchema;

export const runtimeCriterionResultSchema = z.object({
  criterionId: z.string().trim().min(1).max(160),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  status: criterionStatusSchema,
  summary: z.string().trim().min(1).max(4_000),
});

const verificationCompletedOutcomeSchema = z
  .object({
    criteria: z.array(runtimeCriterionResultSchema).min(1).max(100),
    evidence: z.array(runtimeEvidenceRefSchema).max(200).default([]),
    executionDisposition: z.literal("EXECUTED"),
    kind: z.literal("VERIFICATION_COMPLETED"),
    summary: z.string().trim().min(1).max(8_000),
    verdict: productVerdictSchema,
  })
  .superRefine((outcome, context) => {
    const statuses = outcome.criteria.map((criterion) => criterion.status);
    if (
      outcome.verdict === "PASSED" &&
      statuses.some((status) => status !== "PASSED")
    ) {
      context.addIssue({
        code: "custom",
        message: "A PASSED verdict requires every criterion to pass.",
        path: ["verdict"],
      });
    }
    if (outcome.verdict === "FAILED" && !statuses.includes("FAILED")) {
      context.addIssue({
        code: "custom",
        message: "A FAILED verdict requires at least one failed criterion.",
        path: ["verdict"],
      });
    }
  });

const waitingHumanOutcomeSchema = z.object({
  executionDisposition: z.literal("BLOCKED"),
  intervention: z.object({
    context: z.record(z.string(), z.unknown()).default({}),
    expiresAt: z.string().datetime().optional(),
    kind: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(8_000),
    responseSchema: z.record(z.string(), z.unknown()).default({}),
  }),
  kind: z.literal("WAITING_HUMAN"),
  summary: z.string().trim().min(1).max(8_000),
});

const failureBaseSchema = z.object({
  error: z.object({
    code: z.string().trim().min(1).max(160),
    details: z.record(z.string(), z.unknown()).default({}),
    failureClass: runtimeFailureClassSchema,
    message: z.string().trim().min(1).max(8_000),
    phase: z.string().trim().min(1).max(120).optional(),
  }),
  executionDisposition: z.enum([
    "NOT_RUN",
    "BLOCKED",
    "AGENT_ERROR",
    "PROVIDER_ERROR",
    "BROWSER_UNAVAILABLE",
    "RUNTIME_LOST",
  ]),
  summary: z.string().trim().min(1).max(8_000),
});

const retryableFailureOutcomeSchema = failureBaseSchema.extend({
  kind: z.literal("RETRYABLE_FAILURE"),
});

const fatalFailureOutcomeSchema = failureBaseSchema.extend({
  kind: z.literal("FATAL_FAILURE"),
});

export const runtimeOutcomeSchema = z.discriminatedUnion("kind", [
  verificationCompletedOutcomeSchema,
  waitingHumanOutcomeSchema,
  retryableFailureOutcomeSchema,
  fatalFailureOutcomeSchema,
]);

export function missingRequiredEvidenceKinds(
  criterion: z.infer<typeof runtimeCriterionSchema>,
  evidenceRefs: string[],
  evidence: Iterable<z.infer<typeof runtimeEvidenceRefSchema>>,
) {
  const referenced = new Set(evidenceRefs);
  const availableKinds = new Set(
    Array.from(evidence)
      .filter((item) => referenced.has(item.externalId))
      .map((item) => item.kind),
  );
  return criterion.requiredEvidenceKinds.filter(
    (kind) => !availableKinds.has(kind),
  );
}

export const runtimeTaskOutcomeInputSchema = leasedTaskInputSchema.extend({
  completionId: z.string().uuid(),
  completedAt: z.string().datetime(),
  outcome: runtimeOutcomeSchema,
});

export const runtimeTaskOutcomeOutputSchema = z.object({
  accepted: z.boolean(),
  attemptNumber: z.number().int().positive(),
  lifecycle: runLifecycleSchema,
  nextAttemptScheduled: z.boolean(),
  taskStatus: z.enum(["WAITING_HUMAN", "SUCCEEDED", "FAILED", "TIMED_OUT"]),
});

export type ExecutionDisposition = z.infer<typeof executionDispositionSchema>;
export type ProductVerdict = z.infer<typeof productVerdictSchema>;
export type RunLifecycle = z.infer<typeof runLifecycleSchema>;
export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;
export type RuntimeBrowserAcquireInput = z.infer<
  typeof runtimeBrowserAcquireInputSchema
>;
export type RuntimeBrowserAcquireOutput = z.infer<
  typeof runtimeBrowserAcquireOutputSchema
>;
export type RuntimeBrowserCommandInput = z.infer<
  typeof runtimeBrowserCommandInputSchema
>;
export type RuntimeBrowserReleaseInput = z.infer<
  typeof runtimeBrowserReleaseInputSchema
>;
export type RuntimeFailureClass = z.infer<typeof runtimeFailureClassSchema>;
export type RuntimeEvidenceKind = z.infer<typeof runtimeEvidenceKindSchema>;
export type RuntimeEvidenceRef = z.infer<typeof runtimeEvidenceRefSchema>;
export type RuntimeOutcome = z.infer<typeof runtimeOutcomeSchema>;
export type RuntimeTaskClaimInput = z.infer<typeof runtimeTaskClaimInputSchema>;
export type RuntimeTaskLease = z.infer<typeof runtimeTaskLeaseSchema>;
export type RuntimeTaskOutcomeInput = z.infer<
  typeof runtimeTaskOutcomeInputSchema
>;
