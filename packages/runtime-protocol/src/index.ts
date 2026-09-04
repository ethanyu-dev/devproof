import { z } from "zod";

export const RUNTIME_PROTOCOL = {
  major: 1,
  minor: 13,
  name: "devproof-browser-runtime",
} as const;
export const RUNTIME_SESSION_PERMIT_MINOR = 13;
export const RUNTIME_CAPABILITIES = [
  "browser",
  "auth-snapshot-v1",
  "session-permits-v1",
] as const;

export const authSnapshotReferenceSchema = z
  .object({
    profileKey: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
    generation: z.number().int().positive().safe(),
  })
  .strict();

/** Two owners must remain valid: the browser session and its active executor. */
export const runtimeSessionPermitSchema = z
  .object({
    sessionId: z.string().uuid(),
    fencingToken: z.string().regex(/^\d+$/u),
    leaseToken: z.string().uuid(),
    ownerKind: z.enum(["STARTUP", "AGENT", "HUMAN", "SYSTEM"]),
    ownerTaskId: z.string().uuid().optional(),
    ownerFencingToken: z.string().regex(/^\d+$/u).optional(),
    controlGeneration: z.number().int().nonnegative().optional(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.ownerKind === "AGENT" &&
      (!value.ownerTaskId || !value.ownerFencingToken)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "AGENT permits require an executor identity and fencing token.",
        path: ["ownerTaskId"],
      });
    }
  });
export type RuntimeSessionPermit = z.infer<typeof runtimeSessionPermitSchema>;
export type AuthSnapshotReference = z.infer<typeof authSnapshotReferenceSchema>;

export const USER_PROFILE_INACTIVITY_TTL_SECONDS = 30 * 24 * 60 * 60;

export const RUNTIME_HEARTBEAT_INTERVAL_MS = 15_000;
export const RUNTIME_PREAUTH_TIMEOUT_MS = 10_000;
export const RUNTIME_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const RUNTIME_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const BROWSER_HUMAN_INPUT_LIMITS = {
  maxBatchEvents: 32,
  maxKeyLength: 64,
  maxTextLength: 2_048,
  maxWheelDelta: 2_000,
} as const;

const normalizedCoordinateSchema = z.number().finite().min(0).max(1);

export const browserHumanInputEventSchema = z.discriminatedUnion("type", [
  z.object({
    key: z.string().min(1).max(BROWSER_HUMAN_INPUT_LIMITS.maxKeyLength),
    phase: z.enum(["down", "up"]),
    type: z.literal("key"),
  }),
  z.object({
    button: z.enum(["left", "middle", "none", "right"]),
    phase: z.enum(["down", "move", "up"]),
    type: z.literal("pointer"),
    x: normalizedCoordinateSchema,
    y: normalizedCoordinateSchema,
  }),
  z.object({ type: z.literal("release") }),
  z.object({
    text: z.string().min(1).max(BROWSER_HUMAN_INPUT_LIMITS.maxTextLength),
    type: z.literal("text"),
  }),
  z.object({
    deltaX: z
      .number()
      .finite()
      .min(-BROWSER_HUMAN_INPUT_LIMITS.maxWheelDelta)
      .max(BROWSER_HUMAN_INPUT_LIMITS.maxWheelDelta),
    deltaY: z
      .number()
      .finite()
      .min(-BROWSER_HUMAN_INPUT_LIMITS.maxWheelDelta)
      .max(BROWSER_HUMAN_INPUT_LIMITS.maxWheelDelta),
    type: z.literal("wheel"),
    x: normalizedCoordinateSchema,
    y: normalizedCoordinateSchema,
  }),
]);

export const browserHumanInputEventsSchema = z
  .array(browserHumanInputEventSchema)
  .min(1)
  .max(BROWSER_HUMAN_INPUT_LIMITS.maxBatchEvents);

export const runtimeProtocolVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  name: z.literal(RUNTIME_PROTOCOL.name),
});

export const runtimeNetworkAllowlistEntrySchema = z
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

export const runtimeNetworkAllowlistSchema = z
  .array(runtimeNetworkAllowlistEntrySchema)
  .max(128)
  .transform((entries) => [...new Set(entries)]);

export const userProfileRetentionSchema = z
  .object({
    // Accepted only so a rolling upgrade can read sessions persisted by an
    // older Runtime. Profile retention no longer carries a network policy.
    allowedHostnamePatterns: z
      .array(runtimeNetworkAllowlistEntrySchema)
      .max(50)
      .optional(),
    inactivityTtlSeconds: z.literal(USER_PROFILE_INACTIVITY_TTL_SECONDS),
    kind: z.literal("USER"),
  })
  .strict();

