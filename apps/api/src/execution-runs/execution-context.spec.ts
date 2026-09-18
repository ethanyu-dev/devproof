import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { decodeStepContext, readStepContext } from "./step-context-archive.js";
import { AgentRuntimeTaskService } from "../agent-runtime/agent-runtime-task.service.js";
import {
  contextSearch,
  ExecutionContextService,
  presentCall,
} from "./execution-context.service.js";

const runId = "43939f06-348d-4437-93b7-1694cee0a203";
const callId = "a1111111-1111-4111-8111-111111111111";
function event(
  kind: string,
  sequence: number,
  payload: Record<string, unknown>,
) {
  return {
    id: `${sequence}`,
    kind,
    sequence: BigInt(sequence),
    occurredAt: new Date("2026-09-17T00:00:00Z"),
    payload,
  } as never;
}

describe("execution context history", () => {
  it("writes the archive under the leased attempt and keeps only its manifest in events", async () => {
    const now = new Date();
    const body = Buffer.from(
      JSON.stringify({ request: { messages: [], tools: [] }, metrics: {} }),
    );
    const contextSnapshot = {
      version: 1,
      encoding: "gzip-base64",
      data: gzipSync(body).toString("base64"),
      byteLength: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ now }]),
      agentRuntimeTask: {
        findFirst: vi.fn().mockResolvedValue({
          id: "task",
          runId,
          attemptId: "attempt",
          leaseOwner: "worker",
          leaseToken: "lease",
          fencingToken: 2n,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(),
      },
      runEvent: {
        create: vi.fn().mockResolvedValue({ sequence: 1n, createdAt: now }),
      },
      runStepContext: { create: vi.fn() },
    };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    };
    const service = new AgentRuntimeTaskService(prisma as never, {} as never);
    await service.appendEvent("team", "task", {
      workerId: "worker",
      leaseToken: "lease",
      fencingToken: "2",
      event: {
        eventId: "event",
        occurredAt: now.toISOString(),
        kind: "agent.model.started",
        payload: {
          attemptNumber: 1,
          segmentId: "task:2",
          step: 1,
          modelCallId: callId,
          model: "test",
          provider: "OPENAI_COMPATIBLE",
          inputPreview: {},
          contextSnapshot,
        },
      },
    });
    expect(tx.runStepContext.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: callId,
        teamId: "team",
        runId,
        attemptId: "attempt",
        taskId: "task",
        sequence: 1n,
        requestSha256: contextSnapshot.sha256,
      }),
    });
    const payload = tx.runEvent.create.mock.calls[0]![0].data.payload;
    expect(payload.contextSnapshot).toBeUndefined();
    expect(payload.contextArchive).toEqual({
      version: 1,
      sha256: contextSnapshot.sha256,
      byteLength: body.length,
    });
  });
  it("filters attempt IDs without losing tenant scope or older runs", () => {
    expect(contextSearch("team", `${runId}+2`)).toEqual({
      number: 2,
      run: { teamId: "team", id: runId },
    });
    expect(contextSearch("team", "白名单")).toEqual({
      run: {
        teamId: "team",
        goal: { contains: "白名单", mode: "insensitive" },
      },
    });
  });
  it("numbers resumed steps continuously and preserves fallback and attempt history", async () => {
    const older = {
      id: "attempt-1",
      runId,
      number: 1,
      status: "FAILED",
      createdAt: new Date(),
      finishedAt: new Date(),
      run: {
        goal: "goal",
        taskExecutionId: "parent-task",
        taskCaseExecution: {
          executionOrdinal: 2,
          caseId: "case",
          deploymentId: "deployment",
        },
      },
      _count: { stepContexts: 0 },
    };
    const attempt = {
      ...older,
      id: "attempt-2",
      number: 2,
      _count: { stepContexts: 3 },
    };
    const events = [
      event("agent.model.started", 1, {
        modelCallId: callId,
        segmentId: "task:1",
        step: 1,
      }),
      event("agent.model.failed", 2, { modelCallId: callId }),
      event("agent.model.started", 3, {
        modelCallId: "fallback",
        segmentId: "task:1",
        step: 1,
      }),
      event("agent.model.completed", 4, { modelCallId: "fallback" }),
      event("agent.model.started", 5, {
        modelCallId: "resumed",
        segmentId: "task:2",
        step: 1,
      }),
    ];
    const db = {
      runAttempt: {
        findFirst: vi.fn().mockResolvedValue(attempt),
        findMany: vi.fn().mockResolvedValue([attempt, older]),
      },
      runEvent: { findMany: vi.fn().mockResolvedValue(events) },
      runStepContext: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: callId },
            { id: "fallback" },
            { id: "resumed" },
          ]),
      },
    };
    const detail = await new ExecutionContextService(db as never).detail(
      "team",
      runId,
      2,
    );
    expect(
      detail.steps.map((s) => [s.number, s.localStep, s.calls.length]),
    ).toEqual([
      [1, 1, 2],
      [2, 1, 1],
    ]);
    expect(detail.steps[1]?.calls[0]?.status).toBe("INTERRUPTED");
    expect(detail.relatedAttempts.map((a) => a.id)).toEqual([
      `${runId}+2`,
      `${runId}+1`,
    ]);
    expect(db.runAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          run: {
            teamId: "team",
            taskExecutionId: "parent-task",
            taskCaseExecution: { caseId: "case", deploymentId: "deployment" },
          },
        },
      }),
    );
    expect(db.runEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: "team",
          attemptId: "attempt-2",
        }),
      }),
    );
  });
  it("rejects a foreign or different attempt before reading context", async () => {
    const db = {
      runAttempt: { findFirst: vi.fn().mockResolvedValue(null) },
      runStepContext: { findFirst: vi.fn() },
      runEvent: { findMany: vi.fn() },
    };
    const service = new ExecutionContextService(db as never);
    await expect(
      service.content("other-team", runId, 2, callId),
    ).rejects.toThrow("not found");
    expect(db.runAttempt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId, number: 2, run: { teamId: "other-team" } },
      }),
    );
    expect(db.runEvent.findMany).not.toHaveBeenCalled();
  });
  it("associates a fallback with its own response and distinguishes missing intent", () => {
    const start = event("agent.model.started", 1, {
      modelCallId: callId,
      segmentId: "task:1",
      step: 1,
      model: "a",
    });
    const fail = event("agent.model.failed", 2, {
      modelCallId: callId,
      durationMs: 900,
    });
    const second = event("agent.model.started", 3, {
      modelCallId: "second",
      segmentId: "task:1",
      step: 1,
      model: "b",
    });
    const done = event("agent.model.completed", 4, {
      modelCallId: "second",
      durationMs: 20,
      decisionOutput: {
        tool_calls: [
          {
            function: {
              name: "browser_command",
              arguments: JSON.stringify({ stepIntent: "打开列表筛选下拉" }),
            },
          },
        ],
      },
    });
    const events = [start, fail, second, done];
    expect(presentCall(start, events, new Set([callId]), true)).toMatchObject({
      status: "FAILED",
      intent: null,
      hasFullContext: true,
    });
    expect(presentCall(second, events, new Set(), true)).toMatchObject({
      status: "SUCCEEDED",
      intent: "打开列表筛选下拉",
      hasFullContext: false,
    });
  });
  it("verifies lossless compressed content and rejects corrupt archives", () => {
    const body = {
      request: {
        messages: [{ content: "完整上下文".repeat(10000) }],
        tools: Array.from({ length: 50 }, (_, i) => ({ name: `tool${i}` })),
      },
      metrics: {},
    };
    const bytes = Buffer.from(JSON.stringify(body));
    const archive = {
      version: 1,
      encoding: "gzip-base64",
      data: gzipSync(bytes).toString("base64"),
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const decoded = decodeStepContext(archive);
    expect(readStepContext(decoded.compressed)).toEqual(body);
    expect(() =>
      decodeStepContext({ ...archive, sha256: "0".repeat(64) }),
    ).toThrow("Invalid");
    expect(() =>
      decodeStepContext({ ...archive, byteLength: bytes.length - 1 }),
    ).toThrow("Invalid");
  });
});
