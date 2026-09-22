import { describe, expect, it, vi } from "vitest";

import {
  runtimeTaskSnapshotSchema,
  requiresAgentProtocol26,
} from "@devproof/agent-runtime-protocol";
import { leaseDigest } from "../runtime/session-recovery.state.js";

import {
  AgentRuntimeTaskService,
  completedOutcomeEvidenceError,
  deadlinePolicyPausesHumanWait,
  decideAdaptiveDeadlineExtension,
  hitlWaitDeadline,
  initializeExecutionBudget,
  leaseRecoveryDecision,
  readFinalizationCheckpoint,
} from "./agent-runtime-task.service.js";

const snapshot = runtimeTaskSnapshotSchema.parse({
  attemptId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
  attemptNumber: 1,
  businessReferences: [
    {
      externalId: "reference://spec/spec-1/issue",
      kind: "BUSINESS_REFERENCE",
      label: "ENG-1",
      metadata: {},
    },
  ],
  criteria: [
    {
      description: "The page matches the source requirement.",
      id: "expected-1",
      required: true,
      requiredEvidenceKinds: ["SCREENSHOT", "BUSINESS_REFERENCE"],
    },
  ],
  deadlineAt: new Date().toISOString(),
  environment: {},
  executionPolicy: {},
  goal: "Verify ENG-1.",
  runId: "285146a8-5230-4b02-832a-5eef19e8dc8a",
  teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
  traceId: "1234567890abcdef1234567890abcdef",
});

