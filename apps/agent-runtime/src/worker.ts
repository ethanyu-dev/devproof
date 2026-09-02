import { randomUUID } from "node:crypto";

import {
  runtimeOutcomeSchema,
  runtimePostRunAnalysisOutcomeSchema,
  runtimeSpecAnalysisOutcomeSchema,
  type RuntimeOutcome,
  type RuntimePostRunAnalysisOutcome,
  type RuntimePostRunAnalysisTaskLease,
  type RuntimePool,
  type RuntimeSpecAnalysisOutcome,
  type RuntimeSpecAnalysisTaskLease,
  type RuntimeTaskLease,
} from "@devproof/agent-runtime-protocol";

import type {
  BrowserVerificationExecutor,
  ResponsesClientFactory,
} from "./browser-verification.executor.js";
import {
  activeLease,
  ControlPlaneClient,
  ControlPlaneError,
} from "./control-plane.client.js";
import type { RuntimeConfig } from "./config.js";
import type { SpecAnalysisExecutor } from "./spec-analysis.executor.js";
import type { PostRunAnalysisExecutor } from "./post-run-analysis.executor.js";

export class AgentRuntimeWorker {
  private boundPool: RuntimePool | undefined;
  private executor: BrowserVerificationExecutor | undefined;
  private readonly instanceWorkerId: string;
  private readonly lanes = new Map<
    string,
    { draining: boolean; promise: Promise<void> }
  >();
  private specExecutor: SpecAnalysisExecutor | undefined;
  private postRunAnalysisExecutor: PostRunAnalysisExecutor | undefined;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly controlPlane: ControlPlaneClient,
    private readonly modelClient: ResponsesClientFactory,
  ) {
    this.boundPool = config.DEVPROOF_AGENT_RUNTIME_POOL;
    this.instanceWorkerId = `${config.DEVPROOF_AGENT_WORKER_ID}:${randomUUID()}`;
  }

  async run(signal: AbortSignal) {
    log("runtime.started", {
      pool: this.boundPool ?? "CREDENTIAL_BOUND",
      workerId: this.instanceWorkerId,
    });
    try {
      while (!signal.aborted) {
        try {
          const allocation = await this.controlPlane.register(
            this.instanceWorkerId,
            signal,
          );
          this.reconcileAllocation(allocation, signal);
          await delay(allocation.refreshAfterMs, signal);
        } catch (error) {
          if (signal.aborted) break;
          log("runtime.registration.failed", { error: errorMessage(error) });
          await delay(this.config.DEVPROOF_AGENT_POLL_INTERVAL_MS, signal);
        }
      }
    } finally {
      for (const lane of this.lanes.values()) lane.draining = true;
      await Promise.allSettled(
        [...this.lanes.values()].map((lane) => lane.promise),
      );
    }
  }

  private reconcileAllocation(
    allocation: {
      analysisConcurrency: number;
      browserConcurrency: number;
      pools: Array<"SPEC_ANALYSIS" | "BROWSER_EXECUTION" | "POST_RUN_ANALYSIS">;
      specConcurrency: number;
    },
    signal: AbortSignal,
  ) {
    if (allocation.pools.length !== 1) {
      throw new Error(
        `Control plane assigned ${allocation.pools.join(", ") || "no pool"}; Runtime requires exactly one credential-bound pool.`,
      );
    }
    const assignedPool = allocation.pools[0]!;
    if (this.boundPool && assignedPool !== this.boundPool) {
      throw new Error(
        `Control plane assigned ${assignedPool}; Runtime is isolated to ${this.boundPool}.`,
      );
    }
    if (!this.boundPool) {
      this.boundPool = assignedPool;
      log("runtime.pool.bound", {
        pool: assignedPool,
        workerId: this.instanceWorkerId,
      });
    }
    const assignments = {
      POST_RUN_ANALYSIS: {
        desired: allocation.analysisConcurrency,
        lane: "analysis" as const,
        unexpected:
          allocation.browserConcurrency > 0 || allocation.specConcurrency > 0,
      },
      BROWSER_EXECUTION: {
        desired: allocation.browserConcurrency,
        lane: "browser" as const,
        unexpected:
          allocation.analysisConcurrency > 0 || allocation.specConcurrency > 0,
      },
      SPEC_ANALYSIS: {
        desired: allocation.specConcurrency,
        lane: "spec" as const,
        unexpected:
          allocation.analysisConcurrency > 0 ||
          allocation.browserConcurrency > 0,
      },
    } as const;
    const assignment = assignments[assignedPool];
    if (assignment.unexpected) {
      throw new Error(
        `Control plane returned cross-pool concurrency to isolated ${assignedPool} Runtime.`,
      );
    }
    this.reconcileLanes(assignment.lane, assignment.desired, signal);
  }

  private reconcileLanes(
    pool: "spec" | "browser" | "analysis",
    desired: number,
    signal: AbortSignal,
  ) {
    for (let index = 0; index < desired; index += 1) {
      const key = `${pool}:${index}`;
      const existing = this.lanes.get(key);
      if (existing) {
        existing.draining = false;
        continue;
      }
      const lane = { draining: false, promise: Promise.resolve() };
      lane.promise = this.runLane(pool, index, lane, signal).finally(() => {
        if (this.lanes.get(key) === lane) this.lanes.delete(key);
      });
      this.lanes.set(key, lane);
    }
    for (const [key, lane] of this.lanes) {
      if (!key.startsWith(`${pool}:`)) continue;
      const index = Number(key.slice(pool.length + 1));
      if (index >= desired) lane.draining = true;
    }
  }

  private async runLane(
    pool: "spec" | "browser" | "analysis",
    index: number,
    lane: { draining: boolean },
    signal: AbortSignal,
  ) {
    const workerId = `${this.instanceWorkerId}:${pool}:${index}`;
    while (!signal.aborted && !lane.draining) {
      try {
        if (pool === "spec") {
          const task = await this.controlPlane.claimSpec(workerId, signal);
          if (task) {
            await this.executeSpecTask(task, signal, workerId);
            continue;
          }
        } else if (pool === "browser") {
          const task = await this.controlPlane.claim(workerId, signal);
          if (task) {
            await this.executeTask(task, signal, workerId);
            continue;
          }
        } else {
          const task = await this.controlPlane.claimPostRunAnalysis(
            workerId,
            signal,
          );
          if (task) {
            await this.executePostRunAnalysisTask(task, signal, workerId);
            continue;
          }
        }
        await delay(this.config.DEVPROOF_AGENT_POLL_INTERVAL_MS, signal);
      } catch (error) {
        if (signal.aborted) return;
        log("runtime.pool_lane.failed", {
          error: errorMessage(error),
          pool,
          workerId,
        });
        await delay(this.config.DEVPROOF_AGENT_POLL_INTERVAL_MS, signal);
      }
    }
  }

  private async executeTask(
    task: RuntimeTaskLease,
    shutdown: AbortSignal,
    workerId: string,
  ) {
    const lease = activeLease(task, workerId);
    const controller = new AbortController();
    const deadline = new RuntimeDeadlineController(
      controller,
      task.snapshot.deadlineAt,
    );
    const abortFromShutdown = () => controller.abort(shutdown.reason);
    shutdown.addEventListener("abort", abortFromShutdown, { once: true });
    const heartbeat = setInterval(() => {
      void this.controlPlane
        .heartbeat(lease)
        .then((response) => {
          if (response.deadlineAt) {
            task.snapshot.deadlineAt = response.deadlineAt;
            deadline.rearm(response.deadlineAt);
          }
          if (response.hardDeadlineAt) {
            task.snapshot.hardDeadlineAt = response.hardDeadlineAt;
          }
          if (response.directive === "CANCEL") {
            controller.abort(new Error("Run cancellation requested."));
          }
        })
        .catch((error: unknown) => controller.abort(error));
    }, 15_000);

    try {
      let outcome: RuntimeOutcome;
      try {
        if (!this.executor) {
          const { BrowserVerificationExecutor } =
            await import("./browser-verification.executor.js");
          this.executor = new BrowserVerificationExecutor(
            this.modelClient,
            this.controlPlane,
            this.config.DEVPROOF_AGENT_TOOL_LIMIT,
          );
        }
        outcome = await this.executor.execute(task, lease, controller.signal);
      } catch (error) {
        if (controller.signal.aborted && isCancellation(error)) {
          log("runtime.task.cancelled", { taskId: task.taskId });
          return;
        }
        outcome = classifyFailure(error, task);
      }

      try {
        await this.submitOutcomeReliably(lease, outcome);
        log("runtime.task.completed", {
          kind: outcome.kind,
          runId: task.snapshot.runId,
          taskId: task.taskId,
        });
      } catch (submitError) {
        log("runtime.outcome.failed", {
          error: errorMessage(submitError),
          taskId: task.taskId,
        });
      }
    } finally {
      clearInterval(heartbeat);
      deadline.dispose();
      shutdown.removeEventListener("abort", abortFromShutdown);
    }
  }

  private async executeSpecTask(
    task: RuntimeSpecAnalysisTaskLease,
    shutdown: AbortSignal,
    workerId: string,
  ) {
    const lease = activeLease(task, workerId);
    const controller = new AbortController();
    const deadline = new RuntimeDeadlineController(
      controller,
      task.snapshot.deadlineAt,
    );
    const abortFromShutdown = () => controller.abort(shutdown.reason);
    shutdown.addEventListener("abort", abortFromShutdown, { once: true });
    const heartbeat = setInterval(() => {
      void this.controlPlane
        .heartbeatSpec(lease)
        .then((response) => {
          if (response.deadlineAt) deadline.rearm(response.deadlineAt);
          if (response.directive === "CANCEL") {
            controller.abort(
              new Error("Spec analysis cancellation requested."),
            );
          }
        })
        .catch((error: unknown) => controller.abort(error));
    }, 15_000);

    try {
      let outcome: RuntimeSpecAnalysisOutcome;
      try {
        if (!this.specExecutor) {
          const { SpecAnalysisExecutor } =
            await import("./spec-analysis.executor.js");
          this.specExecutor = new SpecAnalysisExecutor(
            this.modelClient,
            this.controlPlane,
            this.config.DEVPROOF_AGENT_TOOL_LIMIT,
          );
        }
        outcome = await this.specExecutor.execute(
          task,
          lease,
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted && isCancellation(error)) {
          log("runtime.spec.cancelled", { taskId: task.taskId });
          return;
        }
        outcome = classifySpecFailure(error, task);
      }
      try {
        await this.submitSpecOutcomeReliably(lease, outcome);
        log("runtime.spec.completed", {
          kind: outcome.kind,
          taskExecutionId: task.snapshot.taskExecutionId,
          taskId: task.taskId,
        });
      } catch (submitError) {
        log("runtime.spec.outcome.failed", {
          error: errorMessage(submitError),
          taskId: task.taskId,
        });
      }
    } finally {
      clearInterval(heartbeat);
      deadline.dispose();
      shutdown.removeEventListener("abort", abortFromShutdown);
    }
  }

  private async executePostRunAnalysisTask(
    task: RuntimePostRunAnalysisTaskLease,
    shutdown: AbortSignal,
    workerId: string,
  ) {
    const lease = activeLease(task, workerId);
    const controller = new AbortController();
    const deadline = new RuntimeDeadlineController(
      controller,
      task.snapshot.deadlineAt,
    );
    const abortFromShutdown = () => controller.abort(shutdown.reason);
    shutdown.addEventListener("abort", abortFromShutdown, { once: true });
    const heartbeat = setInterval(() => {
      void this.controlPlane
        .heartbeatPostRunAnalysis(lease)
        .then((response) => {
          if (response.deadlineAt) deadline.rearm(response.deadlineAt);
          if (response.directive === "CANCEL") {
            controller.abort(
              new Error("Post-run analysis cancellation requested."),
            );
          }
        })
        .catch((error: unknown) => controller.abort(error));
    }, 15_000);

    try {
      let outcome: RuntimePostRunAnalysisOutcome;
      try {
        if (!this.postRunAnalysisExecutor) {
          const { PostRunAnalysisExecutor } =
            await import("./post-run-analysis.executor.js");
          this.postRunAnalysisExecutor = new PostRunAnalysisExecutor(
            this.modelClient,
            this.controlPlane,
            this.config.DEVPROOF_POST_RUN_ANALYSIS_TOOL_LIMIT,
          );
        }
        outcome = await this.postRunAnalysisExecutor.execute(
          task,
          lease,
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted && isCancellation(error)) {
          log("runtime.post_run_analysis.cancelled", { taskId: task.taskId });
          return;
        }
        outcome = classifyPostRunAnalysisFailure(error, task);
      }
      try {
        await this.submitPostRunAnalysisOutcomeReliably(lease, outcome);
        log("runtime.post_run_analysis.completed", {
          kind: outcome.kind,
          taskExecutionId: task.snapshot.taskExecutionId,
          taskId: task.taskId,
        });
      } catch (submitError) {
        let effectiveSubmitError = submitError;
        if (
          outcome.kind === "ANALYSIS_COMPLETED" &&
          submitError instanceof ControlPlaneError &&
          submitError.status === 400
        ) {
          const fallback = runtimePostRunAnalysisOutcomeSchema.parse({
            error: {
              code: "POST_RUN_ANALYSIS_REPORT_REJECTED",
              details: { controlPlaneResponse: submitError.body },
              failureClass: "TOOL_EXECUTION",
              message:
                "The generated post-run analysis report failed control-plane validation.",
              phase: "post_run_analysis.report_validation",
            },
            executionDisposition: "AGENT_ERROR",
            kind: "RETRYABLE_FAILURE",
            summary:
              "自动优化分析报告未通过运行定位校验，已安排使用修正后的上下文重试。",
          });
          try {
            await this.submitPostRunAnalysisOutcomeReliably(lease, fallback);
            log("runtime.post_run_analysis.completed", {
              kind: fallback.kind,
              taskExecutionId: task.snapshot.taskExecutionId,
              taskId: task.taskId,
            });
            return;
          } catch (fallbackError) {
            effectiveSubmitError = fallbackError;
          }
        }
        const message = errorMessage(effectiveSubmitError);
        try {
          await this.controlPlane.appendPostRunAnalysisEvent(
            lease,
            "analysis.outcome.submit_failed",
            { message },
          );
        } catch {
          // A stale lease can prevent diagnostic persistence; stdout remains.
        }
        log("runtime.post_run_analysis.outcome.failed", {
          error: message,
          taskId: task.taskId,
        });
      }
    } finally {
      clearInterval(heartbeat);
      deadline.dispose();
      shutdown.removeEventListener("abort", abortFromShutdown);
    }
  }

  private async submitOutcomeReliably(
    lease: ReturnType<typeof activeLease>,
    outcome: RuntimeOutcome,
  ) {
    const completionId = randomUUID();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.controlPlane.submitOutcome(
          lease,
          outcome,
          completionId,
        );
      } catch (error) {
        lastError = error;
        if (error instanceof ControlPlaneError && error.status < 500)
          throw error;
      }
    }
    throw lastError;
  }

  private async submitSpecOutcomeReliably(
    lease: ReturnType<typeof activeLease>,
    outcome: RuntimeSpecAnalysisOutcome,
  ) {
    const completionId = randomUUID();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.controlPlane.submitSpecOutcome(
          lease,
          outcome,
          completionId,
        );
      } catch (error) {
        lastError = error;
        if (error instanceof ControlPlaneError && error.status < 500)
          throw error;
      }
    }
    throw lastError;
  }

  private async submitPostRunAnalysisOutcomeReliably(
    lease: ReturnType<typeof activeLease>,
    outcome: RuntimePostRunAnalysisOutcome,
  ) {
    const completionId = randomUUID();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.controlPlane.submitPostRunAnalysisOutcome(
          lease,
          outcome,
          completionId,
        );
      } catch (error) {
        lastError = error;
        if (error instanceof ControlPlaneError && error.status < 500) {
          throw error;
        }
      }
    }
    throw lastError;
  }
}

