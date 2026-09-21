import { expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import {
  compileBusinessCheck,
  businessCheckSchema,
  runtimeTaskSnapshotSchema,
} from "@devproof/agent-runtime-protocol";
import { STRUCTURED_OBSERVATION_MAX_BYTES } from "@devproof/runtime-protocol";
import { ObservationBindingService } from "./observation-binding.service.js";

it("reads canonical artifacts above 512 KiB with the new bound, and rejects artifacts above 2 MiB", async () => {
  const snapshot = runtimeTaskSnapshotSchema.parse({
    attemptId: randomUUID(),
    attemptNumber: 1,
    runId: randomUUID(),
    teamId: randomUUID(),
    traceId: "1".repeat(32),
    deadlineAt: new Date().toISOString(),
    goal: "Verify button",
    criteria: [
      {
        id: "c",
        description: "检查星期按钮。",
        required: true,
        requiredEvidenceKinds: ["DOM"],
        observationContract: compileBusinessCheck(
          businessCheckSchema.parse({
            subjects: ["周一"],
            state: { label: "状态", property: "CHECKED", equals: true },
          }),
          { sourceRef: "source", quote: "周一" },
          ["DOM"],
        ),
      },
    ],
  });
  const observation = {
    version: 2,
    captureId: randomUUID(),
    capturedFrom: new Date().toISOString(),
    capturedUntil: new Date().toISOString(),
    pageIdentity: "fixture",
    frames: [],
    regions: [],
    renderedText: "",
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
      tag: "span",
      visible: false,
      attributes: {},
      relations: [],
      textLocation: { start: 0, end: 0 },
    })),
  };
  const body = Buffer.from(JSON.stringify(observation));
  expect(body.byteLength).toBeGreaterThan(512 * 1024);
  const storage = { get: vi.fn().mockResolvedValue({ body }) };
  const service = new ObservationBindingService({} as never, storage as never);
  const artifact = {
    id: randomUUID(),
    kind: "DOM",
    contentType: "application/json",
    metadata: { observationSchemaVersion: 2 },
    storageKey: "fixture",
    byteSize: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  const command = {
    id: randomUUID(),
    status: "SUCCEEDED",
    artifacts: [artifact],
  };
  const result = await service.capture({ snapshot } as never, command as never);
  expect(result.coverage).toHaveLength(1);
  expect(storage.get).toHaveBeenCalledWith("fixture", {
    start: 0,
    end: STRUCTURED_OBSERVATION_MAX_BYTES,
  });
  artifact.byteSize = STRUCTURED_OBSERVATION_MAX_BYTES + 1;
  await expect(
    service.capture({ snapshot } as never, command as never),
  ).rejects.toThrow("OBSERVATION_TOO_LARGE");
  expect(storage.get).toHaveBeenCalledTimes(1);
});