describe("Agent Runtime ownership and recovery", () => {
  it.each(["MODEL_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE", "MODEL_TIMEOUT"])(
    "persists %s cooldowns under the current lease for another worker's resume",
    async (reason) => {
      const now = new Date();
      const key = "a".repeat(64);
      const until = now.getTime() + 29 * 60_000;
      const task = {
        id: "task",
        snapshot,
        runId: snapshot.runId,
        attemptId: snapshot.attemptId,
        status: "RUNNING",
        fencingToken: 1n,
        leaseOwner: "worker",
        leaseToken: "lease",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        modelLatencyEwmaMs: null,
        modelLatencyMaxMs: 0,
      };
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ now }]),
        agentRuntimeTask: {
          findFirst: vi.fn().mockResolvedValue(task),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn(),
        },
        runEvent: {
          create: vi.fn().mockResolvedValue({ createdAt: now, sequence: 1n }),
        },
      };
      const service = new AgentRuntimeTaskService(
        { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) } as never,
        {} as never,
      );
      await service.appendEvent(snapshot.teamId, "task", {
        workerId: "worker",
        leaseToken: "lease",
        fencingToken: "1",
        event: {
          eventId: "failure",
          kind: "agent.model.failed",
          occurredAt: now.toISOString(),
          payload: {
            inputPreview: {
              candidateHealth: {
                key,
                until,
                reason,
                consecutiveFailures: 1,
              },
            },
          },
        },
      });
      expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            snapshot: expect.objectContaining({
              executionPolicy: expect.objectContaining({
                modelCooldowns: {
                  [key]: { until, reason, failures: 1 },
                },
              }),
            }),
          },
        }),
      );
    },
  );

  it.each([
    {
      name: "forced result survives unknown-write recovery",
      potentialWrites: 1,
      writeState: "UNKNOWN",
      casCount: 1,
      proved: true,
      expected: "WRITE_OUTCOME_UNKNOWN",
      checkpoint: true,
    },
    {
      name: "proven no-write epoch",
      potentialWrites: 0,
      writeState: "NO_WRITE_VERIFIED",
      casCount: 1,
      proved: true,
      expected: "RETRY_SCHEDULED",
    },
    {
      name: "empty audit is still unknown",
      potentialWrites: 0,
      writeState: "UNKNOWN",
      casCount: 1,
      proved: true,
      expected: "WRITE_OUTCOME_UNKNOWN",
    },
    {
      name: "known potential write",
      potentialWrites: 1,
      writeState: "UNKNOWN",
      casCount: 1,
      proved: true,
      expected: "WRITE_OUTCOME_UNKNOWN",
    },
    {
      name: "manual outcome resolves writes",
      potentialWrites: 2,
      writeState: "RESOLVED",
      casCount: 1,
      proved: true,
      expected: "RETRY_SCHEDULED",
    },
    {
      name: "legacy missing assessment",
      potentialWrites: 0,
      writeState: null,
      casCount: 1,
      proved: true,
      expected: "WRITE_OUTCOME_UNKNOWN",
    },
    {
      name: "read-only policy cannot override unknown assessment",
      potentialWrites: 0,
      writeState: "UNKNOWN",
      accessMode: "READ_ONLY",
      casCount: 1,
      proved: true,
      expected: "WRITE_OUTCOME_UNKNOWN",
    },
    {
      name: "closure timestamp without proof",
      potentialWrites: 0,
      writeState: "NOT_APPLICABLE",
      casCount: 1,
      proved: false,
      expected: "CLOSING",
    },
    {
      name: "bare CLOSED status without closure timestamp",
      potentialWrites: 0,
      writeState: "NOT_APPLICABLE",
      timestampMissing: true,
      casCount: 1,
      proved: false,
      expected: "CLOSING",
    },
    {
      name: "human resume waits for closure even while writes are unknown",
      humanResume: true,
      potentialWrites: 0,
      writeState: "UNKNOWN",
      casCount: 1,
      proved: false,
      expected: "HITL_CLOSING",
    },
    {
      name: "human resume creates a fresh attempt after verified safe closure",
      humanResume: true,
      potentialWrites: 0,
      writeState: "NO_WRITE_VERIFIED",
      casCount: 1,
      proved: true,
      expected: "RETRY_SCHEDULED",
    },
    {
      name: "human input cannot clear uncertain writes",
      humanResume: true,
      potentialWrites: 1,
      writeState: "UNKNOWN",
      casCount: 1,
      proved: true,
      expected: "WRITE_OUTCOME_UNKNOWN",
    },
    {
      name: "another recovery won CAS",
      potentialWrites: 0,
      writeState: "NO_WRITE_VERIFIED",
      casCount: 0,
      proved: true,
      expected: "RACE_LOST",
    },
  ])(
    "uses independent closure and write evidence: $name",
    async ({
      potentialWrites,
      checkpoint,
      writeState,
      casCount,
      proved,
      expected,
      accessMode,
      timestampMissing,
      humanResume,
    }) => {
      const deadlineAt = new Date(Date.now() + 120_000);
      const task = {
        id: "task-1",
        status: "FAILED",
        fencingToken: 2n,
        recoveryStatus: humanResume ? "HITL_CLOSING" : "CLOSING",
        attemptId: snapshot.attemptId,
        runId: snapshot.runId,
        capability: "browser.verification",
        provider: "GENERIC",
        snapshot: {
          ...snapshot,
          deadlineAt: deadlineAt.toISOString(),
          executionPolicy: {
            ...(humanResume
              ? {
                  resume: {
                    interventionId: "reply",
                    response: { account: "test-account" },
                  },
                  executionState: { phase: "PREFLIGHT", step: "check account" },
                }
              : {}),
            retryPolicy: { maxAttempts: 3, retryOn: ["RUNTIME_LOST"] },
            browser: {
              availabilityPolicy: "WAIT",
              profile: { mode: "EPHEMERAL" },
              requiredCapabilities: ["browser"],
            },
          },
        },
        attempt: {
          number: 1,
          browserExecution: {
            id: "execution-1",
            runtimeSessionId: "session-1",
          },
        },
        run: {
          teamId: snapshot.teamId,
          lifecycle: "RUNNING",
          deadlineAt,
          hardDeadlineAt: deadlineAt,
          cancelRequestedAt: null,
          infrastructureRecoveryCount: 0,
          maxAttempts: 3,
          concurrencyPolicy: { accessMode: accessMode ?? "MUTATING" },
        },
      };
      const session = {
        id: "session-1",
        status: "CLOSED",
        closureVerifiedAt: timestampMissing ? null : new Date(),
        closureEvidenceId: proved ? "proof-1" : null,
        fencingToken: 4n,
        leaseToken: "browser-lease",
        ownerTaskId: null,
      };
      const recovery = writeState
        ? {
            id: "recovery-1",
            writeOutcomeState: writeState,
            closureState: proved ? "VERIFIED" : "CLOSING",
            closureVerifiedAt: session.closureVerifiedAt,
            closureEvidenceId: session.closureEvidenceId,
          }
        : null;
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        agentRuntimeTask: {
          findFirst: vi.fn().mockResolvedValue(task),
          updateMany: vi.fn().mockResolvedValue({ count: casCount }),
          create: vi.fn().mockResolvedValue({}),
        },
        browserRuntimeSession: {
          findUnique: vi.fn().mockResolvedValue(session),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        browserRuntimeCommand: {
          count: vi.fn().mockResolvedValue(potentialWrites),
        },
        runtimeSessionRecovery: {
          findUnique: vi.fn().mockResolvedValue(recovery),
        },
        sessionClosureEvidence: {
          findUnique: vi.fn().mockResolvedValue({
            id: "proof-1",
            sessionId: "session-1",
            sessionFence: session.fencingToken,
            leaseDigest: leaseDigest(session.leaseToken),
            recoveryId: "recovery-1",
          }),
        },
        browserRuntimeSlot: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        browserRuntimeProfileLease: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        browserHumanControlLease: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        executionResourceLease: {
          count: vi.fn().mockResolvedValue(0),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        executionRun: { update: vi.fn().mockResolvedValue({}) },
        runAttempt: {
          create: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
        },
        browserExecution: { create: vi.fn().mockResolvedValue({}) },
        runEvent: {
          create: vi.fn().mockResolvedValue({}),
          findFirst: vi.fn().mockResolvedValue(null),
        },
        taskCaseExecution: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const prisma = {
        taskCaseExecution: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        agentRuntimeTask: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findMany: vi
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([task]),
        },
        browserRuntimeCommand: {
          count: vi.fn().mockResolvedValue(potentialWrites),
        },
        browserRuntimeSession: {
          findUnique: vi.fn().mockResolvedValue(session),
        },
        runtimeSessionRecovery: {
          findUnique: vi.fn().mockResolvedValue(recovery),
        },
        executionResourceLease: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
      };
      const browser = {
        releaseForExecutionRun: vi.fn().mockResolvedValue(undefined),
      };
      const service = new AgentRuntimeTaskService(
        prisma as never,
        {} as never,
        browser as never,
      );
      if (checkpoint)
        tx.runEvent.findFirst.mockResolvedValue({
          payload: checkpointPayload(),
        } as never);
      await service.recoverExpiredLeases();
      if (checkpoint) {
        expect(tx.agentRuntimeTask.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              result: expect.objectContaining({
                kind: "FATAL_FAILURE",
                executionDisposition: "BLOCKED",
                error: expect.objectContaining({
                  code: "WRITE_OUTCOME_UNKNOWN",
                  details: expect.objectContaining({
                    originalReason: "TOOL_LIMIT_REACHED",
                    pendingOutcome: expect.objectContaining({
                      criteria: expect.any(Array),
                    }),
                  }),
                }),
              }),
            }),
          }),
        );
        expect(tx.runAttempt.update).toHaveBeenCalledOnce();
        expect(tx.executionRun.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              verdict: null,
              executionDisposition: "BLOCKED",
            }),
          }),
        );
      }
      expect(tx.browserRuntimeCommand.count).not.toHaveBeenCalled();
      expect(prisma.browserRuntimeCommand.count).not.toHaveBeenCalled();
      if (expected === "RETRY_SCHEDULED") {
        expect(tx.browserRuntimeSlot.deleteMany).toHaveBeenCalledWith({
          where: {
            sessionId: session.id,
            fencingToken: session.fencingToken,
            leaseToken: session.leaseToken,
          },
        });
        expect(tx.executionResourceLease.deleteMany).toHaveBeenCalledWith({
          where: { sessionId: "session-1" },
        });
        expect(tx.agentRuntimeTask.create).toHaveBeenCalledOnce();
        if (humanResume) {
          expect(tx.agentRuntimeTask.create).toHaveBeenCalledWith(
            expect.objectContaining({
              data: expect.objectContaining({
                snapshot: expect.objectContaining({
                  attemptNumber: 2,
                  executionPolicy: expect.objectContaining({
                    resume: {
                      interventionId: "reply",
                      response: { account: "test-account" },
                    },
                    executionState: {
                      phase: "PREFLIGHT",
                      step: "check account",
                    },
                  }),
                }),
              }),
            }),
          );
        }
        expect(tx.browserExecution.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: "REQUESTED" }),
          }),
        );
        expect(
          tx.executionResourceLease.deleteMany.mock.invocationCallOrder[0],
        ).toBeGreaterThan(
          tx.agentRuntimeTask.updateMany.mock.invocationCallOrder[0]!,
        );
        expect(
          tx.executionResourceLease.deleteMany.mock.invocationCallOrder[0],
        ).toBeLessThan(tx.agentRuntimeTask.create.mock.invocationCallOrder[0]!);
      } else {
        expect(tx.browserRuntimeSlot.deleteMany).not.toHaveBeenCalled();
        expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
        expect(tx.agentRuntimeTask.create).not.toHaveBeenCalled();
      }
      if (expected === "WRITE_OUTCOME_UNKNOWN")
        expect(tx.agentRuntimeTask.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ recoveryStatus: expected }),
          }),
        );
      if (["CLOSING", "HITL_CLOSING"].includes(expected)) {
        expect(tx.agentRuntimeTask.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ recoveryStatus: expected }),
          }),
        );
      } else {
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
          tx.agentRuntimeTask.findFirst.mock.invocationCallOrder[0]!,
        );
      }
    },
  );

  it.each([
    {
      name: "UNKNOWN overrides empty current audit",
      recoveryState: "UNKNOWN",
      audited: true,
      potentialWrites: 0,
      blocked: true,
      retry: false,
    },
    {
      name: "UNASSESSED overrides empty current audit",
      recoveryState: "UNASSESSED",
      audited: true,
      potentialWrites: 0,
      blocked: true,
      retry: false,
    },
    {
      name: "legacy empty audit cannot prove no writes",
      recoveryState: null,
      audited: false,
      potentialWrites: 0,
      blocked: true,
      retry: false,
    },
    {
      name: "new audited no-write owner may retry",
      recoveryState: null,
      audited: true,
      potentialWrites: 0,
      blocked: false,
      retry: true,
    },
    {
      name: "new audited fatal outcome stays fatal",
      recoveryState: null,
      audited: true,
      potentialWrites: 0,
      fatal: true,
      blocked: false,
      retry: false,
    },
    {
      name: "a lost write response cannot retry",
      recoveryState: null,
      audited: true,
      potentialWrites: 1,
      blocked: true,
      retry: false,
    },
    {
      name: "READ_ONLY cannot override UNKNOWN",
      recoveryState: "UNKNOWN",
      audited: true,
      potentialWrites: 0,
      accessMode: "READ_ONLY",
      blocked: true,
      retry: false,
    },
  ])(
    "classifies current-owner failure safely: $name",
    async ({
      recoveryState,
      audited,
      potentialWrites,
      blocked,
      retry,
      fatal,
      accessMode,
    }) => {
      const now = new Date();
      const task = {
        id: "task-1",
        attemptId: snapshot.attemptId,
        runId: snapshot.runId,
        capability: "browser.verification",
        provider: "GENERIC",
        snapshot: {
          ...snapshot,
          executionPolicy: {
            retryPolicy: { maxAttempts: 3, retryOn: ["PROVIDER"] },
            browser: {
              availabilityPolicy: "WAIT",
              profile: { mode: "EPHEMERAL" },
              requiredCapabilities: ["browser"],
            },
          },
        },
        status: "RUNNING",
        completionId: null,
        leaseOwner: "worker-1",
        leaseToken: "token-1",
        fencingToken: 2n,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        attempt: { number: 1 },
        run: {
          lifecycle: "RUNNING",
          cancelRequestedAt: null,
          taskExecutionId: null,
          currentAttemptNumber: 1,
          deadlineAt: new Date(now.getTime() + 120_000),
          hardDeadlineAt: new Date(now.getTime() + 120_000),
          concurrencyPolicy: { accessMode: accessMode ?? "MUTATING" },
          executionPolicy: {
            retryPolicy: { maxAttempts: 3, retryOn: ["PROVIDER"] },
            deadline: { mode: "FIXED" },
          },
        },
      };
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ now }]),
        agentRuntimeTask: {
          findFirst: vi.fn().mockResolvedValue(task),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue({
            completionId: "completion-1",
            recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
          }),
          create: vi.fn(),
        },
        browserRuntimeSession: {
          findFirst: vi.fn().mockResolvedValue({
            id: "session-1",
            leaseToken: "session-lease",
            fencingToken: 4n,
            launchIdentity: audited ? { version: 1, id: "launch-id" } : null,
            launchIdentityVersion: audited ? 1 : null,
            launchHostInstanceId: audited ? "host-id" : null,
            launchConnectionGeneration: audited ? 1n : null,
            ownerTaskId: task.id,
            ownerFencingToken: task.fencingToken,
          }),
        },
        runtimeSessionRecovery: {
          findUnique: vi
            .fn()
            .mockResolvedValue(
              recoveryState ? { writeOutcomeState: recoveryState } : null,
            ),
        },
        browserRuntimeCommand: {
          findFirst: vi
            .fn()
            .mockResolvedValue(audited ? { id: "open-command" } : null),
          count: vi.fn().mockResolvedValue(potentialWrites),
        },
        executionResourceLease: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          deleteMany: vi.fn(),
        },
        runAttempt: {
          update: vi.fn().mockResolvedValue({}),
          create: vi.fn().mockResolvedValue({}),
        },
        browserExecution: { create: vi.fn().mockResolvedValue({}) },
        executionRun: { update: vi.fn().mockResolvedValue({}) },
        runEvent: {
          create: vi.fn().mockResolvedValue({}),
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      const prisma = {
        $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)),
      };
      const service = new AgentRuntimeTaskService(prisma as never, {} as never);
      const result = await service.submitOutcome(snapshot.teamId, task.id, {
        workerId: "worker-1",
        leaseToken: "token-1",
        fencingToken: "2",
        completionId: "completion-1",
        completedAt: now.toISOString(),
        outcome: {
          kind: fatal ? "FATAL_FAILURE" : "RETRYABLE_FAILURE",
          executionDisposition: "PROVIDER_ERROR",
          error: {
            code: "PROVIDER_DISCONNECTED",
            failureClass: "PROVIDER",
            message: "response lost",
            phase: "browser_verification",
            details: {},
          },
          summary: "execution interrupted",
        },
      });
      expect(result.nextAttemptScheduled).toBe(retry);
      if (retry) expect(tx.agentRuntimeTask.create).toHaveBeenCalledOnce();
      else expect(tx.agentRuntimeTask.create).not.toHaveBeenCalled();
      if (blocked) {
        expect(tx.executionRun.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              lifecycle: "COMPLETED",
              verdict: null,
              executionDisposition: "BLOCKED",
            }),
          }),
        );
        expect(tx.agentRuntimeTask.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              recoveryStatus: "WRITE_OUTCOME_UNKNOWN",
            }),
          }),
        );
      } else {
        expect(
          tx.agentRuntimeTask.update.mock.calls[0]![0].data,
        ).not.toHaveProperty("recoveryStatus");
        expect(tx.executionRun.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              executionDisposition: retry ? null : "PROVIDER_ERROR",
            }),
          }),
        );
      }
      if (recoveryState || !audited)
        expect(tx.browserRuntimeCommand.count).not.toHaveBeenCalled();
      else
        expect(tx.browserRuntimeCommand.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              source: "SYSTEM",
              commandType: "session.open",
              status: "SUCCEEDED",
              payload: { path: ["launchIdentityId"], equals: "launch-id" },
            }),
          }),
        );
      expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
    },
  );

  it("does not acknowledge renewal when another owner wins after the lease read", async () => {
    const now = new Date();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ now }]),
      agentRuntimeTask: {
        findFirst: vi.fn().mockResolvedValue({
          id: "task-1",
          status: "RUNNING",
          leaseOwner: "worker-1",
          leaseToken: "token-1",
          fencingToken: 2n,
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          cancelRequestedAt: null,
          run: {
            cancelRequestedAt: null,
            deadlineAt: new Date(now.getTime() + 60_000),
            hardDeadlineAt: new Date(now.getTime() + 60_000),
            lifecycle: "RUNNING",
          },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      browserRuntimeSession: { updateMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const service = new AgentRuntimeTaskService(prisma as never, {} as never);
    await expect(
      service.heartbeat("team-1", "task-1", {
        workerId: "worker-1",
        leaseToken: "token-1",
        fencingToken: "2",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.agentRuntimeTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fencingToken: 2n,
          leaseToken: "token-1",
          leaseOwner: "worker-1",
          leaseExpiresAt: { gt: now },
        }),
      }),
    );
    expect(tx.browserRuntimeSession.updateMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.agentRuntimeTask.findFirst.mock.invocationCallOrder[0]!,
    );
  });

  it("revokes an expired owner under the resource lock without changing an already-proven browser", async () => {
    const now = new Date();
    const task = {
      id: "task-1",
      attemptId: snapshot.attemptId,
      runId: snapshot.runId,
      fencingToken: 2n,
      leaseOwner: "worker-1",
      attempt: { browserExecution: { runtimeSessionId: "session-1" } },
      run: { teamId: snapshot.teamId, taskExecutionId: null },
    };
    const proof = {
      closureVerifiedAt: now,
      closureEvidenceId: "proof-1",
      status: "CLOSED",
      executionPermitExpiresAt: now,
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentRuntimeTask: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      browserRuntimeSession: {
        updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
          if (
            where.closureVerifiedAt === null &&
            proof.closureVerifiedAt !== null
          )
            return { count: 0 };
          Object.assign(proof, data);
          return { count: 1 };
        }),
      },
      runAttempt: { update: vi.fn().mockResolvedValue({}) },
      runEvent: {
        create: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      taskCaseExecution: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new AgentRuntimeTaskService(
      {
        agentRuntimeTask: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([task])
            .mockResolvedValueOnce([]),
        },
        $transaction: vi.fn(
          (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
        ),
      } as never,
      {} as never,
      { releaseForExecutionRun: vi.fn() } as never,
    );
    await service.recoverExpiredLeases();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.agentRuntimeTask.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.browserRuntimeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerTaskId: task.id,
          ownerFencingToken: task.fencingToken,
          closureVerifiedAt: null,
          status: { not: "CLOSED" },
        }),
      }),
    );
    expect(proof).toEqual({
      closureVerifiedAt: now,
      closureEvidenceId: "proof-1",
      status: "CLOSED",
      executionPermitExpiresAt: now,
    });
  });

  it("uses a new bounded Attempt only after closure and never replays uncertain writes", () => {
    const base = {
      closed: true,
      unknownWrite: false,
      expired: false,
      infrastructureRecoveries: 0,
      attemptNumber: 1,
      maxAttempts: 3,
    };
    expect(leaseRecoveryDecision(base)).toBe("RETRY_SCHEDULED");
    expect(
      leaseRecoveryDecision({ ...base, infrastructureRecoveries: 1 }),
    ).toBe("EXHAUSTED");
    expect(leaseRecoveryDecision({ ...base, attemptNumber: 3 })).toBe(
      "EXHAUSTED",
    );
    expect(leaseRecoveryDecision({ ...base, closed: false })).toBe("EXHAUSTED");
    expect(leaseRecoveryDecision({ ...base, unknownWrite: true })).toBe(
      "WRITE_OUTCOME_UNKNOWN",
    );
  });

  it("starts execution time at first claim while preserving the parent deadline", () => {
    const now = new Date("2026-09-04T08:00:00Z");
    expect(
      initializeExecutionBudget({
        now,
        seconds: 60,
        extensionSeconds: 30,
        parentDeadlineAt: null,
      }),
    ).toEqual({
      deadlineAt: new Date("2026-09-04T08:01:00Z"),
      hardDeadlineAt: new Date("2026-09-04T08:01:30Z"),
    });
    expect(
      initializeExecutionBudget({
        now,
        seconds: 60,
        extensionSeconds: 30,
        parentDeadlineAt: new Date("2026-09-04T08:00:45Z"),
      }),
    ).toEqual({
      deadlineAt: new Date("2026-09-04T08:00:45Z"),
      hardDeadlineAt: new Date("2026-09-04T08:00:45Z"),
    });
  });
});