export const localRuntimeSessionSchema = z
  .object({
    live: z.boolean().optional(),
    authSnapshot: authSnapshotReferenceSchema.optional(),
    permit: runtimeSessionPermitSchema.optional(),
    fencingToken: z.string().regex(/^\d+$/u),
    leaseToken: z.string().uuid(),
    profileKey: z.string().min(1).max(160),
    profileMode: z.enum(["PERSISTENT", "EPHEMERAL"]),
    profileRetention: userProfileRetentionSchema.optional(),
    sessionId: z.string().uuid(),
    state: z.enum(["OPEN", "HUMAN_CONTROL", "INTERRUPTED"]),
  })
  .superRefine((value, context) => {
    if (value.profileRetention && value.profileMode !== "PERSISTENT") {
      context.addIssue({
        code: "custom",
        message: "User Profile retention requires PERSISTENT profile mode.",
        path: ["profileRetention"],
      });
    }
  });

export const runtimeHelloSchema = z.object({
  capabilities: z.array(z.string().min(1).max(120)).max(32).optional(),
  activeSessions: z.array(localRuntimeSessionSchema).max(64).default([]),
  instanceNonce: z.string().min(16).max(160),
  protocol: runtimeProtocolVersionSchema,
  runtimeId: z.string().uuid(),
  runtimeToken: z.string().min(32).max(512),
  sentAt: z.string().datetime(),
  type: z.literal("runtime.hello"),
  version: z.string().trim().min(1).max(64).optional(),
});

export const runtimeHeartbeatSchema = z.object({
  heartbeatId: z.string().uuid().optional(),
  activeSessions: z
    .array(
      z.object({
        fencingToken: z.string().regex(/^\d+$/u),
        leaseToken: z.string().uuid(),
        sessionId: z.string().uuid(),
        state: z.enum(["OPEN", "HUMAN_CONTROL", "INTERRUPTED"]),
      }),
    )
    .max(64),
  maxConcurrency: z.number().int().min(1).max(32),
  sentAt: z.string().datetime(),
  type: z.literal("runtime.heartbeat"),
});

export const runtimeArtifactPayloadSchema = z.object({
  contentType: z.string().min(1).max(120),
  dataBase64: z.string().min(1),
  kind: z.enum(["SCREENSHOT", "DOM", "CONSOLE", "NETWORK", "VIDEO"]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const runtimeCommandResultSchema = z.object({
  ownerTaskId: z.string().uuid().optional(),
  ownerFencingToken: z.string().regex(/^\d+$/u).optional(),
  artifacts: z.array(runtimeArtifactPayloadSchema).max(8).default([]),
  commandId: z.string().uuid(),
  error: z
    .object({
      code: z.string().min(1).max(80),
      details: z.record(z.string(), z.unknown()).optional(),
      message: z.string().min(1).max(2000),
      recoveryAction: z.enum(["RESNAPSHOT_AND_RETARGET"]).optional(),
      retryable: z.boolean().default(false),
    })
    .strict()
    .optional(),
  fencingToken: z.string().regex(/^\d+$/u),
  leaseToken: z.string().uuid(),
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().uuid(),
  type: z.literal("command.result"),
});

const runtimeVideoFinalizationAttemptSchema = z
  .object({
    code: z.string().min(1).max(80),
    durationMs: z.number().int().nonnegative().max(300_000),
    maxHeight: z.number().int().positive().max(16_384).optional(),
    maxWidth: z.number().int().positive().max(16_384).optional(),
    message: z.string().min(1).max(500),
    profile: z.enum(["native", "compatibility"]),
    videoBitsPerSecond: z.number().int().positive().max(100_000_000).optional(),
  })
  .strict();

export const runtimeVideoFinalizationFailurePayloadSchema = z
  .object({
    attempts: z.array(runtimeVideoFinalizationAttemptSchema).max(4),
    code: z.string().min(1).max(80),
    commandId: z.string().uuid(),
    durationMs: z.number().int().nonnegative().max(300_000),
    frameCount: z.number().int().positive().max(120),
    message: z.string().min(1).max(500),
    runtimeVersion: z.string().trim().min(1).max(64),
  })
  .strict();

export const runtimeEventSchema = z
  .object({
    eventId: z.string().uuid(),
    fencingToken: z.string().regex(/^\d+$/u),
    kind: z.enum([
      "PAGE_CHANGED",
      "CONSOLE_ERROR",
      "NETWORK_ERROR",
      "NETWORK_FAULT_HIT",
      "HUMAN_INPUT",
      "SESSION_INTERRUPTED",
      "VIDEO_FINALIZATION_FAILED",
    ]),
    leaseToken: z.string().uuid(),
    payload: z.record(z.string(), z.unknown()).default({}),
    sessionId: z.string().uuid(),
    timestamp: z.string().datetime(),
    type: z.literal("runtime.event"),
  })
  .superRefine((value, context) => {
    if (value.kind !== "VIDEO_FINALIZATION_FAILED") return;
    const parsed = runtimeVideoFinalizationFailurePayloadSchema.safeParse(
      value.payload,
    );
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: ["payload", ...issue.path] });
    }
  });