export class RuntimeDeadlineController {
  private deadlineAtMs = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly controller: AbortController,
    deadlineAt: string,
  ) {
    this.rearm(deadlineAt);
  }

  rearm(deadlineAt: string) {
    const deadlineAtMs = Date.parse(deadlineAt);
    if (!Number.isFinite(deadlineAtMs)) {
      throw new Error("Runtime task deadline is invalid.");
    }
    if (this.controller.signal.aborted || deadlineAtMs <= this.deadlineAtMs) {
      return;
    }
    this.deadlineAtMs = deadlineAtMs;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.controller.abort(new Error("Runtime task deadline exceeded.")),
      Math.max(0, deadlineAtMs - Date.now()),
    );
    this.timer.unref();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export function classifyFailure(
  error: unknown,
  task: RuntimeTaskLease,
): RuntimeOutcome {
  const message = errorMessage(error);
  const deadline = /deadline|timed? out|timeout/iu.test(message);
  const invalidToolSchema =
    /invalid schema for function|invalid.*tool.*schema|is not a valid format/iu.test(
      message,
    );
  const browser =
    !invalidToolSchema &&
    /browser|execution runner|available slot|runtime session/iu.test(message);
  const provider = /openai|provider|response|stream|rate limit|429/iu.test(
    message,
  );
  const staleLease =
    error instanceof ControlPlaneError && error.status === 409
      ? /lease|terminal|no longer accepts/iu.test(JSON.stringify(error.body))
      : false;

  return runtimeOutcomeSchema.parse({
    error: {
      code: deadline
        ? "TASK_DEADLINE_EXCEEDED"
        : invalidToolSchema
          ? "AGENT_TOOL_SCHEMA_INVALID"
          : browser
            ? "BROWSER_EXECUTION_FAILED"
            : provider
              ? "PROVIDER_FAILED"
              : staleLease
                ? "RUNTIME_LEASE_LOST"
                : "AGENT_EXECUTION_FAILED",
      details: {},
      failureClass: deadline
        ? "TIMEOUT"
        : invalidToolSchema
          ? "TOOL_EXECUTION"
          : browser
            ? "BROWSER_RUNTIME"
            : provider
              ? "PROVIDER"
              : staleLease
                ? "RUNTIME_LOST"
                : "TOOL_EXECUTION",
      message,
      phase: "browser_verification",
    },
    executionDisposition: invalidToolSchema
      ? "AGENT_ERROR"
      : browser
        ? "BROWSER_UNAVAILABLE"
        : provider
          ? "PROVIDER_ERROR"
          : staleLease
            ? "RUNTIME_LOST"
            : "AGENT_ERROR",
    kind: deadline || invalidToolSchema ? "FATAL_FAILURE" : "RETRYABLE_FAILURE",
    summary: `第 ${task.snapshot.attemptNumber} 次尝试未生成产品验证结论。`,
  });
}

