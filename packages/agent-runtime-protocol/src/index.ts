import { z } from "zod";
import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";

export const AGENT_RUNTIME_PROTOCOL = {
  major: 2,
  minor: 11,
  name: "devproof-agent-runtime",
} as const;

export const POST_RUN_ANALYSIS_REPORT_MAX_BYTES = 512 * 1_024;

function utf8ByteLength(value: string): number {
  let byteLength = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      byteLength += 1;
    } else if (codeUnit < 0x800) {
      byteLength += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      byteLength += 4;
      index += 1;
    } else {
      byteLength += 3;
    }
  }

  return byteLength;
}

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
  "POST_RUN_ANALYSIS",
]);

export const runtimePoolSchema = z.enum([
  "SPEC_ANALYSIS",
  "BROWSER_EXECUTION",
  "POST_RUN_ANALYSIS",
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

export const runtimeModelCandidateSchema = z.object({
  apiKey: z.string().min(1).max(4_096),
  baseUrl: z.string().url().max(2_000),
  displayName: z.string().trim().min(1).max(100),
  modelId: z.string().trim().min(1).max(160),
});

export const runtimeSpecSourceRefSchema = z.object({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  excerpt: z.string().max(2_000).default(""),
  externalId: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^analysis-source:\/\//u),
  kind: z.enum([
    "LINEAR_ISSUE",
    "GITHUB_PULL_REQUEST",
    "GITHUB_DIFF",
    "GITHUB_FILE",
    "KNOWLEDGE",
  ]),
  label: z.string().trim().min(1).max(500),
  locator: z.record(z.string(), z.unknown()).default({}),
  revision: z.string().trim().max(200).nullable().default(null),
  uri: z.string().trim().min(1).max(2_000),
});

export const runtimeSpecCriterionSchema = z.object({
  description: z.string().trim().min(1).max(5_000),
  id: z.string().trim().min(1).max(160),
  required: z.boolean().default(true),
  requiredEvidenceKinds: z.array(runtimeEvidenceKindSchema).min(1).max(6),
  sourceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
});

export const runtimeGeneratedSpecCaseSchema = z.object({
  authRole: z.string().trim().min(1).max(120).default("default"),
  cleanup: z.array(z.string().trim().min(1).max(5_000)).max(50).default([]),
  criteria: z.array(runtimeSpecCriterionSchema).min(1).max(100),
  name: z.string().trim().min(1).max(500),
  preconditions: z.array(z.string().trim().min(1).max(5_000)).min(1).max(100),
  priority: z.enum(["HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
  rationale: z.string().trim().min(1).max(5_000),
  sourceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  steps: z
    .array(
      z.object({
        action: z.string().trim().min(1).max(5_000),
        expectedObservation: z.string().trim().min(1).max(5_000),
        order: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(100),
  testData: z.array(z.string().trim().min(1).max(5_000)).max(100).default([]),
});

export const runtimeGeneratedSpecSchema = z.object({
  assumptions: z
    .array(z.string().trim().min(1).max(5_000))
    .max(100)
    .default([]),
  cases: z.array(runtimeGeneratedSpecCaseSchema).min(1).max(100),
  risks: z.array(z.string().trim().min(1).max(5_000)).max(100).default([]),
  scope: z.object({
    inScope: z.array(z.string().trim().min(1).max(5_000)).min(1).max(100),
    outOfScope: z
      .array(z.string().trim().min(1).max(5_000))
      .max(100)
      .default([]),
  }),
  summary: z.string().trim().min(1).max(8_000),
});

export const runtimeSpecAnalysisTaskSnapshotSchema = z.object({
  attemptNumber: z.number().int().positive(),
  deadlineAt: z.string().datetime(),
  issueRef: z.string().trim().min(1).max(500),
  modelCandidates: z.array(runtimeModelCandidateSchema).min(1).max(10),
  stageAttemptId: z.string().uuid(),
  targetUrl: z.string().url().max(2_048).optional(),
  taskExecutionId: z.string().uuid(),
  teamId: z.string().uuid(),
  traceId: z.string().regex(/^[a-f0-9]{32}$/u),
});

export const runtimeSpecAnalysisTaskLeaseSchema = z.object({
  fencingToken: z.string().regex(/^\d+$/u),
  leaseExpiresAt: z.string().datetime(),
  leaseToken: z.string().uuid(),
  serverTime: z.string().datetime().optional(),
  leaseDurationMs: z.number().nonnegative().optional(),
  snapshot: runtimeSpecAnalysisTaskSnapshotSchema,
  taskId: z.string().uuid(),
});

export const runtimeSpecAnalysisClaimInputSchema = z.object({
  protocol: runtimeProtocolVersionSchema,
  workerId: z.string().trim().min(1).max(200),
});

export const runtimeSpecAnalysisClaimOutputSchema = z.object({
  task: runtimeSpecAnalysisTaskLeaseSchema.nullable(),
});

export const runtimePostRunAnalysisCheckpointSchema = z.object({
  analysisSummary: z
    .string()
    .trim()
    .min(1)
    .max(16_000)
    .nullable()
    .default(null),
  bundleComplete: z.boolean().default(false),
  bundleCursor: z.number().int().nonnegative().default(0),
  evidenceRefs: z
    .array(z.string().trim().min(1).max(500))
    .max(500)
    .default([])
    .transform((values) => Array.from(new Set(values))),
  updatedAt: z.string().datetime().nullable().default(null),
});

export const runtimePostRunAnalysisTaskSnapshotSchema = z.object({
  analysisId: z.string().uuid(),
  analyzerVersion: z.string().trim().min(1).max(160),
  attemptNumber: z.number().int().positive(),
  checkpoint: runtimePostRunAnalysisCheckpointSchema.optional(),
  deadlineAt: z.string().datetime(),
  input: z.object({
    byteSize: z.number().int().nonnegative(),
    completeness: z.record(z.string(), z.unknown()).default({}),
    manifest: z.record(z.string(), z.unknown()).default({}),
    schemaVersion: z.literal("devproof.task-logs.v2"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  modelCandidates: z.array(runtimeModelCandidateSchema).max(10),
  sourceRef: z.string().trim().max(500).nullable(),
  taskExecutionId: z.string().uuid(),
  teamId: z.string().uuid(),
  title: z.string().trim().min(1).max(500),
  traceId: z.string().regex(/^[a-f0-9]{32}$/u),
});

export const runtimePostRunAnalysisTaskLeaseSchema = z.object({
  fencingToken: z.string().regex(/^\d+$/u),
  leaseExpiresAt: z.string().datetime(),
  leaseToken: z.string().uuid(),
  snapshot: runtimePostRunAnalysisTaskSnapshotSchema,
  taskId: z.string().uuid(),
});

export const runtimePostRunAnalysisClaimInputSchema = z.object({
  protocol: runtimeProtocolVersionSchema,
  workerId: z.string().trim().min(1).max(200),
});

export const runtimePostRunAnalysisClaimOutputSchema = z.object({
  task: runtimePostRunAnalysisTaskLeaseSchema.nullable(),
});

export const runtimePostRunAnalysisToolOutputSchema = z.object({
  body: z.string(),
  contentType: z.string().trim().min(1).max(200),
  evidenceRef: z.string().trim().min(1).max(500).optional(),
  nextCursor: z.number().int().nonnegative().nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  totalBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const runtimeSpecAnalysisToolNameSchema = z.enum([
  "linear_get_issue",
  "github_get_pull_request",
  "github_list_changed_files",
  "github_read_file",
  "github_search_code",
  "knowledge_search",
]);

export const runtimeSpecAnalysisToolOutputSchema = z.object({
  result: z.unknown(),
  sourceRefs: z.array(runtimeSpecSourceRefSchema).max(100).default([]),
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
  modelCandidates: z
    .array(runtimeModelCandidateSchema)
    .min(1)
    .max(10)
    .optional(),
  runId: z.string().uuid(),
  teamId: z.string().uuid(),
  traceId: z.string().regex(/^[a-f0-9]{32}$/u),
});

export const runtimeTaskLeaseSchema = z.object({
  fencingToken: z.string().regex(/^\d+$/u),
  leaseExpiresAt: z.string().datetime(),
  leaseToken: z.string().uuid(),
  serverTime: z.string().datetime().optional(),
  leaseDurationMs: z.number().nonnegative().optional(),
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

export const runtimeRegistrationInputSchema = z.object({
  pool: runtimePoolSchema.optional(),
  protocol: runtimeProtocolVersionSchema,
  workerId: z.string().trim().min(1).max(200),
});

export const runtimeRegistrationOutputSchema = z.object({
  analysisConcurrency: z.number().int().min(0).max(64).default(0),
  browserConcurrency: z.number().int().min(0).max(1_024),
  pools: z.array(runtimePoolSchema).min(1).max(3),
  refreshAfterMs: z.number().int().min(1_000).max(60_000),
  specConcurrency: z.number().int().min(0).max(64),
});

const leasedTaskInputSchema = z.object({
  fencingToken: z.string().regex(/^\d+$/u),
  leaseToken: z.string().uuid(),
  workerId: z.string().trim().min(1).max(200),
});

const runtimePostRunAnalysisReadBundleInputSchema =
  leasedTaskInputSchema.extend({
    analysisSummary: z.string().trim().min(1).max(16_000),
    cursor: z.number().int().nonnegative().default(0),
    maxBytes: z.number().int().min(1_024).max(128_000).default(32_000),
    name: z.literal("read_analysis_bundle"),
  });

const runtimePostRunAnalysisReadManifestInputSchema =
  leasedTaskInputSchema.extend({
    analysisSummary: z.string().trim().min(1).max(16_000),
    cursor: z.number().int().nonnegative().default(0),
    maxBytes: z.number().int().min(1_024).max(128_000).default(32_000),
    name: z.literal("read_analysis_manifest"),
  });

const runtimePostRunAnalysisReadEvidenceInputSchema =
  leasedTaskInputSchema.extend({
    analysisSummary: z.string().trim().min(1).max(16_000),
    cursor: z.number().int().nonnegative().default(0),
    evidenceRef: z.string().trim().min(1).max(500),
    maxBytes: z.number().int().min(1_024).max(128_000).default(32_000),
    name: z.literal("read_analysis_evidence"),
  });

export const runtimePostRunAnalysisToolInputSchema = z.discriminatedUnion(
  "name",
  [
    runtimePostRunAnalysisReadBundleInputSchema,
    runtimePostRunAnalysisReadManifestInputSchema,
    runtimePostRunAnalysisReadEvidenceInputSchema,
  ],
);

export const runtimeSpecAnalysisToolInputSchema = leasedTaskInputSchema.extend({
  arguments: z.record(z.string(), z.unknown()),
  callId: z.string().trim().min(1).max(240),
  name: runtimeSpecAnalysisToolNameSchema,
});

export const runtimeTaskHeartbeatInputSchema = leasedTaskInputSchema;

export const runtimeTaskHeartbeatOutputSchema = z.object({
  deadlineAt: z.string().datetime().optional(),
  directive: z.enum(["CONTINUE", "CANCEL"]),
  hardDeadlineAt: z.string().datetime().optional(),
  leaseExpiresAt: z.string().datetime(),
  serverTime: z.string().datetime().optional(),
  leaseDurationMs: z.number().nonnegative().optional(),
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
    kind: z.literal("agent.analysis.completed"),
    payload: runtimeTraceStepContextSchema.extend({
      callId: z.string().trim().min(1).max(240).optional(),
      sourceRefs: z
        .array(z.string().trim().min(1).max(500))
        .max(100)
        .default([]),
      summary: z.string().trim().min(1).max(4_000),
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
      sourceRefs: z
        .array(z.string().trim().min(1).max(500))
        .max(500)
        .default([]),
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
  z.object({
    kind: z.literal("agent.spec.validation_failed"),
    payload: runtimeTraceStepContextSchema.extend({
      errorMessage: z.string().trim().min(1).max(4_000),
      outputPreview: z.unknown(),
    }),
  }),
  z.object({
    kind: z.literal("agent.spec.generated"),
    payload: runtimeTraceStepContextSchema.extend({
      caseCount: z.number().int().positive(),
      outputPreview: z.unknown(),
      sourceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(500),
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
        "DATA_LOCK",
        "IDENTITY_CAPACITY",
        "AUTH_REQUIRED",
        "AUTH_REFRESH",
        "CASE_DEPENDENCY",
        "LEASE_RECOVERY",
        "ADMISSION_STALE",
        "PROTOCOL_UNSUPPORTED",
        "AGENT_CAPACITY",
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

export const runtimePostRunFindingSchema = z
  .object({
    attemptNumber: z.number().int().positive().nullable(),
    category: z.enum([
      "PRODUCT_BUG",
      "SPEC_GAP",
      "TEST_FLAKINESS",
      "AGENT_REASONING",
      "TOOL_PROTOCOL",
      "RUNTIME_ENVIRONMENT",
      "OBSERVABILITY_GAP",
    ]),
    component: z.string().trim().min(1).max(240),
    confidence: z.number().min(0).max(1),
    evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
    failureClass: z.string().trim().min(1).max(160),
    impact: z.string().trim().min(1).max(8_000),
    recommendation: z.string().trim().min(1).max(8_000),
    phase: z.string().trim().min(1).max(240),
    rootCause: z.string().trim().min(1).max(8_000),
    runId: z.string().uuid().nullable(),
    runtimeId: z.string().uuid().nullable(),
    severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
    title: z.string().trim().min(1).max(500),
  })
  .superRefine((finding, context) => {
    if (finding.runtimeId && !finding.runId) {
      context.addIssue({
        code: "custom",
        message: "runId is required when runtimeId is provided.",
        path: ["runId"],
      });
    }
  });

export const runtimePostRunAnalysisCoverageSchema = z.object({
  bundleBytesRead: z.number().int().nonnegative(),
  bundleFullyScanned: z.boolean(),
  candidateCount: z.number().int().nonnegative(),
  evidenceBytesRead: z.number().int().nonnegative(),
  evidenceReadCount: z.number().int().nonnegative(),
  manifestBytesRead: z.number().int().nonnegative(),
  manifestFullyScanned: z.boolean(),
  strategy: z.enum(["failure-first-v1", "full-manifest-fallback"]),
});

export const runtimePostRunAnalysisReportSchema = z
  .object({
    coverage: runtimePostRunAnalysisCoverageSchema.optional(),
    findings: z.array(runtimePostRunFindingSchema).max(100),
    summary: z.string().trim().min(1).max(12_000),
  })
  .superRefine((report, context) => {
    const byteSize = utf8ByteLength(JSON.stringify(report));
    if (byteSize > POST_RUN_ANALYSIS_REPORT_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Post-run analysis report exceeds ${POST_RUN_ANALYSIS_REPORT_MAX_BYTES} UTF-8 bytes.`,
      });
    }
  });

const retryableFailureOutcomeSchema = failureBaseSchema.extend({
  kind: z.literal("RETRYABLE_FAILURE"),
});

const fatalFailureOutcomeSchema = failureBaseSchema.extend({
  kind: z.literal("FATAL_FAILURE"),
});

const postRunAnalysisCompletedOutcomeSchema = z.object({
  kind: z.literal("ANALYSIS_COMPLETED"),
  report: runtimePostRunAnalysisReportSchema,
});

export const runtimePostRunAnalysisOutcomeSchema = z.discriminatedUnion(
  "kind",
  [
    postRunAnalysisCompletedOutcomeSchema,
    retryableFailureOutcomeSchema,
    fatalFailureOutcomeSchema,
  ],
);

export const runtimePostRunAnalysisTaskOutcomeInputSchema =
  leasedTaskInputSchema.extend({
    completedAt: z.string().datetime(),
    completionId: z.string().uuid(),
    outcome: runtimePostRunAnalysisOutcomeSchema,
  });

export const runtimePostRunAnalysisTaskOutcomeOutputSchema = z.object({
  accepted: z.boolean(),
  jobStatus: z.enum(["READY", "SUCCEEDED", "FAILED", "CANCELLED"]),
  nextAttemptScheduled: z.boolean(),
  workItemId: z.string().uuid().nullable(),
});

const specGeneratedOutcomeSchema = z.object({
  kind: z.literal("SPEC_GENERATED"),
  sourceRefs: z.array(runtimeSpecSourceRefSchema).min(1).max(500),
  spec: runtimeGeneratedSpecSchema,
  summary: z.string().trim().min(1).max(8_000),
});

export const runtimeSpecAnalysisOutcomeSchema = z.discriminatedUnion("kind", [
  specGeneratedOutcomeSchema,
  retryableFailureOutcomeSchema,
  fatalFailureOutcomeSchema,
]);

export const runtimeSpecAnalysisTaskOutcomeInputSchema =
  leasedTaskInputSchema.extend({
    completedAt: z.string().datetime(),
    completionId: z.string().uuid(),
    outcome: runtimeSpecAnalysisOutcomeSchema,
  });

export const runtimeSpecAnalysisTaskOutcomeOutputSchema = z.object({
  accepted: z.boolean(),
  attemptNumber: z.number().int().positive(),
  nextAttemptScheduled: z.boolean(),
  stageStatus: z.enum(["PENDING", "SUCCEEDED", "FAILED", "TIMED_OUT"]),
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
export type RuntimePool = z.infer<typeof runtimePoolSchema>;
export type RuntimeModelCandidate = z.infer<typeof runtimeModelCandidateSchema>;
export type RuntimeGeneratedSpec = z.infer<typeof runtimeGeneratedSpecSchema>;
export type RuntimeSpecAnalysisOutcome = z.infer<
  typeof runtimeSpecAnalysisOutcomeSchema
>;
export type RuntimeSpecAnalysisTaskLease = z.infer<
  typeof runtimeSpecAnalysisTaskLeaseSchema
>;
export type RuntimeSpecAnalysisTaskOutcomeInput = z.infer<
  typeof runtimeSpecAnalysisTaskOutcomeInputSchema
>;
export type RuntimeSpecAnalysisToolInput = z.infer<
  typeof runtimeSpecAnalysisToolInputSchema
>;
export type RuntimeSpecSourceRef = z.infer<typeof runtimeSpecSourceRefSchema>;
export type RuntimePostRunAnalysisOutcome = z.infer<
  typeof runtimePostRunAnalysisOutcomeSchema
>;
export type RuntimePostRunAnalysisReport = z.infer<
  typeof runtimePostRunAnalysisReportSchema
>;
export type RuntimePostRunAnalysisTaskLease = z.infer<
  typeof runtimePostRunAnalysisTaskLeaseSchema
>;
export type RuntimePostRunAnalysisTaskOutcomeInput = z.infer<
  typeof runtimePostRunAnalysisTaskOutcomeInputSchema
>;
export type RuntimePostRunAnalysisToolInput = z.infer<
  typeof runtimePostRunAnalysisToolInputSchema
>;
export type RuntimeTaskClaimInput = z.infer<typeof runtimeTaskClaimInputSchema>;
export type RuntimeTaskLease = z.infer<typeof runtimeTaskLeaseSchema>;
export type RuntimeTaskOutcomeInput = z.infer<
  typeof runtimeTaskOutcomeInputSchema
>;