export const runtimeProfileLifecycleSchema = z.object({
  eventId: z.string().uuid(),
  kind: z.literal("PROFILE_EXPIRED"),
  lastUsedAt: z.string().datetime(),
  profileKey: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
  purgedAt: z.string().datetime(),
  type: z.literal("profile.lifecycle"),
});

export const runtimeHumanPreviewFrameSchema = z.object({
  capturedAt: z.string().datetime(),
  dataBase64: z.string().min(1),
  fencingToken: z.string().regex(/^\d+$/u),
  height: z.number().int().positive(),
  leaseToken: z.string().uuid(),
  sessionId: z.string().uuid(),
  streamId: z.string().uuid(),
  title: z.string().max(1000),
  type: z.literal("human.preview.frame"),
  url: z.string().max(4000),
  width: z.number().int().positive(),
});

export const runtimeHumanInputResultSchema = z.object({
  dispatchId: z.string().uuid(),
  error: z.string().min(1).max(1000).optional(),
  fencingToken: z.string().regex(/^\d+$/u),
  leaseToken: z.string().uuid(),
  ok: z.boolean(),
  sessionId: z.string().uuid(),
  type: z.literal("human.input.result"),
});

export const runtimeClientMessageSchema = z.discriminatedUnion("type", [
  runtimeHelloSchema,
  runtimeHeartbeatSchema,
  runtimeCommandResultSchema,
  runtimeEventSchema,
  runtimeProfileLifecycleSchema,
  runtimeHumanPreviewFrameSchema,
  runtimeHumanInputResultSchema,
]);

export const reconcileActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ADOPT"),
    permit: runtimeSessionPermitSchema.optional(),
    fencingToken: z.string().regex(/^\d+$/u),
    leaseExpiresAt: z.string().datetime(),
    leaseToken: z.string().uuid(),
    sessionId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("RESTORE"),
    permit: runtimeSessionPermitSchema.optional(),
    allowedOrigins: z.array(z.string().url().max(2_048)).max(32).default([]),
    fencingToken: z.string().regex(/^\d+$/u),
    leaseExpiresAt: z.string().datetime(),
    leaseToken: z.string().uuid(),
    profileKey: z.string().min(1).max(160),
    profileMode: z.literal("PERSISTENT"),
    profileRetention: userProfileRetentionSchema.optional(),
    sessionId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("CLOSE_LOCAL"),
    reason: z.string().min(1).max(240),
    sessionId: z.string().uuid(),
  }),
]);

export const runtimeHelloAcceptedSchema = z.object({
  heartbeatIntervalMs: z.number().int().positive(),
  networkAllowlist: runtimeNetworkAllowlistSchema.default([]),
  protocol: runtimeProtocolVersionSchema,
  reconcile: z.array(reconcileActionSchema),
  serverTime: z.string().datetime(),
  type: z.literal("runtime.hello.accepted"),
});

export const runtimeNetworkPolicyUpdatedSchema = z.object({
  networkAllowlist: runtimeNetworkAllowlistSchema,
  type: z.literal("runtime.network_policy.updated"),
});

export const runtimeHelloRejectedSchema = z.object({
  code: z.enum([
    "AUTH_FAILED",
    "PROTOCOL_MISMATCH",
    "RUNTIME_DISABLED",
    "INVALID_HELLO",
  ]),
  message: z.string().min(1).max(500),
  supportedProtocol: runtimeProtocolVersionSchema,
  type: z.literal("runtime.hello.rejected"),
});

