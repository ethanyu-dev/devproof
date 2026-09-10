import {
  runtimeOutcomeSchema,
  runtimeTaskSnapshotSchema,
} from "@devproof/agent-runtime-protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeTaskService } from "./agent-runtime-task.service.js";

function fixture(potentialWrites: number) {
  const snapshot = runtimeTaskSnapshotSchema.parse({
    attemptId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
    attemptNumber: 1,
    runId: "285146a8-5230-4b02-832a-5eef19e8dc8a",
    teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
    traceId: "1234567890abcdef1234567890abcdef",
    goal: "验证页面及保存结果。",
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    environment: {},
    executionPolicy: {},
    criteria: [
      {
        id: "visible",
        description: "页面可见",
        required: true,
        requiredEvidenceKinds: [],
      },
      {
        id: "saved",
        description: "保存成功",
        required: true,
        requiredEvidenceKinds: [],
      },
    ],
  });
  const lease = { fencingToken: "2", leaseToken: "lease", workerId: "worker" };
  const task = {
    id: "task",
    snapshot,
    completionId: null,
    status: "RUNNING",
    attemptId: snapshot.attemptId,
    runId: snapshot.runId,
    fencingToken: 2n,
    leaseToken: lease.leaseToken,
    leaseOwner: lease.workerId,
    leaseExpiresAt: new Date(Date.now() + 120_000),
    attempt: { number: 1 },
    run: {
      lifecycle: "RUNNING",
      cancelRequestedAt: null,
      executionPolicy: { retryPolicy: { maxAttempts: 1, retryOn: [] } },
    },
  };
  const session = {
    id: "session",
    fencingToken: 1n,
    leaseToken: "browser-lease",
    ownerTaskId: task.id,
    ownerFencingToken: task.fencingToken,
    launchIdentity: { version: 1, id: "launch" },
    launchIdentityVersion: 1,
    launchHostInstanceId: "host",
    launchConnectionGeneration: 1n,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ now: new Date() }]),
    agentRuntimeTask: {
      findFirst: vi.fn().mockResolvedValue(task),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
    },
    browserRuntimeSession: { findFirst: vi.fn().mockResolvedValue(session) },
    runtimeSessionRecovery: { findUnique: vi.fn().mockResolvedValue(null) },
    browserRuntimeCommand: {
      findFirst: vi.fn().mockResolvedValue({ id: "launch-command" }),
      count: vi.fn().mockResolvedValue(potentialWrites),
    },
    executionResourceLease: { updateMany: vi.fn() },
    runAttempt: { update: vi.fn() },
    runCriterionResult: { createMany: vi.fn() },
    runEvidence: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(),
    },
    executionRun: { update: vi.fn() },
    runEvent: { create: vi.fn() },
  };
  const service = new AgentRuntimeTaskService(
    {
      $transaction: (callback: (value: unknown) => unknown) => callback(tx),
    } as never,
    {} as never,
  );
  const outcome = runtimeOutcomeSchema.parse({
    kind: "VERIFICATION_COMPLETED",
    executionDisposition: "EXECUTED",
    verdict: "INCONCLUSIVE",
    summary: "工具调用预算已用尽，保留页面验收。",
    termination: { reason: "TOOL_LIMIT_REACHED" },
    evidence: [],
    criteria: [
      {
        criterionId: "visible",
        status: "PASSED",
        summary: "页面可见。",
        evidenceRefs: [],
      },
      {
        criterionId: "saved",
        status: "INCONCLUSIVE",
        summary: "保存结果尚未确认。",
        evidenceRefs: [],
      },
    ],
  });
  const submit = (value = outcome) =>
    service.submitOutcome(snapshot.teamId, task.id, {
      ...lease,
      completionId: "4a67cd6b-8073-4fba-ac0e-607d5400d03d",
      completedAt: new Date().toISOString(),
      outcome: value,
    });
  return { tx, outcome, submit };
}

describe("forced finalization write audit", () => {
  it.each([
    "TOOL_LIMIT_REACHED",
    "FINALIZATION_RESERVE_REACHED",
    "REPEATED_OPERATIONS",
    "TEXT_ONLY_LOOP",
  ])(
    "keeps partial criteria and the original %s reason when writes are unknown",
    async (reason) => {
      const { tx, outcome, submit } = fixture(1);
      await submit(
        runtimeOutcomeSchema.parse({ ...outcome, termination: { reason } }),
      );
      expect(tx.browserRuntimeCommand.count).toHaveBeenCalledOnce();
      expect(tx.executionResourceLease.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { quarantined: true } }),
      );
      expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
            result: expect.objectContaining({
              kind: "FATAL_FAILURE",
              error: expect.objectContaining({
                failureClass: "TOOL_EXECUTION",
                code: "WRITE_OUTCOME_UNKNOWN",
                details: expect.objectContaining({
                  originalError: expect.objectContaining({ code: reason }),
                  verification: expect.objectContaining({
                    verdict: "INCONCLUSIVE",
                  }),
                }),
              }),
            }),
          }),
        }),
      );
      expect(
        tx.runCriterionResult.createMany.mock.calls[0]?.[0].data.map(
          (entry: { status: string }) => entry.status,
        ),
      ).toEqual(["PASSED", "INCONCLUSIVE"]);
      expect(tx.executionRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            executionDisposition: "BLOCKED",
            // The real database requires a null verdict for BLOCKED, while
            // partial criterion results above remain available for review.
            verdict: null,
          }),
        }),
      );
    },
  );

  it("completes an audited no-write attempt without quarantine", async () => {
    const { tx, submit } = fixture(0);
    await submit();
    expect(tx.executionResourceLease.updateMany).not.toHaveBeenCalled();
    expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({
            kind: "VERIFICATION_COMPLETED",
            termination: { reason: "TOOL_LIMIT_REACHED" },
          }),
        }),
      }),
    );
  });

  it("still rejects untrusted evidence when forced completion becomes blocked", async () => {
    const { outcome, submit } = fixture(1);
    await expect(
      submit(
        runtimeOutcomeSchema.parse({
          ...outcome,
          evidence: [
            {
              externalId: "artifact://invented",
              kind: "SCREENSHOT",
              label: "伪造引用",
              metadata: {},
            },
          ],
        }),
      ),
    ).rejects.toThrow("untrusted evidence");
  });

  it("retains the original failure diagnostics for ordinary failures too", async () => {
    const { tx, submit } = fixture(1);
    await submit(
      runtimeOutcomeSchema.parse({
        kind: "FATAL_FAILURE",
        executionDisposition: "AGENT_ERROR",
        summary: "工具失败。",
        error: {
          code: "AGENT_TOOL_LIMIT_EXCEEDED",
          failureClass: "TOOL_EXECUTION",
          phase: "browser_verification",
          message: "工具预算耗尽。",
          details: { count: 60 },
        },
      }),
    );
    expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: expect.objectContaining({
            details: {
              originalError: expect.objectContaining({
                code: "AGENT_TOOL_LIMIT_EXCEEDED",
                details: { count: 60 },
              }),
            },
          }),
        }),
      }),
    );
  });
});