function outcome(evidenceRefs: string[]) {
  return {
    criteria: [
      {
        criterionId: "expected-1",
        evidenceRefs,
        status: "PASSED" as const,
        summary: "Verified.",
      },
    ],
    evidence: snapshot.businessReferences,
    executionDisposition: "EXECUTED" as const,
    kind: "VERIFICATION_COMPLETED" as const,
    summary: "Verified.",
    verdict: "PASSED" as const,
  };
}

describe("AgentRuntimeTaskService completed evidence validation", () => {
  it("accepts explicit inconclusive criteria when no acceptance evidence was obtained", () => {
    const unfinished = {
      ...outcome([]),
      criteria: [
        {
          criterionId: "expected-1",
          evidenceRefs: [],
          status: "INCONCLUSIVE" as const,
          summary: "验证停滞，尚未取得足以判断此验收项的证据。",
        },
      ],
      verdict: "INCONCLUSIVE" as const,
    };
    expect(completedOutcomeEvidenceError(snapshot, unfinished, [])).toBeNull();
    expect(
      completedOutcomeEvidenceError(
        snapshot,
        { ...unfinished, criteria: [] },
        [],
      ),
    ).toContain("missing required criterion");
    expect(completedOutcomeEvidenceError(snapshot, outcome([]), [])).toContain(
      "missing required evidence kinds",
    );
  });

  it("accepts browser evidence without requiring legacy analysis references", () => {
    expect(
      completedOutcomeEvidenceError(
        snapshot,
        outcome(["artifact://11111111-1111-4111-8111-111111111111"]),
        [
          {
            externalId: "artifact://11111111-1111-4111-8111-111111111111",
            kind: "SCREENSHOT",
            label: "",
            metadata: {},
          },
        ],
      ),
    ).toBeNull();
  });

  it("still rejects analysis references without actual browser evidence", () => {
    expect(
      completedOutcomeEvidenceError(
        snapshot,
        outcome(["reference://spec/spec-1/issue"]),
        [],
      ),
    ).toContain("SCREENSHOT");
  });

  it("accepts a passing result with every required evidence kind", () => {
    expect(
      completedOutcomeEvidenceError(
        snapshot,
        outcome([
          "artifact://11111111-1111-4111-8111-111111111111",
          "reference://spec/spec-1/issue",
        ]),
        [
          {
            externalId: "artifact://11111111-1111-4111-8111-111111111111",
            kind: "SCREENSHOT",
            label: "",
            metadata: {},
          },
        ],
      ),
    ).toBeNull();
  });

  it("rejects evidence whose kind was invented by the Agent", () => {
    const fabricated = {
      ...outcome(["artifact://fake"]),
      evidence: [
        ...outcome([]).evidence,
        {
          externalId: "artifact://fake",
          kind: "SCREENSHOT" as const,
          label: "Fabricated",
          metadata: {},
        },
      ],
    };
    expect(completedOutcomeEvidenceError(snapshot, fabricated, [])).toContain(
      "untrusted evidence",
    );
  });
});

