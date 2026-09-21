import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  structuredObservationSchema,
  STRUCTURED_OBSERVATION_MAX_BYTES,
} from "@devproof/runtime-protocol";
import {
  observationLimitEvent,
  trimObservation,
} from "./observation-budget.js";

it("accepts expanded node counts and bounds byte, text and region overflow without erasing all nodes", () => {
  const observation = structuredObservationSchema.parse({
    version: 2,
    captureId: randomUUID(),
    capturedFrom: new Date().toISOString(),
    capturedUntil: new Date().toISOString(),
    pageIdentity: "fixture",
    frames: [],
    renderedText: "",
    regions: [],
    consistency: "DOM_ONLY",
    coverage: {
      scope: "VIEWPORT",
      truncated: false,
      completeWithinScope: true,
      unavailableFrames: [],
    },
    nodes: Array.from({ length: 4500 }, (_, index) => ({
      nodeId: `n${index}`,
      frameId: "frame",
      documentEpoch: "doc",
      tag: "div",
      visible: false,
      attributes: {},
      relations: [],
      textLocation: { start: 0, end: 0 },
    })),
  });
  expect(observation.nodes).toHaveLength(4500);
  const overNodes = {
    ...observation,
    nodes: Array.from({ length: 8001 }, (_, index) => ({
      ...observation.nodes[0]!,
      nodeId: `n${index}`,
    })),
  };
  expect(structuredObservationSchema.safeParse(overNodes).success).toBe(false);
  const nodeEvent = observationLimitEvent(overNodes)!;
  expect(nodeEvent.exceeded).toContain("NODES");
  trimObservation(overNodes, nodeEvent);
  expect(overNodes.nodes.length).toBeLessThanOrEqual(8000);
  expect(structuredObservationSchema.safeParse(overNodes).success).toBe(true);
  for (const node of observation.nodes) node.text = "汉".repeat(500);
  observation.renderedText = "汉".repeat(300000);
  observation.regions = observation.nodes.slice(0, 501).map((node) => ({
    nodeId: node.nodeId,
    epoch: "epoch",
    phaseProven: false,
    reopened: false,
    modifiedNodeIds: [],
  }));
  const event = observationLimitEvent(observation)!;
  expect(event.exceeded).toEqual(
    expect.arrayContaining(["BYTES", "TEXT", "REGIONS"]),
  );
  trimObservation(observation, event);
  expect(observation.nodes.length).toBeGreaterThan(0);
  expect(observation.coverage.truncated).toBe(true);
  expect(structuredObservationSchema.safeParse(observation).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThan(
    STRUCTURED_OBSERVATION_MAX_BYTES,
  );
});