export const runtimeCommandTypeSchema = z.enum([
  "session.open",
  "session.close",
  "profile.purge",
  "profile.snapshot",
  "page.open",
  "page.navigate",
  "page.back",
  "page.forward",
  "page.reload",
  "page.snapshot",
  "page.get_text",
  "page.get_url",
  "page.get_title",
  "page.errors",
  "page.screenshot",
  "page.dom",
  "page.console",
  "page.network",
  "page.click",
  "page.fill",
  "page.type",
  "page.press",
  "page.check",
  "page.uncheck",
  "page.select",
  "page.scroll",
  "page.hover",
  "page.drag",
  "page.resize",
  "page.wait",
  "tab.new",
  "tab.list",
  "tab.switch",
  "tab.close",
  "frame.snapshot",
  "frame.click",
  "frame.fill",
  "element.state",
  "locator.count",
  "network.arm",
  "network.wait_for_hit",
  "network.status",
  "network.release",
  "human.takeover",
  "human.release",
]);

export function runtimeCommandMinimumMinor(
  commandType: z.infer<typeof runtimeCommandTypeSchema>,
): number {
  if (["page.snapshot", "page.dom", "page.network"].includes(commandType)) {
    return 7;
  }
  if (commandType === "profile.purge") return 6;
  if (commandType === "profile.snapshot") return 13;
  if (
    [
      "page.get_text",
      "page.click",
      "page.fill",
      "page.type",
      "page.press",
      "page.check",
      "page.uncheck",
      "page.select",
      "page.scroll",
      "page.hover",
      "page.drag",
      "page.wait",
      "frame.snapshot",
      "frame.click",
      "frame.fill",
      "element.state",
      "locator.count",
    ].includes(commandType)
  ) {
    return 5;
  }
  return [
    "session.open",
    "session.close",
    "human.takeover",
    "human.release",
  ].includes(commandType)
    ? 1
    : 2;
}

const emptyPayloadSchema = z.object({}).strict();
const urlSchema = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .refine((value) => /^https?:\/\//iu.test(value), {
    message: "Browser navigation only supports http and https URLs.",
  })
  .refine((value) => !/^https?:\/\/[^/?#]*@/iu.test(value), {
    message: "Browser navigation URLs cannot contain credentials.",
  });
const selectorSchema = z.string().trim().min(1).max(2_048);
// Playwright AI snapshots expose opaque aria-ref tokens. Top-level refs use
// eN while refs scoped to a frame/page generation include an fN prefix.
// Consumers must preserve the complete token returned by the snapshot.
export const elementRefSchema = z.string().regex(/^(?:f\d+)?e\d+$/u);
const cursorSchema = z.coerce.number().int().min(0).default(0);
const maxCharsSchema = z.coerce
  .number()
  .int()
  .min(1_000)
  .max(256 * 1_024)
  .default(96 * 1_024);
const waitUntilSchema = z
  .enum(["commit", "domcontentloaded", "load", "networkidle"])
  .default("domcontentloaded");
const loadStateSchema = z
  .enum(["domcontentloaded", "load", "networkidle"])
  .default("domcontentloaded");

export const runtimeLocatorSchema = z.union([
  z.object({ ref: elementRefSchema }).strict(),
  z
    .object({
      frameSelector: selectorSchema.optional(),
      selector: selectorSchema,
    })
    .strict(),
]);

const navigationPayloadSchema = z
  .object({ url: urlSchema, waitUntil: waitUntilSchema.optional() })
  .strict();
const historyPayloadSchema = z
  .object({ waitUntil: waitUntilSchema.optional() })
  .strict();
const pagedTextPayloadSchema = z
  .object({
    cursor: cursorSchema.optional(),
    maxChars: maxCharsSchema.optional(),
  })
  .strict();
const snapshotPayloadSchema = z
  .object({
    cursor: cursorSchema.optional(),
    depth: z.coerce.number().int().min(1).max(50).default(12).optional(),
    includeBoxes: z.boolean().default(false).optional(),
    maxChars: maxCharsSchema.optional(),
    target: runtimeLocatorSchema.optional(),
  })
  .strict();
const networkEvidencePayloadSchema = pagedTextPayloadSchema
  .extend({
    includeResponseBodies: z.boolean().default(false).optional(),
    urlIncludes: z.string().trim().min(1).max(2_048).optional(),
  })
  .superRefine((value, context) => {
    if (value.includeResponseBodies && !value.urlIncludes) {
      context.addIssue({
        code: "custom",
        message: "urlIncludes is required when response bodies are included.",
        path: ["urlIncludes"],
      });
    }
  });
const targetPayloadSchema = z.object({ target: runtimeLocatorSchema }).strict();
const textTargetPayloadSchema = z
  .object({ target: runtimeLocatorSchema, text: z.string().max(64 * 1_024) })
  .strict();
