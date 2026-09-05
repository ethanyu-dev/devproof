import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RuntimePostRunAnalysisTaskLease,
  RuntimeSpecAnalysisTaskLease,
  RuntimeTaskLease,
} from "@devproof/agent-runtime-protocol";

import {
  AgentRuntimeWorker,
  classifyFailure,
  classifyPostRunAnalysisFailure,
  RuntimeDeadlineController,
} from "./worker.js";
import { ControlPlaneError } from "./control-plane.client.js";
import { LeaseLostError } from "./lease-supervisor.js";

const task = {
  snapshot: { attemptNumber: 2 },
} as RuntimeTaskLease;

describe("Spec Runtime lease ownership", () => {
  afterEach(() => vi.useRealTimers());

  function setup(heartbeatSpec: ReturnType<typeof vi.fn>) {
    vi.useFakeTimers();
    let executionSignal!: AbortSignal;
    let finish!: () => void;
    const submitSpecOutcome = vi.fn().mockResolvedValue({ accepted: true });
    const worker = new AgentRuntimeWorker(
      { DEVPROOF_AGENT_WORKER_ID: "spec-worker" } as never,
      { heartbeatSpec, submitSpecOutcome } as never,
      vi.fn() as never,
    );
    const internal = worker as unknown as {
      specExecutor: { execute: ReturnType<typeof vi.fn> };
      executeSpecTask(
        task: RuntimeSpecAnalysisTaskLease,
        signal: AbortSignal,
        workerId: string,
      ): Promise<void>;
    };
    internal.specExecutor = {
      execute: vi.fn((_task, _lease, signal: AbortSignal) => {
        executionSignal = signal;
        return new Promise((resolve) => {
          // A late model result must not be submitted after ownership is lost.
          finish = () => resolve({ kind: "SPEC_GENERATED" });
        });
      }),
    };
    const running = internal.executeSpecTask(
      {
        fencingToken: "1",
        leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        leaseDurationMs: 60_000,
        snapshot: { deadlineAt: new Date(Date.now() + 600_000).toISOString() },
        taskId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      } as RuntimeSpecAnalysisTaskLease,
      new AbortController().signal,
      "spec-worker",
    );
    return {
      finish: () => finish(),
      running,
      signal: () => executionSignal,
      submitSpecOutcome,
    };
  }

  it("keeps a Spec execution alive through a transient heartbeat failure", async () => {
    const heartbeat = vi
      .fn()
      .mockRejectedValueOnce(new Error("network disconnected"))
      .mockImplementation(async () => ({
        directive: "CONTINUE",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        leaseDurationMs: 60_000,
      }));
    const state = setup(heartbeat);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.signal().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(heartbeat.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(state.signal().aborted).toBe(false);
    state.finish();
    await state.running;
    expect(state.submitSpecOutcome).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it("bounds hung renewals and aborts before lease expiry without replaying an outcome", async () => {
    let activeRequests = 0;
    let peakRequests = 0;
    const heartbeat = vi.fn(
      (_lease, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          peakRequests = Math.max(peakRequests, ++activeRequests);
          signal.addEventListener(
            "abort",
            () => {
              activeRequests -= 1;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const state = setup(heartbeat);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(peakRequests).toBe(1);
    expect(heartbeat.mock.calls.length).toBeGreaterThan(1);
    expect(state.signal().reason).toBeInstanceOf(LeaseLostError);
    expect(activeRequests).toBe(0);
    state.finish();
    await state.running;
    expect(state.submitSpecOutcome).not.toHaveBeenCalled();
  });

  it("drops a late completed Spec when the server rejects its owner", async () => {
    const state = setup(
      vi
        .fn()
        .mockRejectedValue(
          new ControlPlaneError(409, { code: "RUNTIME_LEASE_LOST" }),
        ),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.signal().reason).toBeInstanceOf(LeaseLostError);
    state.finish();
    await state.running;
    expect(state.submitSpecOutcome).not.toHaveBeenCalled();
  });

  it("cancels an in-flight outcome and does not retry it after lease loss", async () => {
    const state = setup(
      vi
        .fn()
        .mockRejectedValue(
          new ControlPlaneError(409, { code: "RUNTIME_LEASE_LOST" }),
        ),
    );
    state.submitSpecOutcome.mockImplementation(
      (_lease, _outcome, _completionId, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    state.finish();
    await vi.advanceTimersByTimeAsync(15_000);
    await state.running;
    expect(state.submitSpecOutcome).toHaveBeenCalledOnce();
    expect(state.submitSpecOutcome.mock.calls[0]?.[3]).toBe(state.signal());
    expect(state.signal().reason).toBeInstanceOf(LeaseLostError);
  });
});

describe("Agent Runtime failure classification", () => {
  it("classifies provider disconnects without a product verdict", () => {
    const outcome = classifyFailure(
      new Error("OpenAI provider stream disconnected."),
      task,
    );

    expect(outcome).toMatchObject({
      executionDisposition: "PROVIDER_ERROR",
      kind: "RETRYABLE_FAILURE",
    });
    expect(outcome).not.toHaveProperty("verdict");
  });

  it("classifies an adaptive model-call cutoff as a retryable provider error", () => {
    expect(
      classifyFailure(new Error("Model response exceeded 300 seconds."), task),
    ).toMatchObject({
      error: { failureClass: "PROVIDER" },
      executionDisposition: "PROVIDER_ERROR",
      kind: "RETRYABLE_FAILURE",
    });
  });

  it("classifies browser capacity separately from assertion failures", () => {
    const outcome = classifyFailure(
      new Error("Browser Runtime has no available slot."),
      task,
    );

    expect(outcome).toMatchObject({
      executionDisposition: "BROWSER_UNAVAILABLE",
      kind: "RETRYABLE_FAILURE",
    });
    expect(outcome).not.toHaveProperty("verdict");
  });

  it("does not retry deterministic model tool schema errors", () => {
    const outcome = classifyFailure(
      new Error(
        "400 Invalid schema for function 'browser_command': 'uri' is not a valid format.",
      ),
      task,
    );

    expect(outcome).toMatchObject({
      error: {
        code: "AGENT_TOOL_SCHEMA_INVALID",
        failureClass: "TOOL_EXECUTION",
      },
      executionDisposition: "AGENT_ERROR",
      kind: "FATAL_FAILURE",
    });
  });

  it("does not retry a deterministic post-run context overflow", () => {
    const outcome = classifyPostRunAnalysisFailure(
      new Error("Your input exceeds the context window of this model."),
      { snapshot: { attemptNumber: 2 } } as RuntimePostRunAnalysisTaskLease,
    );

    expect(outcome).toMatchObject({
      error: {
        code: "POST_RUN_ANALYSIS_CONTEXT_EXCEEDED",
        failureClass: "TOOL_EXECUTION",
      },
      executionDisposition: "AGENT_ERROR",
      kind: "FATAL_FAILURE",
    });
  });
});

describe("Agent Runtime post-run outcome submission", () => {
  it("converts a rejected completed report into a retryable terminal outcome", async () => {
    const submitPostRunAnalysisOutcome = vi
      .fn()
      .mockRejectedValueOnce(
        new ControlPlaneError(400, {
          message: "Invalid analysis finding runtime location",
        }),
      )
      .mockResolvedValueOnce({ accepted: true, jobStatus: "READY" });
    const controlPlane = {
      appendPostRunAnalysisEvent: vi.fn().mockResolvedValue({ accepted: true }),
      heartbeatPostRunAnalysis: vi.fn(),
      submitPostRunAnalysisOutcome,
    };
    const worker = new AgentRuntimeWorker(
      {
        DEVPROOF_AGENT_TOOL_LIMIT: 10,
        DEVPROOF_AGENT_WORKER_ID: "worker-1",
      } as never,
      controlPlane as never,
      vi.fn() as never,
    );
    (
      worker as unknown as {
        postRunAnalysisExecutor: {
          execute(): Promise<unknown>;
        };
      }
    ).postRunAnalysisExecutor = {
      execute: vi.fn().mockResolvedValue({
        kind: "ANALYSIS_COMPLETED",
        report: { findings: [], summary: "分析完成。" },
      }),
    };
    const postRunTask = {
      fencingToken: "3",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      snapshot: {
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
      },
      taskId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
    } as RuntimePostRunAnalysisTaskLease;

    await (
      worker as unknown as {
        executePostRunAnalysisTask(
          task: RuntimePostRunAnalysisTaskLease,
          signal: AbortSignal,
          workerId: string,
        ): Promise<void>;
      }
    ).executePostRunAnalysisTask(
      postRunTask,
      new AbortController().signal,
      "worker-1",
    );

    expect(submitPostRunAnalysisOutcome).toHaveBeenCalledTimes(2);
    expect(submitPostRunAnalysisOutcome.mock.calls[1]?.[1]).toMatchObject({
      error: { code: "POST_RUN_ANALYSIS_REPORT_REJECTED" },
      kind: "RETRYABLE_FAILURE",
    });
    expect(submitPostRunAnalysisOutcome.mock.calls[0]?.[2]).not.toBe(
      submitPostRunAnalysisOutcome.mock.calls[1]?.[2],
    );
  });

  it("drains an active analysis instead of aborting it on process shutdown", async () => {
    let finishExecution!: (value: {
      kind: "ANALYSIS_COMPLETED";
      report: { findings: never[]; summary: string };
    }) => void;
    const execution = new Promise<{
      kind: "ANALYSIS_COMPLETED";
      report: { findings: never[]; summary: string };
    }>((resolve) => {
      finishExecution = resolve;
    });
    let executionSignal: AbortSignal | undefined;
    const submitPostRunAnalysisOutcome = vi
      .fn()
      .mockResolvedValue({ accepted: true, jobStatus: "SUCCEEDED" });
    const worker = new AgentRuntimeWorker(
      {
        DEVPROOF_AGENT_TOOL_LIMIT: 10,
        DEVPROOF_AGENT_WORKER_ID: "worker-1",
      } as never,
      {
        appendPostRunAnalysisEvent: vi.fn(),
        heartbeatPostRunAnalysis: vi.fn(),
        submitPostRunAnalysisOutcome,
      } as never,
      vi.fn() as never,
    );
    (
      worker as unknown as {
        postRunAnalysisExecutor: {
          execute(
            _task: unknown,
            _lease: unknown,
            signal: AbortSignal,
          ): typeof execution;
        };
      }
    ).postRunAnalysisExecutor = {
      execute: vi.fn((_task, _lease, signal) => {
        executionSignal = signal;
        return execution;
      }),
    };
    const postRunTask = {
      fencingToken: "3",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      snapshot: {
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
      },
      taskId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
    } as RuntimePostRunAnalysisTaskLease;
    const shutdown = new AbortController();

    const running = (
      worker as unknown as {
        executePostRunAnalysisTask(
          task: RuntimePostRunAnalysisTaskLease,
          signal: AbortSignal,
          workerId: string,
        ): Promise<void>;
      }
    ).executePostRunAnalysisTask(postRunTask, shutdown.signal, "worker-1");
    await vi.waitFor(() => expect(executionSignal).toBeDefined());

    shutdown.abort(new Error("SIGTERM"));
    expect(executionSignal?.aborted).toBe(false);

    finishExecution({
      kind: "ANALYSIS_COMPLETED",
      report: { findings: [], summary: "分析完成。" },
    });
    await running;
    expect(submitPostRunAnalysisOutcome).toHaveBeenCalledOnce();
  });
});

describe("Agent Runtime pool isolation", () => {
  it("binds an undeclared Runtime to its credential pool", () => {
    const worker = new AgentRuntimeWorker(
      {
        DEVPROOF_AGENT_WORKER_ID: "credential-bound-worker",
      } as never,
      {} as never,
      vi.fn() as never,
    );
    const reconcileLanes = vi.fn();
    (
      worker as unknown as {
        reconcileLanes: typeof reconcileLanes;
      }
    ).reconcileLanes = reconcileLanes;

    (
      worker as unknown as {
        reconcileAllocation(
          allocation: Record<string, unknown>,
          signal: AbortSignal,
        ): void;
      }
    ).reconcileAllocation(
      {
        analysisConcurrency: 0,
        browserConcurrency: 0,
        pools: ["SPEC_ANALYSIS"],
        specConcurrency: 3,
      },
      new AbortController().signal,
    );

    expect(reconcileLanes).toHaveBeenCalledWith(
      "spec",
      3,
      expect.any(AbortSignal),
    );
  });

  it("rejects a pool change after credential binding", () => {
    const worker = new AgentRuntimeWorker(
      {
        DEVPROOF_AGENT_WORKER_ID: "credential-bound-worker",
      } as never,
      {} as never,
      vi.fn() as never,
    );
    const reconcileAllocation = (allocation: Record<string, unknown>): void =>
      (
        worker as unknown as {
          reconcileAllocation(
            value: Record<string, unknown>,
            signal: AbortSignal,
          ): void;
        }
      ).reconcileAllocation(allocation, new AbortController().signal);

    reconcileAllocation({
      analysisConcurrency: 0,
      browserConcurrency: 0,
      pools: ["SPEC_ANALYSIS"],
      specConcurrency: 0,
    });

    expect(() =>
      reconcileAllocation({
        analysisConcurrency: 0,
        browserConcurrency: 0,
        pools: ["BROWSER_EXECUTION"],
        specConcurrency: 0,
      }),
    ).toThrow(/isolated to SPEC_ANALYSIS/u);
  });

  it("creates lanes only for its declared pool", () => {
    const worker = new AgentRuntimeWorker(
      {
        DEVPROOF_AGENT_RUNTIME_POOL: "SPEC_ANALYSIS",
        DEVPROOF_AGENT_WORKER_ID: "spec-worker",
      } as never,
      {} as never,
      vi.fn() as never,
    );
    const reconcileLanes = vi.fn();
    (
      worker as unknown as {
        reconcileAllocation(
          allocation: Record<string, unknown>,
          signal: AbortSignal,
        ): void;
        reconcileLanes: typeof reconcileLanes;
      }
    ).reconcileLanes = reconcileLanes;

    (
      worker as unknown as {
        reconcileAllocation(
          allocation: Record<string, unknown>,
          signal: AbortSignal,
        ): void;
      }
    ).reconcileAllocation(
      {
        analysisConcurrency: 0,
        browserConcurrency: 0,
        pools: ["SPEC_ANALYSIS"],
        specConcurrency: 5,
      },
      new AbortController().signal,
    );

    expect(reconcileLanes).toHaveBeenCalledWith(
      "spec",
      5,
      expect.any(AbortSignal),
    );
  });

  it("rejects cross-pool allocations", () => {
    const worker = new AgentRuntimeWorker(
      {
        DEVPROOF_AGENT_RUNTIME_POOL: "BROWSER_EXECUTION",
        DEVPROOF_AGENT_WORKER_ID: "browser-worker",
      } as never,
      {} as never,
      vi.fn() as never,
    );

    expect(() =>
      (
        worker as unknown as {
          reconcileAllocation(
            allocation: Record<string, unknown>,
            signal: AbortSignal,
          ): void;
        }
      ).reconcileAllocation(
        {
          analysisConcurrency: 1,
          browserConcurrency: 2,
          pools: ["BROWSER_EXECUTION"],
          specConcurrency: 0,
        },
        new AbortController().signal,
      ),
    ).toThrow(/cross-pool concurrency/u);
  });
});

describe("RuntimeDeadlineController", () => {
  afterEach(() => vi.useRealTimers());

  it("re-arms the local abort timer when the control plane extends a run", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-24T01:00:00.000Z");
    vi.setSystemTime(startedAt);
    const abort = new AbortController();
    const deadline = new RuntimeDeadlineController(
      abort,
      new Date(startedAt + 1_000).toISOString(),
    );

    await vi.advanceTimersByTimeAsync(500);
    deadline.rearm(new Date(startedAt + 2_000).toISOString());
    deadline.rearm(new Date(startedAt + 750).toISOString());
    await vi.advanceTimersByTimeAsync(600);
    expect(abort.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(900);
    expect(abort.signal.aborted).toBe(true);
    deadline.dispose();
  });
});