describe("AgentRuntimeTaskService Runtime model configuration", () => {
  it.each(["display matching", "named-resource resume"])(
    "skips %s for an older worker before acquiring a lease",
    async (scenario) => {
      const next = runtimeTaskSnapshotSchema.parse(snapshot);
      if (scenario === "display matching") {
        next.criteria[0]!.observationTargets = [
          { label: "星期", expectedText: "周一", matchMode: "DISPLAY_TEXT" },
        ];
      } else {
        next.executionPolicy.executionState = {
          records: [
            {
              id: "545",
              resourceName: "test-weekdays",
              ownership: "CREATED_THIS_RUN",
              evidenceRefs: ["artifact://creation"],
            },
          ],
        };
      }
      expect(requiresAgentProtocol26(next)).toBe(true);
      expect(requiresAgentProtocol26(snapshot)).toBe(false);
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ now: new Date() }]),
        agentRuntimeTask: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({ id: "new-task", snapshot: next })
            .mockResolvedValue(null),
          updateMany: vi.fn(),
        },
      };
      const service = new AgentRuntimeTaskService(
        {
          $transaction: (callback: (value: typeof tx) => Promise<unknown>) =>
            callback(tx),
        } as never,
        {
          candidatesForPool: vi.fn().mockResolvedValue([{ modelId: "model" }]),
        } as never,
      );
      expect(
        await service.claim(snapshot.teamId, {
          capabilities: ["BROWSER_VERIFICATION"],
          protocol: { major: 2, minor: 25, name: "devproof-agent-runtime" },
          workerId: "old-worker",
        }),
      ).toEqual({ task: null });
      expect(tx.agentRuntimeTask.updateMany).not.toHaveBeenCalled();
      expect(
        tx.agentRuntimeTask.findFirst.mock.calls[1]?.[0].where.id.notIn,
      ).toContain("new-task");
    },
  );
  it("rejects workers that cannot consume Console-managed model credentials", async () => {
    const agentModels = { candidatesForPool: vi.fn() };
    const service = new AgentRuntimeTaskService(
      {} as never,
      agentModels as never,
    );

    await expect(
      service.claim(snapshot.teamId, {
        capabilities: ["BROWSER_VERIFICATION"],
        protocol: {
          major: 2,
          minor: 1,
          name: "devproof-agent-runtime",
        },
        workerId: "legacy-worker",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(agentModels.candidatesForPool).not.toHaveBeenCalled();
  });

  it("injects the team's ordered encrypted model configuration", async () => {
    const leaseToken = "70844616-602c-475b-95f6-393015b82ed1";
    const task = {
      attemptId: snapshot.attemptId,
      fencingToken: 4n,
      id: "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken,
      run: { startedAt: null, deadlineAt: new Date(Date.now() + 60_000) },
      runId: snapshot.runId,
      snapshot,
    };
    const tx = {
      browserExecution: {
        findUnique: vi.fn().mockResolvedValue({
          runtimeSessionId: "session-1",
          status: "ACTIVE",
        }),
      },
      browserRuntimeSession: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ now: new Date() }]),
      agentRuntimeTask: {
        findFirst: vi.fn().mockResolvedValue({
          snapshot,
          id: task.id,
          snapshot,
          startedAt: null,
        }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(task),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      executionRun: { update: vi.fn().mockResolvedValue({}) },
      runAttempt: { update: vi.fn().mockResolvedValue({}) },
      runEvent: {
        create: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const modelCandidates = [
      {
        apiKey: "sk-primary",
        baseUrl: "https://primary.example.com/v1",
        displayName: "Primary",
        modelId: "gpt-primary",
      },
      {
        apiKey: "sk-fallback",
        baseUrl: "https://fallback.example.com/v1",
        displayName: "Fallback",
        modelId: "gpt-fallback",
      },
    ];
    const agentModels = {
      candidatesForPool: vi.fn().mockResolvedValue(modelCandidates),
    };
    const service = new AgentRuntimeTaskService(
      prisma as never,
      agentModels as never,
    );

    const result = await service.claim(snapshot.teamId, {
      capabilities: ["BROWSER_VERIFICATION"],
      protocol: {
        major: 2,
        minor: 2,
        name: "devproof-agent-runtime",
      },
      workerId: "worker-1",
    });

    expect(agentModels.candidatesForPool).toHaveBeenCalledWith(
      snapshot.teamId,
      "BROWSER_EXECUTION",
    );
    expect(result.task?.snapshot.modelCandidates).toEqual(modelCandidates);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.agentRuntimeTask.findFirst.mock.invocationCallOrder[0]!,
    );
  });
});

const adaptivePolicy = {
  extensionStepSeconds: 180,
  finalizationReserveSeconds: 60,
  maxExtensionSeconds: 900,
  maxModelCallSeconds: 300,
  mode: "ADAPTIVE" as const,
  refundHumanWait: true,
  slowModelThresholdSeconds: 60,
};

describe("HITL wait deadline", () => {
  const requestedAtMs = Date.parse("2026-08-28T02:00:00.000Z");

  it("pauses execution for fixed deadlines and refundable adaptive deadlines", () => {
    expect(deadlinePolicyPausesHumanWait({ mode: "FIXED" })).toBe(true);
    expect(
      deadlinePolicyPausesHumanWait({
        ...adaptivePolicy,
        refundHumanWait: true,
      }),
    ).toBe(true);
    expect(
      deadlinePolicyPausesHumanWait({
        ...adaptivePolicy,
        refundHumanWait: false,
      }),
    ).toBe(false);
  });

  it("uses the independent HITL timeout when human wait is refundable", () => {
    expect(
      hitlWaitDeadline({
        currentDeadlineAtMs: requestedAtMs + 60_000,
        pauseHumanWait: true,
        policyTimeoutSeconds: 3_600,
        requestedAtMs,
      }).toISOString(),
    ).toBe("2026-08-28T03:00:00.000Z");
  });

  it("keeps the execution deadline as the cap when pausing is disabled", () => {
    expect(
      hitlWaitDeadline({
        currentDeadlineAtMs: requestedAtMs + 60_000,
        pauseHumanWait: false,
        policyTimeoutSeconds: 3_600,
        requestedAtMs,
      }).toISOString(),
    ).toBe("2026-08-28T02:01:00.000Z");
  });

  it("honors an earlier Runtime-requested intervention expiry", () => {
    expect(
      hitlWaitDeadline({
        currentDeadlineAtMs: requestedAtMs + 60_000,
        pauseHumanWait: true,
        policyTimeoutSeconds: 3_600,
        requestedAtMs,
        requestedExpiresAtMs: requestedAtMs + 30_000,
      }).toISOString(),
    ).toBe("2026-08-28T02:00:30.000Z");
  });
});

function adaptiveState(
  overrides: Partial<
    Parameters<typeof decideAdaptiveDeadlineExtension>[0]
  > = {},
) {
  const nowMs = Date.parse("2026-08-24T01:00:00.000Z");
  return {
    activeOperation: "MODEL",
    activeOperationKey: "segment-1:4",
    activeOperationStartedAtMs: nowMs - 75_000,
    deadlineAtMs: nowMs + 45_000,
    hardDeadlineAtMs: nowMs + 900_000,
    lastDeadlineExtensionOperationKey: null,
    lastModelCompletedAtMs: null,
    lastModelLatencyMs: null,
    lastModelOperationKey: null,
    modelLatencyEwmaMs: null,
    nowMs,
    policy: adaptivePolicy,
    ...overrides,
  };
}

describe("adaptive Runtime deadline decisions", () => {
  it("requires new meaningful work after a browser bootstrap extension, despite new model IDs", () => {
    const initial = adaptiveState({ requireMeaningfulProgress: true });
    const bootstrap = decideAdaptiveDeadlineExtension(initial)!;
    expect(bootstrap.progressKey).toBe("INITIAL_OBSERVATION");
    const repeated = {
      ...initial,
      activeOperationKey: "another-model",
      lastDeadlineExtensionOperationKey: bootstrap.operationKey,
      lastDeadlineExtensionProgressKey: bootstrap.progressKey,
    };
    expect(decideAdaptiveDeadlineExtension(repeated)).toBeNull();
    const progressed = { ...repeated, lastMeaningfulProgressKey: "segment:2" };
    const extension = decideAdaptiveDeadlineExtension(progressed)!;
    expect(extension.progressKey).toBe("segment:2");
    expect(
      decideAdaptiveDeadlineExtension({
        ...progressed,
        activeOperationKey: "third-model",
        lastDeadlineExtensionProgressKey: extension.progressKey,
      }),
    ).toBeNull();
  });

  it.each([true, false])(
    "only persists meaningful successful tool progress (%s)",
    async (meaningful) => {
      const now = new Date("2026-09-10T14:00:00Z");
      const task = {
        id: "task-1",
        attemptId: snapshot.attemptId,
        runId: snapshot.runId,
        status: "RUNNING",
        fencingToken: 1n,
        leaseOwner: "worker-1",
        leaseToken: "lease-1",
        leaseExpiresAt: new Date(now.getTime() + 60000),
      };
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ now }]),
        agentRuntimeTask: {
          findFirst: vi.fn().mockResolvedValue(task),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        runEvent: {
          create: vi.fn().mockResolvedValue({ createdAt: now, sequence: 1n }),
        },
      };
      const service = new AgentRuntimeTaskService(
        {
          $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
        } as never,
        {} as never,
        {} as never,
      );
      await service.appendEvent(snapshot.teamId, task.id, {
        fencingToken: "1",
        leaseToken: "lease-1",
        workerId: "worker-1",
        event: {
          eventId: "tool-progress",
          occurredAt: now.toISOString(),
          kind: "agent.tool.completed",
          payload: {
            attemptNumber: 1,
            segmentId: "segment-1",
            step: 2,
            callId: "read-1",
            durationMs: 3,
            inputPreview: {},
            outputPreview: {},
            name: "read_observation",
            status: "SUCCEEDED",
            sourceRefs: [],
            progress: {
              meaningful,
              sequence: 2,
              repeatedSteps: meaningful ? 0 : 3,
            },
          },
        },
      });
      expect(
        tx.agentRuntimeTask.update.mock.calls[0]![0].data
          .lastMeaningfulProgressKey,
      ).toBe(meaningful ? "segment-1:2" : undefined);
    },
  );

  it("does not treat a failed model response as recent progress for a deadline extension", async () => {
    const now = new Date("2026-08-24T01:00:00.000Z");
    const task = {
      id: "task-1",
      attemptId: snapshot.attemptId,
      runId: snapshot.runId,
      status: "RUNNING",
      fencingToken: 1n,
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      modelLatencyEwmaMs: 40_000,
      modelLatencyMaxMs: 50_000,
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ now }]),
      agentRuntimeTask: {
        findFirst: vi.fn().mockResolvedValue(task),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      runEvent: {
        create: vi.fn().mockResolvedValue({ createdAt: now, sequence: 1n }),
      },
    };
    const service = new AgentRuntimeTaskService(
      {
        $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
      } as never,
      {} as never,
      {} as never,
    );
    await service.appendEvent(snapshot.teamId, task.id, {
      fencingToken: "1",
      leaseToken: "lease-1",
      workerId: "worker-1",
      event: {
        eventId: "model-failure",
        occurredAt: now.toISOString(),
        kind: "agent.model.failed",
        payload: {
          attemptNumber: 1,
          segmentId: "segment-1",
          step: 5,
          durationMs: 42_000,
          errorMessage: "Model request timed out.",
          inputPreview: {},
          model: "test-model",
          provider: "test-provider",
        },
      },
    });
    const progress = tx.agentRuntimeTask.update.mock.calls[0]![0].data;
    expect(progress.lastModelLatencyMs).toBe(42_000);
    expect(progress.lastModelCompletedAt).toBeNull();
    expect(progress.lastModelOperationKey).toBeNull();
    expect(
      decideAdaptiveDeadlineExtension(
        adaptiveState({
          activeOperation: progress.activeOperation,
          activeOperationKey: progress.activeOperationKey,
          activeOperationStartedAtMs: null,
          lastModelCompletedAtMs: progress.lastModelCompletedAt,
          lastModelLatencyMs: progress.lastModelLatencyMs,
          lastModelOperationKey: progress.lastModelOperationKey,
        }),
      ),
    ).toBeNull();
  });

  it("extends a near deadline while a model call is observably slow", () => {
    const extension = decideAdaptiveDeadlineExtension(adaptiveState());

    expect(extension).toMatchObject({
      activeModelElapsedMs: 75_000,
      extendedByMs: 180_000,
      operationKey: "segment-1:4",
      trigger: "ACTIVE_SLOW_MODEL",
    });
  });

  it("extends a near deadline after recent model progress below the slow threshold", () => {
    const state = adaptiveState({
      activeOperation: null,
      activeOperationKey: null,
      activeOperationStartedAtMs: null,
      deadlineAtMs: Date.parse("2026-08-24T01:02:00.000Z"),
      lastModelCompletedAtMs: Date.parse("2026-08-24T00:59:59.000Z"),
      lastModelLatencyMs: 42_000,
      lastModelOperationKey: "segment-1:5",
    });

    expect(decideAdaptiveDeadlineExtension(state)).toMatchObject({
      extendedByMs: 180_000,
      operationKey: "segment-1:5",
      trigger: "RECENT_MODEL_PROGRESS",
    });
  });

  it("does not extend for stale completed model progress", () => {
    const state = adaptiveState({
      activeOperation: null,
      activeOperationKey: null,
      activeOperationStartedAtMs: null,
      lastModelCompletedAtMs: Date.parse("2026-08-24T00:54:59.000Z"),
      lastModelLatencyMs: 42_000,
      lastModelOperationKey: "segment-1:5",
    });

    expect(decideAdaptiveDeadlineExtension(state)).toBeNull();
  });

  it("does not spend extension budget when there is ample time", () => {
    expect(
      decideAdaptiveDeadlineExtension(
        adaptiveState({ deadlineAtMs: Date.parse("2026-08-24T01:10:00.000Z") }),
      ),
    ).toBeNull();
  });

  it("extends at most once for the same model operation", () => {
    expect(
      decideAdaptiveDeadlineExtension(
        adaptiveState({
          lastDeadlineExtensionOperationKey: "segment-1:4",
        }),
      ),
    ).toBeNull();
  });

  it("never extends beyond the hard deadline", () => {
    const state = adaptiveState({
      hardDeadlineAtMs: Date.parse("2026-08-24T01:01:30.000Z"),
    });

    expect(decideAdaptiveDeadlineExtension(state)?.deadlineAtMs).toBe(
      state.hardDeadlineAtMs,
    );
  });

  it("does not resurrect an already expired run", () => {
    const nowMs = Date.parse("2026-08-24T01:00:00.000Z");
    expect(
      decideAdaptiveDeadlineExtension(
        adaptiveState({ deadlineAtMs: nowMs, nowMs }),
      ),
    ).toBeNull();
  });
});

