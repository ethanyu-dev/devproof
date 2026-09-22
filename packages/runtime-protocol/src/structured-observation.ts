import { z } from "zod";

export const STRUCTURED_OBSERVATION_CAPABILITY = "structured-observation-v1";
export const SCOPE_PHASE_CAPABILITY = "scope-phase-v1";
export const ACTION_OBSERVATION_CAPABILITY = "action-observation-v1";
export const STRUCTURED_OBSERVATION_MAX_BYTES = 2 * 1024 * 1024;
export const STRUCTURED_OBSERVATION_MAX_NODES = 8000;
export const STRUCTURED_OBSERVATION_MAX_REGIONS = 500;
export const STRUCTURED_OBSERVATION_MAX_TEXT_CHARACTERS = 256 * 1024;
export const observationLimitEventSchema = z.object({
  scope: z.enum(["VIEWPORT", "REGION"]),
  measured: z.object({
    bytes: z.number().int().nonnegative(),
    nodes: z.number().int().nonnegative(),
    regions: z.number().int().nonnegative(),
    textCharacters: z.number().int().nonnegative(),
  }),
  limits: z.object({
    bytes: z.number().int().positive(),
    nodes: z.number().int().positive(),
    regions: z.number().int().positive(),
    textCharacters: z.number().int().positive(),
  }),
  exceeded: z
    .array(z.enum(["BYTES", "NODES", "REGIONS", "TEXT", "REFS", "VISITS"]))
    .min(1)
    .max(6),
  action: z.enum(["SCOPED_RECAPTURE", "TRIMMED"]),
});
export type ObservationLimitEvent = z.infer<typeof observationLimitEventSchema>;
const id = z.string().min(1).max(160);
const text = z.string().max(500);

export const observedNodeSchema = z.object({
  nodeId: id,
  ref: id.optional(),
  parentId: id.optional(),
  frameId: id,
  documentEpoch: id,
  tag: z.string().max(64),
  role: z.string().max(100).optional(),
  name: text.optional(),
  nameSource: z.enum(["ARIA", "LABEL", "TEXT", "TITLE"]).optional(),
  text: text.optional(),
  value: text.optional(),
  selectedLabel: text.optional(),
  selectedLabelSource: z.enum(["NATIVE_SELECT", "DISPLAY_RELATION"]).optional(),
  truncatedProperties: z
    .array(z.enum(["NAME", "TEXT", "VALUE", "SELECTED_LABEL"]))
    .max(4)
    .optional(),
  checked: z.boolean().optional(),
  enabled: z.boolean().optional(),
  visible: z.boolean(),
  attributes: z.record(z.string().max(80), text),
  box: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  relations: z
    .array(
      z.object({
        kind: z.enum(["LABELLED_BY", "SELECTED_DISPLAY"]),
        targetNodeId: id,
      }),
    )
    .max(20),
  textLocation: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
});

export const structuredObservationSchema = z.object({
  version: z.literal(2),
  captureId: z.string().uuid(),
  capturedFrom: z.string().datetime(),
  capturedUntil: z.string().datetime(),
  pageIdentity: z.string().max(2000),
  frames: z
    .array(
      z.object({
        frameId: id,
        documentEpoch: id,
        mutationRevision: z.number().int().nonnegative().optional(),
      }),
    )
    .max(100),
  nodes: z.array(observedNodeSchema).max(STRUCTURED_OBSERVATION_MAX_NODES),
  renderedText: z.string().max(STRUCTURED_OBSERVATION_MAX_TEXT_CHARACTERS),
  regions: z
    .array(
      z.object({
        nodeId: id,
        epoch: id,
        openedByCommandId: z.string().uuid().optional(),
        phaseProven: z.boolean(),
        reopened: z.boolean(),
        modifiedNodeIds: z.array(id).max(1000),
      }),
    )
    .max(STRUCTURED_OBSERVATION_MAX_REGIONS),
  sourceCommandId: z.string().uuid().optional(),
  consistency: z.enum(["DOM_ONLY", "VERIFIED", "DRIFTED"]),
  // The overall page may change while a specific business region stays stable.
  verifiedScopeNodeIds: z
    .array(id)
    .max(STRUCTURED_OBSERVATION_MAX_NODES)
    .optional(),
  consistencyIssues: z
    .array(
      z.object({
        code: z.string().max(80),
        frameId: id,
        nodeId: id.optional(),
      }),
    )
    .max(20)
    .optional(),
  coverage: z.object({
    scope: z.enum(["VIEWPORT", "REGION"]),
    rootNodeId: id.optional(),
    completeWithinScope: z.boolean(),
    truncated: z.boolean(),
    unavailableFrames: z.array(id).max(100),
    limitEvents: z.array(observationLimitEventSchema).max(2).optional(),
  }),
});
export type ObservedNode = z.infer<typeof observedNodeSchema>;
export type StructuredObservation = z.infer<typeof structuredObservationSchema>;

export const actionObservationSchema = z
  .object({
    observe: z.enum(["ACTIVE_REGION", "VIEWPORT"]),
    timeoutMs: z.number().int().min(100).max(5000).default(1500),
  })
  .strict();