export function classifySpecFailure(
  error: unknown,
  task: RuntimeSpecAnalysisTaskLease,
): RuntimeSpecAnalysisOutcome {
  const message = errorMessage(error);
  const deadline = /deadline|timed? out|timeout/iu.test(message);
  const provider = /openai|provider|response|rate limit|429/iu.test(message);
  const staleLease =
    error instanceof ControlPlaneError && error.status === 409
      ? /lease|terminal|no longer accepts/iu.test(JSON.stringify(error.body))
      : false;
  return runtimeSpecAnalysisOutcomeSchema.parse({
    error: {
      code: deadline
        ? "SPEC_ANALYSIS_DEADLINE_EXCEEDED"
        : provider
          ? "PROVIDER_FAILED"
          : staleLease
            ? "RUNTIME_LEASE_LOST"
            : "SPEC_ANALYSIS_FAILED",
      details: {},
      failureClass: deadline
        ? "TIMEOUT"
        : provider
          ? "PROVIDER"
          : staleLease
            ? "RUNTIME_LOST"
            : "TOOL_EXECUTION",
      message,
      phase: "spec_analysis",
    },
    executionDisposition: provider
      ? "PROVIDER_ERROR"
      : staleLease
        ? "RUNTIME_LOST"
        : "AGENT_ERROR",
    kind: deadline ? "FATAL_FAILURE" : "RETRYABLE_FAILURE",
    summary: `第 ${task.snapshot.attemptNumber} 次 Spec 分析未生成有效 Spec。`,
  });
}