function checkpointPayload() {
  return {
    fencingToken: "1",
    reason: "TOOL_LIMIT_REACHED",
    pendingOutcome: {
      kind: "VERIFICATION_COMPLETED",
      executionDisposition: "EXECUTED",
      termination: { reason: "TOOL_LIMIT_REACHED" },
      verdict: "INCONCLUSIVE",
      summary: "工具调用预算已用尽。",
      evidence: [],
      criteria: [
        {
          criterionId: "expected-1",
          status: "INCONCLUSIVE",
          summary: "尚未验证。",
          evidenceRefs: [],
        },
      ],
    },
  };
}

describe("finalization checkpoints", () => {
  it.each(["LOCATOR_RECOVERY_EXHAUSTED", "RUNTIME_SESSION_UNAVAILABLE"])(
    "retains %s through fenced recovery",
    (reason) => {
      const checkpoint = checkpointPayload();
      checkpoint.reason = reason;
      checkpoint.pendingOutcome.termination.reason = checkpoint.reason;
      expect(readFinalizationCheckpoint(checkpoint, 1n)).toEqual({
        reason: checkpoint.reason,
        outcome: checkpoint.pendingOutcome,
      });
      expect(readFinalizationCheckpoint(checkpoint, 2n)).toBeNull();
    },
  );

  it("retains pending criteria only for the lost fence and matching termination", () => {
    expect(readFinalizationCheckpoint(checkpointPayload(), 1n)?.reason).toBe(
      "TOOL_LIMIT_REACHED",
    );
    expect(readFinalizationCheckpoint(checkpointPayload(), 2n)).toBeNull();
    expect(
      readFinalizationCheckpoint(
        { ...checkpointPayload(), reason: "TEXT_ONLY_LOOP" },
        1n,
      ),
    ).toBeNull();
    expect(
      readFinalizationCheckpoint(
        { ...checkpointPayload(), pendingOutcome: {} },
        1n,
      ),
    ).toBeNull();
  });
});

