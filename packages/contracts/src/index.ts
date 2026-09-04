import { URL } from "node:url";

import { z } from "zod";
import {
  agentProviderSchema as executionAgentProviderSchema,
  runtimeBusinessReferenceSchema,
  runtimeCriterionSchema,
  runtimeFailureClassSchema,
  runtimePoolSchema,
} from "@devproof/agent-runtime-protocol";
import {
  runtimeNetworkAllowlistSchema,
  runtimeActionCommandInputSchema as protocolRuntimeCommandInputSchema,
  runtimeCommandTypeSchema,
} from "@devproof/runtime-protocol";

const sensitiveVerificationKey =
  /(?:authorization|cookie|password|secret|token|api[-_]?key|credential|session(?:id)?)$/iu;

function sensitivePaths(
  value: unknown,
  path: Array<string | number> = [],
): Array<Array<string | number>> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      sensitivePaths(item, [...path, index]),
    );
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, item]) =>
      sensitiveVerificationKey.test(key)
        ? [[...path, key]]
        : sensitivePaths(item, [...path, key]),
  );
}

export const browserProfileModeSchema = z.enum(["PERSISTENT", "EPHEMERAL"]);

// Execution declarations are supplied by an authenticated caller or reviewed
// configuration. Generated test prose never grants shared-read eligibility.
export const executionConcurrencyPolicySchema = z
  .object({
    accessMode: z.enum(["READ_ONLY", "MUTATING", "UNKNOWN"]),
    resourceScopes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(300)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u),
      )
      .max(50)
      .optional(),
    dependsOnCaseIds: z.array(z.string().uuid()).max(100).optional(),
    provenance: z.string().trim().min(1).max(200).optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();
export type ExecutionConcurrencyPolicy = z.infer<
  typeof executionConcurrencyPolicySchema
>;

export const userBrowserProfileExecutionModeSchema = z.enum([
  "SERIAL_PERSISTENT",
  "ISOLATED_AUTH",
]);

export const runtimeSettingsInputSchema = z.object({
  hitlEnabled: z.boolean(),
});

const githubOrganizationSchema = z
  .string()
  .trim()
  .min(1)
  .max(39)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/u)
  .transform((value) => value.toLowerCase());

const githubRepositorySchema = z
  .string()
  .trim()
  .min(3)
  .max(140)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9_.-]+$/u)
  .transform((value) => value.toLowerCase());

const githubAccessCredentialFields = {
  enabled: z.boolean().default(true),
  name: z.string().trim().min(1).max(100),
  organizations: z
    .array(githubOrganizationSchema)
    .max(100)
    .default([])
    .transform((values) => [...new Set(values)]),
  priority: z.coerce.number().int().min(0).max(1000).default(100),
  repositories: z
    .array(githubRepositorySchema)
    .max(200)
    .default([])
    .transform((values) => [...new Set(values)]),
};

export const githubAccessCredentialCreateInputSchema = z.object({
  ...githubAccessCredentialFields,
  personalAccessToken: z.string().trim().min(20).max(512),
});

export const githubAccessCredentialUpdateInputSchema = z.object({
  ...githubAccessCredentialFields,
  personalAccessToken: z.string().trim().min(20).max(512).optional(),
});

const agentModelConfigurationFields = {
  baseUrl: z
    .string()
    .trim()
    .url()
    .max(2_000)
    .refine((value) => /^https?:\/\//u.test(value), {
      message: "Base URL must use http or https.",
    })
    .refine((value) => !/^https?:\/\/[^/?#]*@/iu.test(value), {
      message: "Base URL cannot contain URL credentials.",
    })
    .transform((value) => value.replace(/\/+$/u, "")),
  displayName: z.string().trim().min(1).max(100),
  modelId: z.string().trim().min(1).max(160),
};

export const agentModelPoolSchema = runtimePoolSchema;

export const agentModelConfigurationCreateInputSchema = z.object({
  ...agentModelConfigurationFields,
  apiKey: z.string().trim().min(1).max(4_096),
  pool: agentModelPoolSchema,
});

export const agentModelConfigurationUpdateInputSchema = z.object({
  ...agentModelConfigurationFields,
  apiKey: z.string().trim().min(1).max(4_096).optional(),
});

export const agentModelConfigurationOrderInputSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(10),
    pool: agentModelPoolSchema,
  })
  .refine((value) => new Set(value.ids).size === value.ids.length, {
    message: "Model order cannot contain duplicate IDs.",
    path: ["ids"],
  });

export const runtimeRoutingFallbackPolicySchema = z.enum(["WAIT", "FAIL_FAST"]);

export const runtimeHostnamePatternSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .refine(
    (value) => {
      const hostname = value.startsWith("*.") ? value.slice(2) : value;
      return (
        !value.includes("*", 1) &&
        hostname
          .split(".")
          .every(
            (label) =>
              label.length >= 1 &&
              label.length <= 63 &&
              /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
          )
      );
    },
    {
      message:
        "Use an exact hostname or a leading wildcard such as *.example.com.",
    },
  );

export const runtimeRoutingRuleInputSchema = z.object({
  enabled: z.boolean().default(true),
  fallbackPolicy: runtimeRoutingFallbackPolicySchema.default("WAIT"),
  hostnamePattern: runtimeHostnamePatternSchema,
  priority: z.coerce.number().int().min(0).max(1000).default(100),
  runtimeId: z.string().uuid(),
});

export const runtimeConfigurationInputSchema = z.object({
  maxConcurrency: z.coerce.number().int().min(1).max(32),
  networkAllowlist: runtimeNetworkAllowlistSchema,
});

export const runtimePairInputSchema = z.object({
  pairingToken: z.string().trim().min(32),
  instanceKey: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(100),
  version: z.string().trim().max(40).default(""),
  deviceInfo: z.string().trim().max(240).default(""),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  maxConcurrency: z.coerce.number().int().min(1).max(32).default(1),
});

export const runtimeHeartbeatInputSchema = z.object({
  version: z.string().trim().max(40).optional(),
  deviceInfo: z.string().trim().max(240).optional(),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  maxConcurrency: z.coerce.number().int().min(1).max(32).optional(),
});

export const runtimeSessionCreateInputSchema = z
  .object({
    profileKey: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
      .optional(),
    profileMode: browserProfileModeSchema.default("EPHEMERAL"),
    purpose: z
      .enum([
        "EXECUTION",
        "PROFILE_PREPARATION",
        "PROFILE_VERIFICATION",
        "PROFILE_PURGE",
      ])
      .default("EXECUTION"),
    runtimeId: z.string().uuid(),
    userBrowserProfileId: z.string().uuid().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.profileMode === "PERSISTENT" &&
      !value.profileKey &&
      !value.userBrowserProfileId
    ) {
      context.addIssue({
        code: "custom",
        message:
          "profileKey or userBrowserProfileId is required for a persistent profile.",
        path: ["profileKey"],
      });
    }
    if (value.userBrowserProfileId && value.profileMode !== "PERSISTENT") {
      context.addIssue({
        code: "custom",
        message: "A user browser profile must use persistent mode.",
        path: ["profileMode"],
      });
    }
    if (value.userBrowserProfileId && value.profileKey) {
      context.addIssue({
        code: "custom",
        message: "Do not supply a raw profileKey with userBrowserProfileId.",
        path: ["profileKey"],
      });
    }
  });