const frameTargetSchema = runtimeLocatorSchema;

export const authSnapshotVerificationSchema = z
  .object({
    url: z.string().url().max(2048),
    authenticatedSelector: z.string().min(1).max(2000).optional(),
    successUrlPatterns: z.array(z.string().min(1).max(2048)).max(32).optional(),
    loginUrlPatterns: z.array(z.string().min(1).max(2048)).max(32).optional(),
  })
  .strict();
export type AuthSnapshotVerification = z.infer<
  typeof authSnapshotVerificationSchema
>;

const sessionCommandPayloadVariants = [
  z.object({
    commandType: z.literal("profile.snapshot"),
    payload: authSnapshotReferenceSchema.extend({
      verification: authSnapshotVerificationSchema.optional(),
      probeConcurrency: z.number().int().min(1).max(4).optional(),
    }),
  }),
  z.object({
    commandType: z.literal("session.open"),
    payload: z
      .object({
        allowedOrigins: z
          .array(z.string().url().max(2_048))
          .max(32)
          .default([]),
        profileKey: z.string().min(1).max(160),
        profileMode: z.enum(["PERSISTENT", "EPHEMERAL"]),
        profileRetention: userProfileRetentionSchema.optional(),
        authSnapshot: authSnapshotReferenceSchema.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.authSnapshot && value.profileMode !== "EPHEMERAL") {
          context.addIssue({
            code: "custom",
            message:
              "Authentication snapshots require an isolated EPHEMERAL session.",
            path: ["authSnapshot"],
          });
        }
        if (value.profileRetention && value.profileMode !== "PERSISTENT") {
          context.addIssue({
            code: "custom",
            message: "User Profile retention requires PERSISTENT profile mode.",
            path: ["profileRetention"],
          });
        }
      }),
  }),
  z.object({
    commandType: z.literal("session.close"),
    payload: emptyPayloadSchema,
  }),
  z.object({
    commandType: z.literal("profile.purge"),
    payload: z
      .object({
        profileKey: z
          .string()
          .min(1)
          .max(160)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
      })
      .strict(),
  }),
] as const;