describe("account request API boundary", () => {
  function boundary(policy: Record<string, unknown>, evidence: unknown[] = []) {
    const now = new Date();
    const task = {
      id: "task-account",
      attemptId: snapshot.attemptId,
      runId: snapshot.runId,
      snapshot: { ...snapshot, executionPolicy: policy },
      status: "RUNNING",
      completionId: null,
      leaseOwner: "worker",
      leaseToken: "lease",
      fencingToken: 1n,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      attempt: { number: 1 },
      run: {
        lifecycle: "RUNNING",
        cancelRequestedAt: null,
        executionPolicy: { retryPolicy: { maxAttempts: 1, retryOn: [] } },
      },
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ now }]),
      agentRuntimeTask: {
        findFirst: vi.fn().mockResolvedValue(task),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockRejectedValue(new Error("reached-state-write")),
      },
      runEvidence: { findMany: vi.fn().mockResolvedValue(evidence) },
    };
    const service = new AgentRuntimeTaskService(
      { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) } as never,
      {} as never,
    );
    const submit = (
      context: Record<string, unknown>,
      kind = "TEST_ACCOUNT",
      responseSchema = {},
    ) =>
      service.submitOutcome(snapshot.teamId, task.id, {
        workerId: "worker",
        leaseToken: "lease",
        fencingToken: "1",
        completionId: "completion",
        completedAt: now.toISOString(),
        outcome: {
          kind: "WAITING_HUMAN",
          executionDisposition: "BLOCKED",
          summary: "补充业务账号",
          intervention: {
            kind,
            prompt: "请提供被测用户",
            context,
            responseSchema,
            expiresAt: new Date(now.getTime() + 60_000).toISOString(),
          },
        },
      } as never);
    return { submit, tx };
  }
  const policy = { accountRequirements: { version: 2, requirements: [] } };
  const request = {
    mode: "DISCOVERED",
    subjectKind: "BUSINESS_INPUT",
    target: "用户 ID",
    criterionId: "expected-1",
    usage: "READ_EXISTING",
    requiredTypes: [],
    observation: {
      observationId: "02a9dede-21ea-4b58-95db-56fa0f9c8133",
      cursor: 0,
      quote: "请输入用户 ID",
      evidenceRefs: ["artifact://account-field"],
    },
  };
  it.each([
    {},
    { purpose: "BUSINESS_TEST_SUBJECT" },
    { accountRequest: { mode: "DECLARED", slotIds: ["operator:1"] } },
  ])(
    "rejects ungrounded requests without creating a wait: %j",
    async (context) => {
      const h = boundary(policy);
      await expect(h.submit(context)).rejects.toMatchObject({
        response: { code: "ACCOUNT_REQUEST_INVALID" },
      });
      expect(h.tx.agentRuntimeTask.update).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { ownerTaskId: "another-task", result: { content: "请输入用户 ID" } },
    { ownerTaskId: "task-account", result: { content: "登录页" } },
  ])(
    "rejects spoofed, foreign or irrelevant browser evidence",
    async (command) => {
      const h = boundary(policy, [
        {
          externalId: "artifact://account-field",
          kind: "DOM",
          runtimeArtifact: { command },
        },
      ]);
      await expect(h.submit({ accountRequest: request })).rejects.toMatchObject(
        { response: { code: "ACCOUNT_REQUEST_INVALID" } },
      );
      expect(h.tx.agentRuntimeTask.update).not.toHaveBeenCalled();
    },
  );
  it("accepts only persisted browser content belonging to this task and derives the form", async () => {
    const h = boundary(policy, [
      {
        externalId: "artifact://account-field",
        kind: "DOM",
        runtimeArtifact: {
          command: {
            ownerTaskId: "task-account",
            result: { content: "请输入用户 ID" },
          },
        },
      },
    ]);
    await expect(
      h.submit({ accountRequest: request, usage: "CREATE_OR_MODIFY" }),
    ).rejects.toThrow("reached-state-write");
    expect(h.tx.runEvidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          attemptId: snapshot.attemptId,
          runId: snapshot.runId,
          externalId: { in: ["artifact://account-field"] },
        },
      }),
    );
    expect(h.tx.agentRuntimeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({
            intervention: expect.objectContaining({
              context: expect.objectContaining({
                usage: "READ_EXISTING",
                purpose: "BUSINESS_TEST_SUBJECT",
                accountSlots: [
                  expect.objectContaining({
                    slotId: "discovered:1",
                    usage: "READ_EXISTING",
                  }),
                ],
              }),
            }),
          }),
        }),
      }),
    );
  });
  it("does not let other HITL kinds carry an account form", async () => {
    const h = boundary(policy);
    await expect(
      h.submit({}, "BROWSER_HITL", {
        properties: { account: { type: "string" } },
      }),
    ).rejects.toMatchObject({ response: { code: "ACCOUNT_REQUEST_INVALID" } });
    expect(h.tx.agentRuntimeTask.update).not.toHaveBeenCalled();
  });
});

it("does not lease a structured-account task to a pre-v20 browser worker", async () => {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ now: new Date() }]),
    agentRuntimeTask: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({
          id: "new-contract-task",
          snapshot: {
            ...snapshot,
            executionPolicy: {
              accountRequirements: { version: 2, requirements: [] },
            },
          },
        })
        .mockResolvedValue(null),
      updateMany: vi.fn(),
    },
  };
  const service = new AgentRuntimeTaskService(
    { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) } as never,
    {
      candidatesForPool: vi.fn().mockResolvedValue([{ modelId: "test" }]),
    } as never,
  );
  expect(
    await service.claim(snapshot.teamId, {
      protocol: { minor: 19 },
      workerId: "old-worker",
      capabilities: ["BROWSER_VERIFICATION"],
    } as never),
  ).toEqual({ task: null });
  expect(tx.agentRuntimeTask.updateMany).not.toHaveBeenCalled();
  expect(
    tx.agentRuntimeTask.findFirst.mock.calls[1]![0].where.id.notIn,
  ).toEqual(["new-contract-task"]);
});