export const consoleRuntimeCommandTypeSchema = runtimeCommandTypeSchema.exclude(
  ["session.open", "session.close", "human.takeover", "human.release"],
);

export const runtimeCommandInputSchema = protocolRuntimeCommandInputSchema;

export const humanControlInputSchema = z.object({
  ttlSeconds: z.coerce.number().int().min(30).max(3600).default(900),
});

export const resourceSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

export const testProjectStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);

export const testProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: resourceSlugSchema,
  description: z.string().trim().max(2000).default(""),
  status: testProjectStatusSchema.default("ACTIVE"),
});

export const environmentValueSchema = z.union([
  z.string().max(16_384),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const testEnvironmentInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: resourceSlugSchema,
  baseUrl: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine((value) => /^https?:\/\//iu.test(value), {
      message: "baseUrl must use http or https.",
    }),
  variables: z
    .record(z.string().trim().min(1).max(120), environmentValueSchema)
    .default({}),
  secrets: z
    .record(z.string().trim().min(1).max(120), z.string().min(1).max(16_384))
    .optional(),
  enabled: z.boolean().default(true),
});

export const testCaseStatusSchema = z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]);

export const testCaseInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: resourceSlugSchema,
  description: z.string().trim().max(4000).default(""),
  status: testCaseStatusSchema.default("DRAFT"),
});

const testStepIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);

const testSelectorSchema = z.string().trim().min(1).max(2048);
const testStepCommonShape = {
  id: testStepIdSchema,
  name: z.string().trim().min(1).max(200).optional(),
  timeoutSeconds: z.coerce.number().int().min(1).max(300).optional(),
};

export const testStepValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("LITERAL"), value: z.string().max(16_384) }),
  z.object({
    kind: z.literal("ENV_SECRET"),
    key: z.string().trim().min(1).max(120),
  }),
]);

export const testCaseStepSchema = z.discriminatedUnion("type", [
  z.object({
    ...testStepCommonShape,
    type: z.literal("browser.navigate"),
    url: z.string().trim().min(1).max(2048),
  }),
  z.object({
    ...testStepCommonShape,
    type: z.literal("browser.click"),
    selector: testSelectorSchema,
  }),
  z.object({
    ...testStepCommonShape,
    type: z.literal("browser.type"),
    selector: testSelectorSchema,
    value: testStepValueSchema,
    clear: z.boolean().default(true),
  }),
  z.object({
    ...testStepCommonShape,
    type: z.literal("browser.press"),
    key: z.string().trim().min(1).max(80),
    selector: testSelectorSchema.optional(),
  }),
  z.object({
    ...testStepCommonShape,
    type: z.literal("assert.url"),
    operator: z.enum(["EQUALS", "CONTAINS", "MATCHES"]),
    expected: z.string().max(2048),
  }),
  z.object({
    ...testStepCommonShape,
    type: z.literal("assert.text"),
    selector: testSelectorSchema,
    operator: z.enum(["EQUALS", "CONTAINS", "MATCHES"]),
    expected: z.string().max(16_384),
  }),
  z.object({
    ...testStepCommonShape,
    type: z.literal("capture"),
    kinds: z
      .array(z.enum(["SCREENSHOT", "DOM", "CONSOLE", "NETWORK"]))
      .min(1)
      .max(4),
  }),
  z.object({
    ...testStepCommonShape,
    type: z.literal("human.checkpoint"),
    prompt: z.string().trim().min(1).max(4000),
  }),
]);

const testCaseProfileSchema = z
  .object({
    mode: browserProfileModeSchema.default("EPHEMERAL"),
    key: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.mode === "PERSISTENT" && !value.key) {
      context.addIssue({
        code: "custom",
        message: "key is required for a persistent profile.",
        path: ["key"],
      });
    }
  });

export const testCaseDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    profile: testCaseProfileSchema.default({ mode: "EPHEMERAL" }),
    timeoutSeconds: z.coerce.number().int().min(30).max(86_400).default(900),
    steps: z.array(testCaseStepSchema).min(1).max(500),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        context.addIssue({
          code: "custom",
          message: "Step ids must be unique within a case version.",
          path: ["steps", index, "id"],
        });
      }
      seen.add(step.id);
    });
  });

export const testCaseVersionInputSchema = z.object({
  definition: testCaseDefinitionSchema,
  changeSummary: z.string().trim().max(2000).default(""),
});

export const testRunTriggerSchema = z.enum(["MANUAL", "CI", "REPLAY"]);

export const testRunCreateInputSchema = z.object({
  caseId: z.string().uuid(),
  caseVersionId: z.string().uuid().optional(),
  environmentId: z.string().uuid(),
  trigger: testRunTriggerSchema.default("MANUAL"),
  idempotencyKey: z.string().trim().min(1).max(160).optional(),
});

export const testTraceEventAppendInputSchema = z.object({
  actor: z.enum(["SYSTEM", "BROWSER", "HUMAN"]),
  kind: z.string().trim().min(1).max(120),
  status: z.enum(["STARTED", "SUCCEEDED", "FAILED", "SKIPPED"]),
  stepId: testStepIdSchema.optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  inputRef: z.string().trim().max(500).optional(),
  outputRef: z.string().trim().max(500).optional(),
  durationMs: z.coerce.number().int().min(0).max(86_400_000).optional(),
  errorCode: z.string().trim().max(120).optional(),
  errorMessage: z.string().trim().max(8000).optional(),
  occurredAt: z.coerce.date().optional(),
});

export const testRunArtifactLinkInputSchema = z
  .object({
    traceEventId: z.string().uuid().optional(),
    runtimeArtifactId: z.string().uuid().optional(),
    kind: z.string().trim().min(1).max(80),
    label: z.string().trim().max(200).default(""),
    storageKey: z.string().trim().min(1).max(1000).optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((value, context) => {
    if (!value.runtimeArtifactId && !value.storageKey) {
      context.addIssue({
        code: "custom",
        message: "runtimeArtifactId or storageKey is required.",
        path: ["runtimeArtifactId"],
      });
    }
  });

export const testRunCheckpointCreateInputSchema = z.object({
  traceEventId: z.string().uuid().optional(),
  stepId: testStepIdSchema,
  prompt: z.string().trim().min(1).max(4000),
  context: z.record(z.string(), z.unknown()).default({}),
  expiresAt: z.coerce.date().optional(),
});

export const testRunCheckpointResolveInputSchema = z.object({
  response: z.record(z.string(), z.unknown()).default({}),
});

export const toolCredentialScopeSchema = z.enum([
  "verification:read",
  "verification:write",
  "verification:cancel",
  "profile:delete",
  "run:read",
  "run:write",
  "run:cancel",
  "runtime:lease",
]);

const consoleToolCredentialScopeSchema = z.enum([
  "verification:read",
  "verification:write",
  "verification:cancel",
  "profile:delete",
  "run:read",
  "run:write",
  "run:cancel",
]);

export const toolCredentialCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(consoleToolCredentialScopeSchema)
    .min(1)
    .max(7)
    .default(["run:read", "run:write", "run:cancel"])
    .transform((scopes) => Array.from(new Set(scopes))),
  expiresAt: z.coerce.date().nullable().default(null),
});