const runtimeActionCommandPayloadVariants = [
  ...(["page.open", "page.navigate"] as const).map((commandType) =>
    z.object({
      commandType: z.literal(commandType),
      payload: navigationPayloadSchema,
    }),
  ),
  ...(["page.back", "page.forward", "page.reload"] as const).map(
    (commandType) =>
      z.object({
        commandType: z.literal(commandType),
        payload: historyPayloadSchema,
      }),
  ),
  z
    .object({
      commandType: z.literal("page.snapshot"),
      payload: snapshotPayloadSchema,
    })
    .describe(
      "为 Agent 采集临时的无障碍上下文和不透明 ref。此命令仅用于观察，不会创建持久化 DOM 证据；需要证据产物时使用 page.dom。",
    ),
  z
    .object({
      commandType: z.literal("page.get_text"),
      payload: z
        .object({
          cursor: cursorSchema.optional(),
          maxChars: maxCharsSchema.optional(),
          target: runtimeLocatorSchema.optional(),
        })
        .strict(),
    })
    .describe(
      "从页面或指定目标读取有界的可见文本。这是文本读取命令；不要编造 page.content。",
    ),
  ...(["page.get_url", "page.get_title", "tab.list"] as const).map(
    (commandType) =>
      z.object({
        commandType: z.literal(commandType),
        payload: emptyPayloadSchema,
      }),
  ),
  z
    .object({
      commandType: z.literal("page.errors"),
      payload: z
        .object({
          cursor: cursorSchema.optional(),
          kind: z.enum(["ALL", "CONSOLE", "NETWORK"]).default("ALL").optional(),
          maxItems: z.coerce
            .number()
            .int()
            .min(1)
            .max(500)
            .default(100)
            .optional(),
        })
        .strict(),
    })
    .describe(
      "读取有界的控制台或网络错误摘要用于诊断。需要持久化证据时使用 page.console 或 page.network。",
    ),
  z
    .object({
      commandType: z.literal("page.screenshot"),
      payload: z
        .object({
          format: z.enum(["jpeg", "png"]).default("jpeg").optional(),
          fullPage: z.boolean().default(false).optional(),
          quality: z.coerce
            .number()
            .int()
            .min(30)
            .max(90)
            .default(70)
            .optional(),
        })
        .strict(),
    })
    .describe("创建持久化的 SCREENSHOT 证据产物。"),
  ...(["page.dom", "page.console"] as const).map((commandType) =>
    z
      .object({
        commandType: z.literal(commandType),
        payload: pagedTextPayloadSchema,
      })
      .describe(
        commandType === "page.dom"
          ? "创建持久化的 DOM 证据产物，包括开放的 Shadow DOM 内容。这是 HTML 内容命令；不存在 page.content。"
          : "创建持久化的 CONSOLE 证据产物。",
      ),
  ),
  z
    .object({
      commandType: z.literal("page.network"),
      payload: networkEvidencePayloadSchema,
    })
    .describe(
      "创建持久化的 NETWORK 证据。仅在需要响应 JSON 时设置 includeResponseBodies=true，并使用 urlIncludes 缩小范围。响应体仅支持同源 JSON，且会进行限长和脱敏。",
    ),
  z
    .object({
      commandType: z.literal("page.click"),
      payload: z.union([
        targetPayloadSchema,
        z
          .object({
            point: z
              .object({ x: z.number().finite(), y: z.number().finite() })
              .strict(),
          })
          .strict(),
      ]),
    })
    .describe(
      "点击 page.snapshot/observe_browser 返回的目标。必须保留完整的 eN/fNeN ref；不存在 element.click。",
    ),
  z.object({
    commandType: z.literal("page.fill"),
    payload: textTargetPayloadSchema,
  }),
  z.object({
    commandType: z.literal("page.type"),
    payload: z
      .object({
        delayMs: z.coerce
          .number()
          .int()
          .min(0)
          .max(1_000)
          .default(0)
          .optional(),
        target: runtimeLocatorSchema,
        text: z.string().max(64 * 1_024),
      })
      .strict(),
  }),
  z.object({
    commandType: z.literal("page.press"),
    payload: z
      .object({
        key: z.string().trim().min(1).max(80),
        target: runtimeLocatorSchema.optional(),
      })
      .strict(),
  }),
  ...(["page.check", "page.uncheck", "page.hover"] as const).map(
    (commandType) =>
      z.object({
        commandType: z.literal(commandType),
        payload: targetPayloadSchema,
      }),
  ),
  z.object({
    commandType: z.literal("page.select"),
    payload: z
      .object({
        target: runtimeLocatorSchema,
        values: z.array(z.string().max(4_096)).min(1).max(100),
      })
      .strict(),
  }),
  z.object({
    commandType: z.literal("page.scroll"),
    payload: z
      .object({
        deltaX: z.number().finite().min(-100_000).max(100_000).default(0),
        deltaY: z.number().finite().min(-100_000).max(100_000),
        target: runtimeLocatorSchema.optional(),
      })
      .strict(),
  }),
  z.object({
    commandType: z.literal("page.drag"),
    payload: z
      .object({ source: runtimeLocatorSchema, target: runtimeLocatorSchema })
      .strict(),
  }),
  z.object({
    commandType: z.literal("page.resize"),
    payload: z
      .object({
        height: z.coerce.number().int().min(240).max(4_320),
        width: z.coerce.number().int().min(320).max(7_680),
      })
      .strict(),
  }),
  z.object({
    commandType: z.literal("page.wait"),
    payload: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("selector"),
          state: z
            .enum(["attached", "detached", "visible", "hidden"])
            .default("visible"),
          target: runtimeLocatorSchema,
          timeoutMs: z.coerce
            .number()
            .int()
            .min(1)
            .max(300_000)
            .default(30_000),
        })
        .strict(),
      z
        .object({
          exact: z.boolean().default(false),
          kind: z.literal("text"),
          text: z.string().min(1).max(16_384),
          timeoutMs: z.coerce
            .number()
            .int()
            .min(1)
            .max(300_000)
            .default(30_000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("load"),
          state: loadStateSchema,
          timeoutMs: z.coerce
            .number()
            .int()
            .min(1)
            .max(300_000)
            .default(30_000),
        })
        .strict()
        .describe(
          "等待文档加载状态。SPA 和微前端导航应优先等待 selector 或文本；存在持续后台请求时，networkidle 可能永远不会发生。",
        ),
    ]),
  }),
  z.object({
    commandType: z.literal("tab.new"),
    payload: z.object({ url: urlSchema.optional() }).strict(),
  }),
  z.object({
    commandType: z.literal("tab.switch"),
    payload: z.union([
      z.object({ index: z.coerce.number().int().min(0).max(100) }).strict(),
      z.object({ tabId: z.string().uuid() }).strict(),
    ]),
  }),
  z.object({
    commandType: z.literal("tab.close"),
    payload: z.object({ tabId: z.string().uuid().optional() }).strict(),
  }),
  z.object({
    commandType: z.literal("frame.snapshot"),
    payload: z
      .object({
        cursor: cursorSchema.optional(),
        frame: frameTargetSchema,
        maxChars: maxCharsSchema.optional(),
      })
      .strict(),
  }),
  z.object({
    commandType: z.literal("frame.click"),
    payload: z
      .object({ frame: frameTargetSchema, target: runtimeLocatorSchema })
      .strict(),
  }),
  z.object({
    commandType: z.literal("frame.fill"),
    payload: z
      .object({
        frame: frameTargetSchema,
        target: runtimeLocatorSchema,
        text: z.string().max(64 * 1_024),
      })
      .strict(),
  }),
  z.object({
    commandType: z.literal("element.state"),
    payload: targetPayloadSchema,
  }),
  z.object({
    commandType: z.literal("locator.count"),
    payload: z.object({ target: runtimeLocatorSchema }).strict(),
  }),
  z.object({
    commandType: z.literal("network.arm"),
    payload: z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("PAUSE"),
          maxPauseMs: z.coerce
            .number()
            .int()
            .min(100)
            .max(300_000)
            .default(30_000),
          method: z
            .string()
            .regex(/^[A-Z]+$/u)
            .max(20)
            .optional(),
          policyId: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
            .max(120),
          urlPattern: z.string().min(1).max(2_048),
        })
        .strict(),
      z
        .object({
          action: z.literal("ABORT"),
          method: z
            .string()
            .regex(/^[A-Z]+$/u)
            .max(20)
            .optional(),
          policyId: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
            .max(120),
          urlPattern: z.string().min(1).max(2_048),
        })
        .strict(),
      z
        .object({
          action: z.literal("FULFILL_STATUS"),
          method: z
            .string()
            .regex(/^[A-Z]+$/u)
            .max(20)
            .optional(),
          policyId: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
            .max(120),
          status: z.coerce.number().int().min(100).max(599),
          urlPattern: z.string().min(1).max(2_048),
        })
        .strict(),
    ]),
  }),
  z.object({
    commandType: z.literal("network.wait_for_hit"),
    payload: z
      .object({
        policyId: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
          .max(120),
        timeoutMs: z.coerce.number().int().min(1).max(300_000).default(30_000),
      })
      .strict(),
  }),
  z.object({
    commandType: z.literal("network.status"),
    payload: z
      .object({
        policyId: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
          .max(120)
          .optional(),
      })
      .strict(),
  }),
  z.object({
    commandType: z.literal("network.release"),
    payload: z
      .object({
        policyId: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
          .max(120),
      })
      .strict(),
  }),
] as const;