export function classifyPostRunAnalysisFailure(
  error: unknown,
  task: RuntimePostRunAnalysisTaskLease,
): RuntimePostRunAnalysisOutcome {
  const message = errorMessage(error);
  const deadline = /deadline|timed? out|timeout/iu.test(message);
  const contextWindow =
    /context window|context length|maximum context|too many tokens|input.*too (?:large|long)/iu.test(
      message,
    );
  const provider = /openai|provider|response|rate limit|429/iu.test(message);
  const staleLease =
    error instanceof ControlPlaneError && error.status === 409
      ? /lease|terminal|no longer accepts/iu.test(JSON.stringify(error.body))
      : false;
  return runtimePostRunAnalysisOutcomeSchema.parse({
    error: {
      code: deadline
        ? "POST_RUN_ANALYSIS_DEADLINE_EXCEEDED"
        : contextWindow
          ? "POST_RUN_ANALYSIS_CONTEXT_EXCEEDED"
          : provider
            ? "PROVIDER_FAILED"
            : staleLease
              ? "RUNTIME_LEASE_LOST"
              : "POST_RUN_ANALYSIS_FAILED",
      details: {},
      failureClass: deadline
        ? "TIMEOUT"
        : contextWindow
          ? "TOOL_EXECUTION"
          : provider
            ? "PROVIDER"
            : staleLease
              ? "RUNTIME_LOST"
              : "TOOL_EXECUTION",
      message,
      phase: "post_run_analysis",
    },
    executionDisposition: contextWindow
      ? "AGENT_ERROR"
      : provider
        ? "PROVIDER_ERROR"
        : staleLease
          ? "RUNTIME_LOST"
          : "AGENT_ERROR",
    kind: deadline || contextWindow ? "FATAL_FAILURE" : "RETRYABLE_FAILURE",
    summary: `第 ${task.snapshot.attemptNumber} 次运行后分析未生成有效报告。`,
  });
}

function isCancellation(error: unknown) {
  return /cancel|aborted|aborterror/iu.test(errorMessage(error));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function log(event: string, payload: Record<string, unknown>) {
  process.stdout.write(
    JSON.stringify({
      event,
      level: "info",
      timestamp: new Date().toISOString(),
      ...payload,
    }) + "\n",
  );
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