export const runHitlPolicySchema = z.object({
  enabled: z.boolean().default(true),
  notificationChannels: z
    .array(z.enum(["FEISHU", "AGENT_WEBHOOK"]))
    .max(2)
    .default(["FEISHU"]),
  onTimeout: z.enum(["FAIL", "INCONCLUSIVE", "CANCEL"]).default("INCONCLUSIVE"),
  timeoutSeconds: z.coerce.number().int().min(30).max(604_800).default(3600),
});

const adaptiveRunDeadlinePolicyDefaults = {
  extensionStepSeconds: 180,
  finalizationReserveSeconds: 60,
  maxExtensionSeconds: 900,
  maxModelCallSeconds: 300,
  mode: "ADAPTIVE" as const,
  refundHumanWait: true,
  slowModelThresholdSeconds: 60,
};

export const runDeadlinePolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("FIXED") }),
  z.object({
    extensionStepSeconds: z.coerce.number().int().min(30).max(900).default(180),
    finalizationReserveSeconds: z.coerce
      .number()
      .int()
      .min(15)
      .max(300)
      .default(60),
    maxExtensionSeconds: z.coerce
      .number()
      .int()
      .min(60)
      .max(3_600)
      .default(900),
    maxModelCallSeconds: z.coerce.number().int().min(60).max(900).default(300),
    mode: z.literal("ADAPTIVE"),
    refundHumanWait: z.boolean().default(true),
    slowModelThresholdSeconds: z.coerce
      .number()
      .int()
      .min(15)
      .max(300)
      .default(60),
  }),
]);

export const executionRunCreateInputSchema = z
  .object({
    concurrencyPolicy: executionConcurrencyPolicySchema.optional(),
    businessReferences: z
      .array(runtimeBusinessReferenceSchema)
      .max(100)
      .default([]),
    browserPolicy: z
      .object({
        availabilityPolicy: z.enum(["WAIT", "FAIL_FAST"]).default("WAIT"),
        profile: z
          .object({
            key: z.string().trim().min(1).max(160).optional(),
            mode: browserProfileModeSchema.default("EPHEMERAL"),
          })
          .default({ mode: "EPHEMERAL" })
          .superRefine((value, context) => {
            if (value.mode === "PERSISTENT" && !value.key) {
              context.addIssue({
                code: "custom",
                message: "key is required for a persistent profile.",
                path: ["key"],
              });
            }
          }),
        requiredCapabilities: z
          .array(z.string().trim().min(1).max(120))
          .min(1)
          .max(50)
          .default(["browser"])
          .transform((values) => Array.from(new Set(values))),
      })
      .default({
        availabilityPolicy: "WAIT",
        profile: { mode: "EPHEMERAL" },
        requiredCapabilities: ["browser"],
      }),
    criteria: z.array(runtimeCriterionSchema).min(1).max(100),
    deadlineSeconds: z.number().int().min(30).max(86_400).default(900),
    deadlinePolicy: runDeadlinePolicySchema.default({ mode: "FIXED" }),
    environment: z.record(z.string(), z.unknown()).default({}),
    goal: z.string().trim().min(1).max(20_000),
    hitlPolicy: runHitlPolicySchema.default({
      enabled: true,
      notificationChannels: ["FEISHU"],
      onTimeout: "INCONCLUSIVE",
      timeoutSeconds: 3600,
    }),
    idempotencyKey: z.string().trim().min(8).max(200),
    model: z
      .object({
        name: z.string().trim().min(1).max(160),
        provider: executionAgentProviderSchema.default("CODEX"),
        reasoningEffort: z.string().trim().min(1).max(80).optional(),
      })
      .optional(),
    retryPolicy: z
      .object({
        maxAttempts: z.number().int().min(1).max(10).default(3),
        retryOn: z
          .array(runtimeFailureClassSchema)
          .max(7)
          .default([
            "TOOL_EXECUTION",
            "PROVIDER",
            "LIFECYCLE_PROTOCOL",
            "BROWSER_RUNTIME",
            "RUNTIME_LOST",
          ])
          .transform((values) => Array.from(new Set(values))),
      })
      .default({
        maxAttempts: 3,
        retryOn: [
          "TOOL_EXECUTION",
          "PROVIDER",
          "LIFECYCLE_PROTOCOL",
          "BROWSER_RUNTIME",
          "RUNTIME_LOST",
        ],
      }),
    source: z
      .object({
        id: z.string().trim().min(1).max(500).optional(),
        kind: z.string().trim().min(1).max(80).default("API"),
      })
      .default({ kind: "API" }),
  })
  .superRefine((value, context) => {
    const references = new Set<string>();
    value.businessReferences.forEach((reference, index) => {
      if (references.has(reference.externalId)) {
        context.addIssue({
          code: "custom",
          message: "Business reference externalIds must be unique.",
          path: ["businessReferences", index, "externalId"],
        });
      }
      references.add(reference.externalId);
      sensitivePaths(reference.metadata).forEach((path) =>
        context.addIssue({
          code: "custom",
          message: "Business reference metadata cannot contain credentials.",
          path: ["businessReferences", index, "metadata", ...path],
        }),
      );
    });
  });

export const runInterventionResolveInputSchema = z
  .object({ response: z.record(z.string(), z.unknown()).default({}) })
  .superRefine((value, context) => {
    sensitivePaths(value.response).forEach((path) =>
      context.addIssue({
        code: "custom",
        message: "HITL responses cannot contain inline credentials.",
        path: ["response", ...path],
      }),
    );
  });

export const runTrajectoryLaneSchema = z.enum([
  "INPUT",
  "ANALYSIS",
  "MODEL",
  "TOOLS",
]);
export const runTrajectoryRecordKindSchema = z.enum([
  "INPUT",
  "ANALYSIS",
  "MODEL",
  "TOOL",
  "RUNTIME",
]);
export const runTrajectoryStatusSchema = z.enum([
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "WAITING_HUMAN",
  "INFO",
]);