const humanCommandPayloadVariants = [
  ...(["human.takeover", "human.release"] as const).map((commandType) =>
    z.object({
      commandType: z.literal(commandType),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
] as const;

const commandPayloadVariants = [
  ...sessionCommandPayloadVariants,
  ...runtimeActionCommandPayloadVariants,
  ...humanCommandPayloadVariants,
] as const;

export const runtimeCommandPayloadSchema = z.discriminatedUnion(
  "commandType",
  commandPayloadVariants,
);

const commandInputVariants = commandPayloadVariants.map((variant) =>
  variant
    .extend({
      timeoutSeconds: z.coerce.number().int().min(1).max(300).optional(),
    })
    .strict(),
) as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]];

type RuntimeCommandInputValue = z.infer<typeof runtimeCommandPayloadSchema> & {
  timeoutSeconds?: number;
};

export const runtimeCommandInputSchema = z.union(
  commandInputVariants,
) as unknown as z.ZodType<RuntimeCommandInputValue>;

const runtimeActionCommandInputVariants =
  runtimeActionCommandPayloadVariants.map((variant) => {
    const extended = variant
      .extend({
        timeoutSeconds: z.coerce.number().int().min(1).max(300).optional(),
      })
      .strict();
    return variant.description
      ? extended.describe(variant.description)
      : extended;
  }) as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]];

type RuntimeActionCommandInputValue = Exclude<
  RuntimeCommandInputValue,
  {
    commandType:
      | "session.open"
      | "session.close"
      | "profile.purge"
      | "profile.snapshot"
      | "human.takeover"
      | "human.release";
  }
>;

