import { describe, it, expect, vi } from "vitest";
import { saveExecutionCheckpoint } from "./execution-checkpoint.js";
const id = "285146a8-5230-4b02-832a-5eef19e8dc8a";
const snapshot = {
  attemptId: id,
  attemptNumber: 1,
  runId: id,
  teamId: id,
  traceId: "1234567890abcdef1234567890abcdef",
  deadlineAt: new Date(Date.now() + 60000).toISOString(),
  goal: "Verify",
  environment: {},
  executionPolicy: { resume: { kind: "TEST_ACCOUNT" } },
  criteria: [{ id: "visible", description: "页面可见", required: true }],
};
function transaction() {
  return {
    runEvidence: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ externalId: "artifact://proof", kind: "DOM" }]),
    },
    executionRun: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        teamId: id,
        environmentSnapshot: {},
        executionPolicy: { browser: { mode: "PERSISTENT" } },
      }),
      update: vi.fn(),
    },
    agentRuntimeTask: { update: vi.fn() },
  };
}
describe("durable execution checkpoints", () => {
  it("validates and persists deferred record evidence for a later receipt", async () => {
    const tx = transaction();
    const pendingRecords = [
      {
        id: "123",
        type: "MAPPING",
        resourceUrl: "https://app.test/list",
        accountAliases: ["user"],
        evidenceRefs: ["artifact://proof"],
      },
    ];
    await saveExecutionCheckpoint(
      tx as never,
      { id, runId: id, snapshot },
      { executionState: { pendingRecords } },
    );
    expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          snapshot: expect.objectContaining({
            executionPolicy: expect.objectContaining({
              executionState: expect.objectContaining({ pendingRecords }),
            }),
          }),
        },
      }),
    );
    await expect(
      saveExecutionCheckpoint(
        tx as never,
        { id, runId: id, snapshot },
        {
          executionState: {
            pendingRecords: [
              { ...pendingRecords[0], evidenceRefs: ["another-run"] },
            ],
          },
        },
      ),
    ).rejects.toThrow("this execution");
  });
  it("stores progress in both execution policy and the next lease snapshot", async () => {
    const tx = transaction();
    await saveExecutionCheckpoint(
      tx as never,
      { id, runId: id, snapshot },
      {
        executionState: {
          phase: "VERIFYING",
          step: "确认创建结果",
          records: [],
        },
        verificationCheckpoint: {
          criteria: [
            {
              criterionId: "visible",
              status: "PASSED",
              summary: "页面可见",
              evidenceRefs: ["artifact://proof"],
            },
          ],
          evidence: [{ externalId: "artifact://proof", kind: "DOM" }],
        },
      },
    );
    expect(tx.executionRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          executionPolicy: expect.objectContaining({
            browser: { mode: "PERSISTENT" },
            executionState: expect.objectContaining({ phase: "VERIFYING" }),
          }),
        },
      }),
    );
    expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          snapshot: expect.objectContaining({
            executionPolicy: expect.objectContaining({
              resume: { kind: "TEST_ACCOUNT" },
              verificationCheckpoint: expect.objectContaining({
                criteria: [expect.objectContaining({ status: "PASSED" })],
              }),
            }),
          }),
        },
      }),
    );
  });
  it("rejects evidence from a different run before mutating either snapshot", async () => {
    const tx = transaction();
    await expect(
      saveExecutionCheckpoint(
        tx as never,
        { id, runId: id, snapshot },
        {
          executionState: {},
          verificationCheckpoint: {
            criteria: [],
            evidence: [{ externalId: "artifact://other", kind: "DOM" }],
          },
        },
      ),
    ).rejects.toThrow("this execution");
    expect(tx.agentRuntimeTask.update).not.toHaveBeenCalled();
    expect(tx.executionRun.update).not.toHaveBeenCalled();
  });
});