export const runTrajectoryRecordSchema = z.object({
  actor: z.string(),
  attemptNumber: z.number().int().positive().nullable(),
  callId: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  id: z.string(),
  input: z.unknown().nullable(),
  kind: runTrajectoryRecordKindSchema,
  lane: runTrajectoryLaneSchema,
  metadata: z.record(z.string(), z.unknown()),
  output: z.unknown().nullable(),
  segmentId: z.string().nullable(),
  sequence: z.string().regex(/^\d+$/u),
  startedAt: z.string().datetime(),
  status: runTrajectoryStatusSchema,
  step: z.number().int().positive().nullable(),
  title: z.string(),
});

export const runTrajectoryPageSchema = z.object({
  hasMore: z.boolean(),
  nextBefore: z.string().regex(/^\d+$/u).nullable(),
  records: z.array(runTrajectoryRecordSchema),
});

// User-visible task execution orchestration ---------------------------------

export const taskExecutionKindSchema = z.enum([
  "ISSUE_SPEC",
  "DIRECT_RUN",
  "LEGACY_RUN",
]);

export const taskExecutionLifecycleSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_HUMAN",
  "COMPLETED",
  "CANCELLED",
  "TIMED_OUT",
]);

export const taskExecutionStageTypeSchema = z.enum([
  "SPEC_ANALYSIS",
  "PROFILE_RESOLUTION",
  "SPEC_EXECUTION",
]);

export const taskExecutionStageStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "WAITING_INPUT",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
]);

const taskBrowserPolicySchema = z
  .object({
    availabilityPolicy: z.enum(["WAIT", "FAIL_FAST"]).default("WAIT"),
    profile: z
      .object({
        key: z.string().trim().min(1).max(160).optional(),
        mode: browserProfileModeSchema.default("EPHEMERAL"),
      })
      .default({ mode: "EPHEMERAL" })
      .superRefine((value, context) => {
        if (value.mode === "PERSISTENT" && !value.key) {
          context.addIssue({
            code: "custom",
            message: "key is required for a persistent profile.",
            path: ["key"],
          });
        }
      }),
    requiredCapabilities: z
      .array(z.string().trim().min(1).max(120))
      .min(1)
      .max(50)
      .default(["browser"])
      .transform((values) => Array.from(new Set(values))),
  })
  .default({
    availabilityPolicy: "WAIT",
    profile: { mode: "EPHEMERAL" },
    requiredCapabilities: ["browser"],
  });

export const browserProfileTriggerSourceSchema = z.enum([
  "CONSOLE",
  "FEISHU",
  "ISSUE_ASSIGNEE",
]);

export const userBrowserProfileStatusSchema = z.enum([
  "UNINITIALIZED",
  "PREPARING",
  "VERIFYING",
  "READY",
  "REAUTH_REQUIRED",
  "MIGRATION_REQUIRED",
  "LOST",
  "DISABLED",
]);

export const taskProfilePolicySchema = z
  .object({
    onUnavailable: z
      .enum(["WAIT_FOR_PROFILE", "FAIL", "USE_EPHEMERAL"])
      .default("WAIT_FOR_PROFILE"),
    profileId: z.string().uuid().optional(),
    scope: z
      .object({
        authRole: z.string().trim().min(1).max(100).default("default"),
        environmentKey: z.string().trim().min(1).max(160).default("default"),
        hostname: z.string().trim().min(1).max(253).toLowerCase().optional(),
      })
      .default({ authRole: "default", environmentKey: "default" }),
    strategy: z
      .enum(["EPHEMERAL", "REQUESTER", "ISSUE_ASSIGNEE", "EXPLICIT_PROFILE"])
      .default("EPHEMERAL"),
  })
  .default({
    onUnavailable: "WAIT_FOR_PROFILE",
    scope: { authRole: "default", environmentKey: "default" },
    strategy: "EPHEMERAL",
  })
  .superRefine((value, context) => {
    if (value.strategy === "EXPLICIT_PROFILE" && !value.profileId) {
      context.addIssue({
        code: "custom",
        message: "profileId is required for an explicit profile.",
        path: ["profileId"],
      });
    }
    if (value.strategy !== "EXPLICIT_PROFILE" && value.profileId) {
      context.addIssue({
        code: "custom",
        message: "profileId is only accepted for an explicit profile.",
        path: ["profileId"],
      });
    }
  });

const taskRetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).default(3),
    retryOn: z
      .array(runtimeFailureClassSchema)
      .max(7)
      .default([
        "TOOL_EXECUTION",
        "PROVIDER",
        "LIFECYCLE_PROTOCOL",
        "BROWSER_RUNTIME",
        "RUNTIME_LOST",
      ])
      .transform((values) => Array.from(new Set(values))),
  })
  .default({
    maxAttempts: 3,
    retryOn: [
      "TOOL_EXECUTION",
      "PROVIDER",
      "LIFECYCLE_PROTOCOL",
      "BROWSER_RUNTIME",
      "RUNTIME_LOST",
    ],
  });

export const taskDeploymentSchema = z.object({
  environment: z.record(z.string(), z.unknown()).default({}),
  key: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
  name: z.string().trim().min(1).max(200),
  targetUrl: z
    .string()
    .trim()
    .url()
    .max(2_000)
    .refine((value) => /^https?:\/\//u.test(value), {
      message: "targetUrl must use http or https.",
    })
    .refine((value) => !/^https?:\/\/[^/?#]*@/iu.test(value), {
      message: "targetUrl cannot contain URL credentials.",
    }),
});

const issueTaskExecutionCreateInputSchema = z.object({
  analysisMaxAttempts: z.number().int().min(1).max(10).default(3),
  browserPolicy: taskBrowserPolicySchema,
  deadlineSeconds: z.number().int().min(60).max(86_400).default(7_200),
  deployments: z
    .array(taskDeploymentSchema)
    .max(20)
    .default([])
    .superRefine((deployments, context) => {
      const keys = new Set<string>();
      for (const [index, deployment] of deployments.entries()) {
        if (keys.has(deployment.key)) {
          context.addIssue({
            code: "custom",
            message: "Deployment keys must be unique within an Issue task.",
            path: [index, "key"],
          });
        }
        keys.add(deployment.key);
      }
    }),
  hitlPolicy: runHitlPolicySchema.default({
    enabled: true,
    notificationChannels: ["FEISHU"],
    onTimeout: "INCONCLUSIVE",
    timeoutSeconds: 3600,
  }),
  idempotencyKey: z.string().trim().min(8).max(200),
  issueRef: z.string().trim().min(1).max(500),
  kind: z.literal("ISSUE_SPEC"),
  model: z
    .object({
      name: z.string().trim().min(1).max(160),
      provider: executionAgentProviderSchema.default("CODEX"),
      reasoningEffort: z.string().trim().min(1).max(80).optional(),
    })
    .optional(),
  caseExecutionPolicies: z
    .record(z.string().min(1).max(100), executionConcurrencyPolicySchema)
    .optional(),
  casePolicyReviewRequired: z.boolean().optional(),
  profilePolicy: taskProfilePolicySchema,
  retryPolicy: taskRetryPolicySchema,
  runDeadlinePolicy: runDeadlinePolicySchema.default(
    adaptiveRunDeadlinePolicyDefaults,
  ),
  targetUrl: z
    .string()
    .trim()
    .url()
    .max(2_000)
    .refine((value) => /^https?:\/\//u.test(value), {
      message: "targetUrl must use http or https.",
    })
    .refine((value) => !/^https?:\/\/[^/?#]*@/iu.test(value), {
      message: "targetUrl cannot contain URL credentials.",
    })
    .optional(),
});

const directTaskExecutionCreateInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  kind: z.literal("DIRECT_RUN"),
  run: executionRunCreateInputSchema,
});

export const taskExecutionCreateInputSchema = z.discriminatedUnion("kind", [
  issueTaskExecutionCreateInputSchema,
  directTaskExecutionCreateInputSchema,
]);

export const taskDeploymentTargetInputSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .max(2_000)
    .refine((value) => /^https?:\/\//u.test(value), {
      message: "url must use http or https.",
    })
    .refine((value) => !/^https?:\/\/[^/?#]*@/iu.test(value), {
      message: "url cannot contain URL credentials.",
    }),
});

export const taskDeploymentsInputSchema = z.object({
  deployments: z.array(taskDeploymentSchema).min(1).max(20),
});

export const taskStageRetryInputSchema = z.object({
  reason: z.string().trim().max(1_000).default("manual retry"),
});

// Issue-first specification generation ---------------------------------------

export const specificationIssueContextSchema = z.object({
  assignee: z
    .object({
      email: z.string().trim().email().max(320).nullable().default(null),
      externalId: z.string().trim().min(1).max(200),
      issuerKey: z.string().trim().min(1).max(200).nullable().default(null),
      name: z.string().trim().min(1).max(500),
      type: z.enum(["HUMAN", "AGENT"]).default("HUMAN"),
    })
    .nullable()
    .default(null),
  description: z.string().default(""),
  id: z.string().trim().min(1).max(200),
  identifier: z.string().trim().min(1).max(100),
  labels: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  priority: z.number().int().min(0).max(4).nullable().default(null),
  state: z.string().max(100).default(""),
  title: z.string().trim().min(1).max(500),
  url: z.string().url().max(2_000),
});

export const specificationPullRequestContextSchema = z.object({
  additions: z.number().int().nonnegative().default(0),
  baseRef: z.string().trim().min(1).max(500).default("unknown"),
  body: z.string().max(100_000).default(""),
  changedFiles: z
    .array(z.string().trim().min(1).max(2_000))
    .max(1_000)
    .default([]),
  checks: z
    .array(
      z.object({
        conclusion: z.string().max(100).nullable().default(null),
        detailsUrl: z.string().url().nullable().default(null),
        name: z.string().trim().min(1).max(500),
        status: z.string().trim().min(1).max(100),
      }),
    )
    .max(200)
    .default([]),
  commits: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  deploymentUrl: z.string().url().nullable().default(null),
  headRef: z.string().trim().min(1).max(500).default("unknown"),
  headSha: z.string().trim().min(1).max(100).default("unknown"),
  id: z.string().trim().min(1).max(200),
  isPrimary: z.boolean().default(false),
  number: z.number().int().positive(),
  organization: z.string().trim().min(1).max(500),
  repository: z.string().trim().min(1).max(500),
  status: z.enum(["DRAFT", "OPEN", "MERGED", "CLOSED"]).default("OPEN"),
  title: z.string().trim().min(1).max(500),
  url: z.string().url().max(2_000),
});

export const specificationKnowledgeContextSchema = z.object({
  content: z.string().trim().min(1).max(100_000),
  id: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  updatedAt: z.string().datetime().nullable().default(null),
  url: z.string().url().nullable().default(null),
});

export const specificationContextDiagnosticSchema = z.object({
  code: z.string().trim().min(1).max(100),
  level: z.enum(["INFO", "WARNING", "ERROR"]),
  message: z.string().trim().min(1).max(2_000),
  reference: z.string().max(2_000).nullable().default(null),
  source: z.enum(["LINEAR", "GITHUB", "KNOWLEDGE"]),
});

export const testGenerationContextSchema = z
  .object({
    issue: specificationIssueContextSchema,
    knowledge: z
      .array(specificationKnowledgeContextSchema)
      .max(100)
      .default([]),
    pullRequests: z
      .array(specificationPullRequestContextSchema)
      .max(100)
      .default([]),
    resolution: z
      .object({
        completeness: z.enum(["COMPLETE", "PARTIAL"]).default("COMPLETE"),
        diagnostics: z
          .array(specificationContextDiagnosticSchema)
          .max(500)
          .default([]),
      })
      .default({ completeness: "COMPLETE", diagnostics: [] }),
  })
  .transform((context) => ({
    ...context,
    issue: {
      ...context.issue,
      labels: [...new Set(context.issue.labels)].sort((left, right) =>
        left.localeCompare(right),
      ),
    },
    knowledge: [...context.knowledge].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    pullRequests: context.pullRequests
      .map((pullRequest) => ({
        ...pullRequest,
        changedFiles: [...new Set(pullRequest.changedFiles)].sort(
          (left, right) => left.localeCompare(right),
        ),
        checks: [...pullRequest.checks].sort((left, right) =>
          `${left.name}:${left.detailsUrl ?? ""}`.localeCompare(
            `${right.name}:${right.detailsUrl ?? ""}`,
          ),
        ),
      }))
      .sort((left, right) => {
        if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
        return left.url.localeCompare(right.url);
      }),
    resolution: {
      ...context.resolution,
      diagnostics: [...context.resolution.diagnostics].sort((left, right) =>
        `${left.source}:${left.code}:${left.reference ?? ""}`.localeCompare(
          `${right.source}:${right.code}:${right.reference ?? ""}`,
        ),
      ),
    },
  }));

export const generatedTestEvidenceRequirementSchema = z.object({
  description: z.string().trim().min(1).max(2_000),
  kind: z.enum([
    "SCREENSHOT",
    "DOM",
    "NETWORK",
    "CONSOLE",
    "BUSINESS_REFERENCE",
    "ARTIFACT",
  ]),
});