/** Browser actions exposed to Agents and console callers after acquisition. */
export const runtimeActionCommandInputSchema = z
  .union(runtimeActionCommandInputVariants)
  .describe(
    "Agent 浏览器操作的封闭允许列表。只能使用准确的 commandType 分支；不要编造 Playwright 风格的别名。",
  ) as unknown as z.ZodType<RuntimeActionCommandInputValue>;

export const runtimeCommandSchema = z
  .object({
    permit: runtimeSessionPermitSchema.optional(),
    ownerTaskId: z.string().uuid().optional(),
    ownerFencingToken: z.string().regex(/^\d+$/u).optional(),
    commandId: z.string().uuid(),
    commandType: runtimeCommandTypeSchema,
    deadlineAt: z.string().datetime(),
    fencingToken: z.string().regex(/^\d+$/u),
    leaseToken: z.string().uuid(),
    payload: z.record(z.string(), z.unknown()).default({}),
    sessionId: z.string().uuid(),
    type: z.literal("command.execute"),
  })
  .superRefine((value, context) => {
    const parsed = runtimeCommandPayloadSchema.safeParse({
      commandType: value.commandType,
      payload: value.payload,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ ...issue, path: issue.path });
      }
    }
  });

export const runtimeCommandCancelSchema = z.object({
  commandId: z.string().uuid(),
  reason: z.string().min(1).max(240),
  sessionId: z.string().uuid(),
  type: z.literal("command.cancel"),
});

export const runtimeHeartbeatAckSchema = z.object({
  heartbeatId: z.string().uuid().optional(),
  sessionPermits: z.array(runtimeSessionPermitSchema).max(64).optional(),
  closeSessions: z.array(z.string().uuid()).default([]),
  leaseExpiresAt: z.string().datetime(),
  serverTime: z.string().datetime(),
  type: z.literal("runtime.heartbeat.ack"),
});

export const runtimeDeliveryAckSchema = z.object({
  messageId: z.string().uuid(),
  messageType: z.enum([
    "command.result",
    "human.input.result",
    "runtime.event",
    "profile.lifecycle",
  ]),
  type: z.literal("runtime.delivery.ack"),
});

export const runtimeHumanPreviewSubscribeSchema = z.object({
  fencingToken: z.string().regex(/^\d+$/u),
  intervalMs: z.number().int().min(500).max(5000),
  leaseToken: z.string().uuid(),
  quality: z.number().int().min(30).max(85),
  sessionId: z.string().uuid(),
  streamId: z.string().uuid(),
  type: z.literal("human.preview.subscribe"),
});

export const runtimeHumanPreviewUnsubscribeSchema = z.object({
  sessionId: z.string().uuid(),
  streamId: z.string().uuid(),
  type: z.literal("human.preview.unsubscribe"),
});

export const runtimeHumanInputDispatchSchema = z.object({
  controlGeneration: z.number().int().nonnegative().optional(),
  dispatchId: z.string().uuid(),
  events: browserHumanInputEventsSchema,
  fencingToken: z.string().regex(/^\d+$/u),
  leaseToken: z.string().uuid(),
  sessionId: z.string().uuid(),
  type: z.literal("human.input.dispatch"),
});

export const runtimeServerMessageSchema = z.discriminatedUnion("type", [
  runtimeHelloAcceptedSchema,
  runtimeHelloRejectedSchema,
  runtimeNetworkPolicyUpdatedSchema,
  runtimeCommandSchema,
  runtimeCommandCancelSchema,
  runtimeHeartbeatAckSchema,
  runtimeDeliveryAckSchema,
  runtimeHumanPreviewSubscribeSchema,
  runtimeHumanPreviewUnsubscribeSchema,
  runtimeHumanInputDispatchSchema,
]);

export type RuntimeClientMessage = z.infer<typeof runtimeClientMessageSchema>;
export type RuntimeServerMessage = z.infer<typeof runtimeServerMessageSchema>;
export type RuntimeCommandType = z.infer<typeof runtimeCommandTypeSchema>;
export type RuntimeCommandResult = z.infer<typeof runtimeCommandResultSchema>;
export type RuntimeArtifactPayload = z.infer<
  typeof runtimeArtifactPayloadSchema
>;
export type ReconcileAction = z.infer<typeof reconcileActionSchema>;
export type BrowserHumanInputEvent = z.infer<
  typeof browserHumanInputEventSchema
>;
export type RuntimeHumanPreviewFrame = z.infer<
  typeof runtimeHumanPreviewFrameSchema
>;
export type RuntimeHumanInputResult = z.infer<
  typeof runtimeHumanInputResultSchema
>;
