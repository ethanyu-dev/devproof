import { randomUUID } from "node:crypto";

import {
  runtimeOutcomeSchema,
  runtimeSpecAnalysisOutcomeSchema,
  type RuntimeOutcome,
  type RuntimeSpecAnalysisOutcome,
  type RuntimeSpecAnalysisTaskLease,
  type RuntimeTaskLease,
} from "@devproof/agent-runtime-protocol";

import {
  BrowserVerificationExecutor,
  type ResponsesClientFactory,
} from "./browser-verification.executor.js";
import {
  activeLease,
  ControlPlaneClient,
  ControlPlaneError,
} from "./control-plane.client.js";
import type { RuntimeConfig } from "./config.js";
import { SpecAnalysisExecutor } from "./spec-analysis.executor.js";

export class AgentRuntimeWorker {
  private readonly executor: BrowserVerificationExecutor;
  private readonly specExecutor: SpecAnalysisExecutor;
  private preferSpec = true;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly controlPlane: ControlPlaneClient,
    modelClient: ResponsesClientFactory,
  ) {
    this.executor = new BrowserVerificationExecutor(
      modelClient,
      controlPlane,
      config.DEVPROOF_AGENT_TOOL_LIMIT,
    );
    this.specExecutor = new SpecAnalysisExecutor(
      modelClient,
      controlPlane,
      config.DEVPROOF_AGENT_TOOL_LIMIT,
    );
  }

  async run(signal: AbortSignal) {
    log("runtime.started", {
      workerId: this.config.DEVPROOF_AGENT_WORKER_ID,
    });
    while (!signal.aborted) {
      try {
        const task = await this.claimNext(signal);
        if (!task) {
          await delay(this.config.DEVPROOF_AGENT_POLL_INTERVAL_MS, signal);
          continue;
        }
        if (task.kind === "SPEC_ANALYSIS") {
          await this.executeSpecTask(task.task, signal);
        } else {
          await this.executeTask(task.task, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        log("runtime.poll.failed", { error: errorMessage(error) });
        await delay(this.config.DEVPROOF_AGENT_POLL_INTERVAL_MS, signal);
      }
    }
  }

  private async claimNext(signal: AbortSignal) {
    const workerId = this.config.DEVPROOF_AGENT_WORKER_ID;
    const first = this.preferSpec ? "SPEC_ANALYSIS" : "BROWSER_VERIFICATION";
    this.preferSpec = !this.preferSpec;
    if (first === "SPEC_ANALYSIS") {
      const spec = await this.controlPlane.claimSpec(workerId, signal);
      if (spec) return { kind: "SPEC_ANALYSIS" as const, task: spec };
      const browser = await this.controlPlane.claim(workerId, signal);
      return browser
        ? { kind: "BROWSER_VERIFICATION" as const, task: browser }
        : null;
    }
    const browser = await this.controlPlane.claim(workerId, signal);
    if (browser)
      return { kind: "BROWSER_VERIFICATION" as const, task: browser };
    const spec = await this.controlPlane.claimSpec(workerId, signal);
    return spec ? { kind: "SPEC_ANALYSIS" as const, task: spec } : null;
  }

  private async executeTask(task: RuntimeTaskLease, shutdown: AbortSignal) {
    const lease = activeLease(task, this.config.DEVPROOF_AGENT_WORKER_ID);
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
  ) {
    const lease = activeLease(task, this.config.DEVPROOF_AGENT_WORKER_ID);
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
