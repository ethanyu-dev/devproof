import { expect, it, vi } from "vitest";
import { runtimeTaskSnapshotSchema } from "@devproof/agent-runtime-protocol";
import { saveExecutionCheckpoint } from "./execution-checkpoint.js";
const runId = "285146a8-5230-4b02-832a-5eef19e8dc8a",
  attemptId = "cc61de8d-cf29-4561-b2cd-c67c304668a5";
const snapshot = runtimeTaskSnapshotSchema.parse({
  runId,
  attemptId,
  attemptNumber: 1,
  teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
  goal: "验证页面",
  traceId: "1234567890abcdef1234567890abcdef",
  deadlineAt: new Date(Date.now() + 60000).toISOString(),
  environment: {},
  executionPolicy: {},
  criteria: [
    { id: "c", description: "页面可见", requiredEvidenceKinds: ["DOM"] },
  ],
});
function setup() {
  const stored = new Map<string, unknown>();
  const tx = {
    runEvidence: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { externalId: "proof", kind: "DOM", label: "页面", metadata: {} },
        ]),
    },
    runCriterionResult: {
      upsert: vi.fn(async (args: { create: { criterionId: string } }) => {
        stored.set(args.create.criterionId, args.create);
      }),
    },
    executionRun: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ executionPolicy: {} }),
      update: vi.fn(),
    },
    agentRuntimeTask: { update: vi.fn() },
  };
  return { tx, stored };
}
const criterion = {
  criterionId: "c",
  status: "PASSED",
  summary: "页面可见",
  evidenceRefs: ["proof"],
};
it("persists accepted criteria independently of cleanup and idempotently across repeated checkpoints", async () => {
  const { tx, stored } = setup();
  const input = {
    executionState: {
      phase: "CLEANUP",
      cleanupReview: {
        status: "BLOCKED",
        note: "需要核对写入",
        writeKeys: ["w"],
        evidenceRefs: ["proof"],
      },
    },
    verificationCheckpoint: {
      criteria: [criterion],
      evidence: [],
      evidenceCatalog: { version: 1, runId, attemptId },
    },
  };
  const task = { id: "task", runId, snapshot };
  await saveExecutionCheckpoint(tx as never, task, input);
  await saveExecutionCheckpoint(tx as never, task, input);
  expect(stored.size).toBe(1);
  expect(stored.get("c")).toMatchObject({ status: "PASSED", attemptId });
  expect(tx.runEvidence.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ attemptId }) }),
  );
});
it("rejects a catalog or criterion evidence from another attempt", async () => {
  const { tx } = setup();
  const task = { id: "task", runId, snapshot };
  await expect(
    saveExecutionCheckpoint(tx as never, task, {
      executionState: {},
      verificationCheckpoint: {
        criteria: [criterion],
        evidence: [],
        evidenceCatalog: { version: 1, runId, attemptId: runId },
      },
    }),
  ).rejects.toThrow("this attempt");
  tx.runEvidence.findMany.mockResolvedValue([]);
  await expect(
    saveExecutionCheckpoint(tx as never, task, {
      executionState: {},
      verificationCheckpoint: { criteria: [criterion], evidence: [] },
    }),
  ).rejects.toThrow("saved evidence");
  expect(tx.runCriterionResult.upsert).not.toHaveBeenCalled();
});