export const generatedTestCaseDefinitionSchema = z.object({
  authRole: z.string().trim().min(1).max(120).default("default"),
  evidence: z.array(generatedTestEvidenceRequirementSchema).min(1).max(50),
  expected: z.array(z.string().trim().min(1).max(5_000)).min(1).max(100),
  name: z.string().trim().min(1).max(500),
  preconditions: z.array(z.string().trim().min(1).max(5_000)).min(1).max(100),
  rationale: z.string().trim().min(1).max(5_000),
  steps: z
    .array(
      z.object({
        action: z.string().trim().min(1).max(5_000),
        order: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(100),
});

export const specificationSyncInputSchema = z.object({
  context: testGenerationContextSchema,
  forceRegeneration: z.boolean().default(false),
});

export const specificationResolveInputSchema = z.object({
  issueRef: z.string().trim().min(1).max(500),
});

export const specificationDeploymentTargetInputSchema = z.object({
  url: z.string().url().max(2_000),
});

export const specificationPlaygroundInputSchema = z
  .object({
    casePolicyReviewRequired: z.boolean().optional(),
    deployments: z.array(taskDeploymentSchema).max(20).default([]),
    issueRef: z.string().trim().min(1).max(500),
    profilePolicy: taskProfilePolicySchema,
    submissionId: z.string().uuid(),
    targetUrl: z.string().url().max(2_000).optional(),
  })
  .superRefine((input, context) => {
    const keys = new Set<string>();
    for (const [index, deployment] of input.deployments.entries()) {
      if (keys.has(deployment.key)) {
        context.addIssue({
          code: "custom",
          message: "Deployment keys must be unique.",
          path: ["deployments", index, "key"],
        });
      }
      keys.add(deployment.key);
    }
  });

export type SpecificationIssueContext = z.infer<
  typeof specificationIssueContextSchema
>;
export type SpecificationPullRequestContext = z.infer<
  typeof specificationPullRequestContextSchema
>;
export type SpecificationKnowledgeContext = z.infer<
  typeof specificationKnowledgeContextSchema
>;
export type SpecificationContextDiagnostic = z.infer<
  typeof specificationContextDiagnosticSchema
>;
export type TestGenerationContext = z.infer<typeof testGenerationContextSchema>;
export type GeneratedTestCaseDefinition = z.infer<
  typeof generatedTestCaseDefinitionSchema
>;
export type SpecificationSyncInput = z.infer<
  typeof specificationSyncInputSchema
>;
export type SpecificationResolveInput = z.infer<
  typeof specificationResolveInputSchema
>;
export type SpecificationDeploymentTargetInput = z.infer<
  typeof specificationDeploymentTargetInputSchema
>;
export type SpecificationPlaygroundInput = z.infer<
  typeof specificationPlaygroundInputSchema
>;

export const agentRuntimeProviderSchema = z.enum([
  "OPENAI",
  "CODEX",
  "CLAUDE",
  "CUSTOM",
  "GENERIC",
]);

export const verificationRunStatusSchema = z.enum([
  "QUEUED",
  "WAITING_EXECUTION",
  "RUNNING",
  "WAITING_HUMAN",
  "PASSED",
  "FAILED",
  "INCONCLUSIVE",
  "CANCELLED",
  "TIMED_OUT",
]);

export const verificationEventActorSchema = z.enum([
  "SYSTEM",
  "AGENT",
  "RUNNER",
  "HUMAN",
  "WORKER",
]);

export const verificationEventKindSchema = z.enum([
  "verification.created",
  "verification.started",
  "verification.resumed",
  "verification.completed",
  "verification.cancelled",
  "verification.timed_out",
  "verification.failed",
  "agent.runtime.started",
  "agent.runtime.resumed",
  "agent.runtime.paused",
  "agent.runtime.completed",
  "agent.runtime.failed",
  "execution.waiting",
  "execution.acquired",
  "execution.acquire.failed",
  "execution.command.started",
  "execution.command.completed",
  "execution.released",
  "hitl.requested",
  "hitl.resolved",
  "hitl.expired",
  "notification.enqueued",
  "notification.delivered",
  "notification.failed",
]);

export const verificationCriterionSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
  description: z.string().trim().min(1).max(2000),
  required: z.boolean().default(true),
});

export const verificationAgentRuntimeSchema = z.object({
  provider: agentRuntimeProviderSchema.default("GENERIC"),
  externalRunId: z.string().trim().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const MIN_VERIFICATION_ACQUIRE_TIMEOUT_SECONDS = 120;
export const MIN_VERIFICATION_RUN_TIMEOUT_SECONDS = 120;

export const verificationExecutionSchema = z.object({
  availabilityPolicy: z.enum(["WAIT", "FAIL_FAST"]).default("WAIT"),
  acquireTimeoutSeconds: z.coerce
    .number()
    .int()
    .min(5)
    .max(3600)
    .default(300)
    .transform((seconds) =>
      Math.max(seconds, MIN_VERIFICATION_ACQUIRE_TIMEOUT_SECONDS),
    )
    .describe(
      "Execution acquisition timeout. Values below 120 seconds are normalized to 120 seconds.",
    ),
  runTimeoutSeconds: z.coerce
    .number()
    .int()
    .min(30)
    .max(86_400)
    .default(1800)
    .transform((seconds) =>
      Math.max(seconds, MIN_VERIFICATION_RUN_TIMEOUT_SECONDS),
    )
    .describe(
      "Browser verification timeout. Values below 120 seconds are normalized to 120 seconds.",
    ),
  environmentRef: z.string().trim().min(1).max(500).optional(),
  requiredCapabilities: z
    .array(z.string().trim().min(1).max(120))
    .max(50)
    .default([])
    .transform((capabilities) => Array.from(new Set(capabilities))),
  profile: z
    .object({
      key: z
        .string()
        .trim()
        .min(1)
        .max(160)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
        .optional(),
      mode: browserProfileModeSchema.default("EPHEMERAL"),
    })
    .default({ mode: "EPHEMERAL" })
    .superRefine((value, context) => {
      if (value.mode === "PERSISTENT" && !value.key) {
        context.addIssue({
          code: "custom",
          message: "key is required for a persistent profile.",
          path: ["key"],
        });
      }
    }),
  runnerId: z.never().optional(),
  targetUrl: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine((value) => /^https?:\/\//iu.test(value), {
      message: "targetUrl must use http or https.",
    })
    .refine((value) => !/^https?:\/\/[^/?#]*@/iu.test(value), {
      message: "targetUrl cannot contain URL credentials.",
    })
    .optional(),
});

export const verificationEvidencePolicySchema = z.object({
  requiredKinds: z
    .array(z.string().trim().min(1).max(80))
    .max(50)
    .default([])
    .transform((kinds) => Array.from(new Set(kinds))),
  retentionDays: z.coerce.number().int().min(1).max(3650).default(90),
});

export const verificationHitlPolicySchema = runHitlPolicySchema;

export const playgroundRunInputSchema = z.object({
  acceptanceCriterion: z.string().trim().min(1).max(2000),
  goal: z.string().trim().min(1).max(8000),
  hitlEnabled: z.boolean().default(false),
  submissionId: z.string().uuid(),
  targetUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => /^https?:\/\//u.test(value), {
      message: "targetUrl must use http or https.",
    })
    .refine((value) => !/^https?:\/\/[^/?#]*@/iu.test(value), {
      message: "targetUrl cannot contain URL credentials.",
    }),
});

