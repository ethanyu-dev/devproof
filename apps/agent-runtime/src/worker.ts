import { randomUUID } from "node:crypto";

import {
  runtimeOutcomeSchema,
  type RuntimeOutcome,
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

export class AgentRuntimeWorker {
  private readonly executor: BrowserVerificationExecutor;

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
  }

  async run(signal: AbortSignal) {
    log("runtime.started", {
      workerId: this.config.DEVPROOF_AGENT_WORKER_ID,
    });
    while (!signal.aborted) {
      try {
        const task = await this.controlPlane.claim(
          this.config.DEVPROOF_AGENT_WORKER_ID,
          signal,
        );
        if (!task) {
          await delay(this.config.DEVPROOF_AGENT_POLL_INTERVAL_MS, signal);
          continue;
        }
        await this.executeTask(task, signal);
      } catch (error) {
        if (signal.aborted) return;
        log("runtime.poll.failed", { error: errorMessage(error) });
        await delay(this.config.DEVPROOF_AGENT_POLL_INTERVAL_MS, signal);
      }
    }
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
    summary: `Attempt ${task.snapshot.attemptNumber} did not produce a product verdict.`,
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