export const verificationRequestSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    mode: z.enum(["BROWSE", "TEST"]).default("BROWSE"),
    goal: z.string().trim().min(1).max(8000),
    acceptanceCriteria: z.array(verificationCriterionSchema).min(1).max(100),
    agentRuntime: verificationAgentRuntimeSchema.default({
      provider: "GENERIC",
      metadata: {},
    }),
    execution: verificationExecutionSchema.default({
      availabilityPolicy: "WAIT",
      acquireTimeoutSeconds: 300,
      profile: { mode: "EPHEMERAL" },
      requiredCapabilities: [],
      runTimeoutSeconds: 1800,
    }),
    inputs: z.record(z.string(), z.unknown()).default({}),
    secretRefs: z
      .record(
        z
          .string()
          .trim()
          .min(1)
          .max(120)
          .regex(/^[A-Z][A-Z0-9_]*$/u),
        z.string().trim().min(1).max(500),
      )
      .default({}),
    evidencePolicy: verificationEvidencePolicySchema.default({
      requiredKinds: [],
      retentionDays: 90,
    }),
    hitlPolicy: verificationHitlPolicySchema.default({
      enabled: true,
      notificationChannels: ["FEISHU"],
      onTimeout: "INCONCLUSIVE",
      timeoutSeconds: 3600,
    }),
    idempotencyKey: z.string().trim().min(1).max(160),
  })
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.acceptanceCriteria.forEach((criterion, index) => {
      if (ids.has(criterion.id)) {
        context.addIssue({
          code: "custom",
          message: "Acceptance criterion ids must be unique.",
          path: ["acceptanceCriteria", index, "id"],
        });
      }
      ids.add(criterion.id);
    });
    if (value.execution.requiredCapabilities.length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one required capability is required.",
        path: ["execution", "requiredCapabilities"],
      });
    }
    sensitivePaths(value.inputs).forEach((path) => {
      context.addIssue({
        code: "custom",
        message:
          "Verification inputs cannot contain inline credentials; use secretRefs.",
        path: ["inputs", ...path],
      });
    });
    sensitivePaths(value.agentRuntime.metadata).forEach((path) => {
      context.addIssue({
        code: "custom",
        message: "Agent metadata cannot contain inline credentials.",
        path: ["agentRuntime", "metadata", ...path],
      });
    });
  });

export const verificationEvidenceRefSchema = z
  .string()
  .trim()
  .regex(
    /^artifact:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
    "Evidence references must use artifact://<verification-artifact-uuid>.",
  );

export const verificationResultSchema = z.object({
  verdict: z.enum(["PASSED", "FAILED", "INCONCLUSIVE"]),
  summary: z.string().trim().min(1).max(8000),
  criteria: z
    .array(
      z.object({
        criterionId: z.string().trim().min(1).max(80),
        evidenceRefs: z.array(verificationEvidenceRefSchema).max(100),
        status: z.enum(["PASSED", "FAILED", "INCONCLUSIVE"]),
        summary: z.string().trim().min(1).max(4000),
      }),
    )
    .max(100),
  evidenceRefs: z.array(verificationEvidenceRefSchema).max(500).default([]),
});

export const verificationAssertionRecordSchema = z.object({
  criterionId: z.string().trim().min(1).max(80),
  evidenceRefs: z.array(verificationEvidenceRefSchema).max(100).default([]),
  status: z.enum(["PASSED", "FAILED", "INCONCLUSIVE"]),
  summary: z.string().trim().min(1).max(4000),
});

export const verificationEventAppendInputSchema = z
  .object({
    kind: z
      .union([verificationEventKindSchema, z.string().trim().min(1).max(120)])
      .refine((value) => /^[a-z][a-z0-9_.-]+$/u.test(value), {
        message: "Event kind must be a lowercase dot-separated identifier.",
      }),
    payload: z.record(z.string(), z.unknown()).default({}),
    status: z
      .enum([
        "INFO",
        "STARTED",
        "SUCCEEDED",
        "FAILED",
        "CANCELLED",
        "TIMED_OUT",
      ])
      .default("INFO"),
    durationMs: z.coerce.number().int().min(0).max(86_400_000).optional(),
    errorCode: z.string().trim().min(1).max(120).optional(),
    errorMessage: z.string().trim().min(1).max(4_000).optional(),
    occurredAt: z.coerce.date().optional(),
  })
  .superRefine((value, context) => {
    sensitivePaths(value.payload).forEach((path) =>
      context.addIssue({
        code: "custom",
        message: "Verification events cannot contain inline credentials.",
        path: ["payload", ...path],
      }),
    );
  });

export const verificationCompleteInputSchema = z.object({
  result: verificationResultSchema,
});

export const verificationCheckpointCreateInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(8000),
    context: z.record(z.string(), z.unknown()).default({}),
    responseSchema: z.record(z.string(), z.unknown()).default({}),
    timeoutSeconds: z.coerce.number().int().min(30).max(604_800).optional(),
  })
  .superRefine((value, context) => {
    sensitivePaths(value.context).forEach((path) =>
      context.addIssue({
        code: "custom",
        message: "HITL context cannot contain inline credentials.",
        path: ["context", ...path],
      }),
    );
  });

export const verificationCheckpointResolveInputSchema = z
  .object({ response: z.record(z.string(), z.unknown()) })
  .superRefine((value, context) => {
    sensitivePaths(value.response).forEach((path) =>
      context.addIssue({
        code: "custom",
        message: "HITL responses cannot contain inline credentials.",
        path: ["response", ...path],
      }),
    );
  });

export const verificationExecutionAcquireInputSchema = z
  .object({
    profileMode: browserProfileModeSchema.default("EPHEMERAL"),
    profileKey: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.profileMode === "PERSISTENT" && !value.profileKey) {
      context.addIssue({
        code: "custom",
        message: "profileKey is required for a persistent profile.",
        path: ["profileKey"],
      });
    }
  });

export const browserProfilePurgeInputSchema = z.object({
  profileKey: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
});

const userBrowserProfileVerificationRulesSchema = z
  .object({
    authenticatedSelector: z.string().trim().min(1).max(500).optional(),
    loginUrlPatterns: z
      .array(z.string().trim().min(1).max(500))
      .max(20)
      .default([]),
    successUrlPatterns: z
      .array(z.string().trim().min(1).max(500))
      .max(20)
      .default([]),
  })
  .superRefine((value, context) => {
    if (!value.authenticatedSelector && value.successUrlPatterns.length === 0) {
      context.addIssue({
        code: "custom",
        message:
          "At least one authenticatedSelector or successUrlPattern is required.",
        path: ["successUrlPatterns"],
      });
    }
  });

const userBrowserProfileVerificationUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_000)
  .refine((value) => /^https?:\/\//u.test(value), {
    message: "verificationUrl must use http or https.",
  })
  .refine((value) => !/^https?:\/\/[^/?#]*@/iu.test(value), {
    message: "verificationUrl cannot contain URL credentials.",
  });

export const userBrowserProfileCreateInputSchema = z.object({
  executionMode: userBrowserProfileExecutionModeSchema.optional(),
  executionConcurrency: z.number().int().min(1).max(4).optional(),
  authRole: z.string().trim().min(1).max(100).default("default"),
  displayName: z.string().trim().min(1).max(160),
  environmentKey: z.string().trim().min(1).max(160).default("default"),
  grants: z
    .array(browserProfileTriggerSourceSchema)
    .min(1)
    .max(3)
    .default(["CONSOLE"])
    .transform((values) => [...new Set(values)]),
  runtimeId: z.string().uuid().optional(),
  verificationRules: userBrowserProfileVerificationRulesSchema,
  verificationUrl: userBrowserProfileVerificationUrlSchema,
});

export const userBrowserProfileUpdateInputSchema = z
  .object({
    executionMode: userBrowserProfileExecutionModeSchema.optional(),
    executionConcurrency: z.number().int().min(1).max(4).optional(),
    displayName: z.string().trim().min(1).max(160).optional(),
    grants: z
      .array(browserProfileTriggerSourceSchema)
      .min(1)
      .max(3)
      .transform((values) => [...new Set(values)])
      .optional(),
    verificationRules: userBrowserProfileVerificationRulesSchema.optional(),
    verificationUrl: userBrowserProfileVerificationUrlSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one profile field must be updated.",
  });

export const userBrowserProfilePrepareInputSchema = z.object({
  runtimeId: z.string().uuid().optional(),
  ttlSeconds: z.coerce.number().int().min(60).max(3_600).default(900),
});

export const userBrowserProfileVerifyInputSchema = z
  .object({ prepareIsolatedAuth: z.boolean().default(false) })
  .strict();

export const taskProfileSelectionInputSchema = z.object({
  profilePolicy: taskProfilePolicySchema,
});

export type RuntimeSettingsInput = z.infer<typeof runtimeSettingsInputSchema>;
export type GithubAccessCredentialCreateInput = z.infer<
  typeof githubAccessCredentialCreateInputSchema
>;
export type GithubAccessCredentialUpdateInput = z.infer<
  typeof githubAccessCredentialUpdateInputSchema
>;
export type AgentModelConfigurationCreateInput = z.infer<
  typeof agentModelConfigurationCreateInputSchema
>;
export type AgentModelConfigurationUpdateInput = z.infer<
  typeof agentModelConfigurationUpdateInputSchema
>;
export type AgentModelConfigurationOrderInput = z.infer<
  typeof agentModelConfigurationOrderInputSchema
>;
export type AgentModelPool = z.infer<typeof agentModelPoolSchema>;
export type BrowserProfilePurgeInput = z.infer<
  typeof browserProfilePurgeInputSchema
>;
export type UserBrowserProfileCreateInput = z.infer<
  typeof userBrowserProfileCreateInputSchema
>;
export type UserBrowserProfileUpdateInput = z.infer<
  typeof userBrowserProfileUpdateInputSchema
>;
export type UserBrowserProfilePrepareInput = z.infer<
  typeof userBrowserProfilePrepareInputSchema
>;
export type UserBrowserProfileVerifyInput = z.infer<
  typeof userBrowserProfileVerifyInputSchema
>;
export type TaskProfilePolicy = z.infer<typeof taskProfilePolicySchema>;
export type TaskProfileSelectionInput = z.infer<
  typeof taskProfileSelectionInputSchema
>;
export type RuntimeRoutingFallbackPolicy = z.infer<
  typeof runtimeRoutingFallbackPolicySchema
>;
export type RuntimeRoutingRuleInput = z.infer<
  typeof runtimeRoutingRuleInputSchema
>;
export type RuntimeConfigurationInput = z.infer<
  typeof runtimeConfigurationInputSchema
>;
export type PlaygroundRunInput = z.infer<typeof playgroundRunInputSchema>;
export type RuntimePairInput = z.infer<typeof runtimePairInputSchema>;
export type RuntimeHeartbeatInput = z.infer<typeof runtimeHeartbeatInputSchema>;
export type RuntimeSessionCreateInput = z.infer<
  typeof runtimeSessionCreateInputSchema
>;
export type RuntimeCommandInput = z.infer<typeof runtimeCommandInputSchema>;
export type HumanControlInput = z.infer<typeof humanControlInputSchema>;
export type TestProjectInput = z.infer<typeof testProjectInputSchema>;
export type TestEnvironmentInput = z.infer<typeof testEnvironmentInputSchema>;
export type TestCaseInput = z.infer<typeof testCaseInputSchema>;
export type TestCaseDefinition = z.infer<typeof testCaseDefinitionSchema>;
export type TestCaseVersionInput = z.infer<typeof testCaseVersionInputSchema>;
export type TestRunCreateInput = z.infer<typeof testRunCreateInputSchema>;
export type TestTraceEventAppendInput = z.infer<
  typeof testTraceEventAppendInputSchema
>;
export type TestRunArtifactLinkInput = z.infer<
  typeof testRunArtifactLinkInputSchema
>;
export type TestRunCheckpointCreateInput = z.infer<
  typeof testRunCheckpointCreateInputSchema
>;
export type TestRunCheckpointResolveInput = z.infer<
  typeof testRunCheckpointResolveInputSchema
>;
export type ToolCredentialScope = z.infer<typeof toolCredentialScopeSchema>;
export type ToolCredentialCreateInput = z.infer<
  typeof toolCredentialCreateInputSchema
>;
export type ExecutionRunCreateInput = z.infer<
  typeof executionRunCreateInputSchema
>;
export type RunInterventionResolveInput = z.infer<
  typeof runInterventionResolveInputSchema
>;
export type RunTrajectoryRecord = z.infer<typeof runTrajectoryRecordSchema>;
export type RunTrajectoryPage = z.infer<typeof runTrajectoryPageSchema>;
export type TaskExecutionCreateInput = z.infer<
  typeof taskExecutionCreateInputSchema
>;
export type TaskDeploymentTargetInput = z.infer<
  typeof taskDeploymentTargetInputSchema
>;
export type TaskDeployment = z.infer<typeof taskDeploymentSchema>;
export type TaskDeploymentsInput = z.infer<typeof taskDeploymentsInputSchema>;
export type TaskStageRetryInput = z.infer<typeof taskStageRetryInputSchema>;
export type AgentRuntimeProvider = z.infer<typeof agentRuntimeProviderSchema>;
export type VerificationRunStatus = z.infer<typeof verificationRunStatusSchema>;
export type VerificationRequest = z.infer<typeof verificationRequestSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type VerificationAssertionRecord = z.infer<
  typeof verificationAssertionRecordSchema
>;
export type VerificationEventAppendInput = z.infer<
  typeof verificationEventAppendInputSchema
>;
export type VerificationCompleteInput = z.infer<
  typeof verificationCompleteInputSchema
>;
export type VerificationCheckpointCreateInput = z.infer<
  typeof verificationCheckpointCreateInputSchema
>;
export type VerificationCheckpointResolveInput = z.infer<
  typeof verificationCheckpointResolveInputSchema
>;
export type VerificationExecutionAcquireInput = z.infer<
  typeof verificationExecutionAcquireInputSchema
>;
