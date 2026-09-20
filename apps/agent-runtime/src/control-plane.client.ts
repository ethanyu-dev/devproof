import { createHash } from "node:crypto";
import { ModelTelemetrySpool } from "./model-telemetry-spool.js";
import type {
  ModelCallRegistration,
  ModelCallTelemetry,
  RuntimeModelCandidate,
} from "@devproof/agent-runtime-protocol";
import {
  BOUND_EVIDENCE_CAPABILITIES,
  BUSINESS_CHECK_CAPABILITY,
  EVIDENCE_CATALOG_CAPABILITY,
  TYPED_CHECKS_CAPABILITY,
} from "@devproof/agent-runtime-protocol";
import {
  acceptanceReviewClaimOutputSchema,
  type AcceptanceReviewResult,
} from "@devproof/agent-runtime-protocol";
import { randomUUID } from "node:crypto";

import {
  AGENT_RUNTIME_PROTOCOL,
  runtimeBrowserAcquireOutputSchema,
  runtimeRegistrationOutputSchema,
  runtimeSpecAnalysisClaimOutputSchema,
  runtimeSpecAnalysisTaskOutcomeOutputSchema,
  runtimeSpecAnalysisToolOutputSchema,
  runtimeTaskClaimOutputSchema,
  runtimeTaskHeartbeatOutputSchema,
  runtimeTaskOutcomeOutputSchema,
  type RuntimeBrowserAcquireInput,
  type RuntimeBrowserCommandInput,
  type RuntimeOutcome,
  type RuntimePool,
  type RuntimeSpecAnalysisOutcome,
  type RuntimeSpecAnalysisTaskLease,
  type RuntimeSpecAnalysisToolInput,
  type RuntimeTaskLease,
} from "@devproof/agent-runtime-protocol";

export interface ActiveLease {
  fencingToken: string;
  leaseToken: string;
  taskId: string;
  workerId: string;
}

/** Authenticated data-plane client; it never owns Run lifecycle transitions. */
export class ControlPlaneClient {
  private telemetrySpool: ModelTelemetrySpool;
  private metricsClock = { offsetMs: 0, uncertaintyMs: 0 };
  async prepareModelTelemetry(
    ownerKind: ModelCallRegistration["ownerKind"],
    lease: Pick<ActiveLease, "taskId" | "leaseToken" | "workerId">,
    candidate: RuntimeModelCandidate,
    modelCallId: string,
  ) {
    void this.telemetrySpool.flush().catch(() => {});
    const registeredAt = Date.now();
    const registrationTimer = performance.now();
    try {
      const receipt = (await this.request("/internal/v2/runtime/model-calls", {
        body: {
          ownerKind,
          ownerId: lease.taskId,
          workerId: lease.workerId,
          leaseToken: lease.leaseToken,
          modelCallId,
          requestedModel: candidate.modelId,
          configurationId: candidate.configurationId,
          configurationName: candidate.displayName,
        },
        signal: AbortSignal.timeout(5000),
      })) as { serverTime?: string };
      if (receipt.serverTime) {
        const elapsed = performance.now() - registrationTimer;
        this.metricsClock = {
          offsetMs:
            Date.parse(receipt.serverTime) - (registeredAt + elapsed / 2),
          uncertaintyMs: Math.ceil(elapsed / 2),
        };
      }
    } catch (error) {
      if (!(error instanceof ControlPlaneError && error.status === 404))
        console.error("runtime.model_telemetry.registration_failed");
      return undefined;
    }
    const callClock = { ...this.metricsClock };
    return (telemetry: Omit<ModelCallTelemetry, "modelCallId">) =>
      this.telemetrySpool!.settle({
        workerId: lease.workerId,
        leaseToken: lease.leaseToken,
        telemetry: {
          ...telemetry,
          modelCallId,
          clockOffsetMs: callClock.offsetMs,
          clockUncertaintyMs: callClock.uncertaintyMs,
        },
      });
  }

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly pool?: RuntimePool,
  ) {
    this.telemetrySpool = new ModelTelemetrySpool(
      createHash("sha256")
        .update(this.baseUrl + this.token)
        .digest("hex")
        .slice(0, 24),
      (input) =>
        this.request("/internal/v2/runtime/model-calls/settle", {
          body: input,
          signal: AbortSignal.timeout(5000),
        }),
    );
  }

  async register(workerId: string, signal?: AbortSignal) {
    const result = await this.request("/internal/v2/runtime/registration", {
      body: { pool: this.pool, protocol: AGENT_RUNTIME_PROTOCOL, workerId },
      ...(signal ? { signal } : {}),
    });
    return runtimeRegistrationOutputSchema.parse(result);
  }

  async claim(workerId: string, signal?: AbortSignal) {
    void this.telemetrySpool?.flush().catch(() => {});
    const started = performance.now();
    const result = await this.request("/internal/v2/runtime/tasks/claim", {
      body: {
        capabilities: ["BROWSER_VERIFICATION"],
        features: [
          ...BOUND_EVIDENCE_CAPABILITIES,
          BUSINESS_CHECK_CAPABILITY,
          EVIDENCE_CATALOG_CAPABILITY,
          TYPED_CHECKS_CAPABILITY,
        ],
        protocol: AGENT_RUNTIME_PROTOCOL,
        workerId,
      },
      ...(signal ? { signal } : {}),
    });
    const task = runtimeTaskClaimOutputSchema.parse(result).task;
    return task
      ? withConservativeLeaseDuration(task, performance.now() - started)
      : null;
  }

  async claimSpec(workerId: string, signal?: AbortSignal) {
    void this.telemetrySpool?.flush().catch(() => {});
    const started = performance.now();
    const result = await this.request("/internal/v2/runtime/spec-tasks/claim", {
      body: { protocol: AGENT_RUNTIME_PROTOCOL, workerId },
      ...(signal ? { signal } : {}),
    });
    const task = runtimeSpecAnalysisClaimOutputSchema.parse(result).task;
    return task
      ? withConservativeLeaseDuration(task, performance.now() - started)
      : null;
  }

  async claimAcceptanceReview(workerId: string, signal?: AbortSignal) {
    try {
      const response = await this.request(
        "/internal/v2/runtime/acceptance-reviews/claim",
        {
          body: { workerId },
          ...(signal ? { signal } : {}),
        },
      );
      return acceptanceReviewClaimOutputSchema.parse(response).task;
    } catch (error) {
      // Rolling deployments may run an older API without this optional endpoint.
      if (error instanceof ControlPlaneError && error.status === 404)
        return null;
      throw error;
    }
  }

  submitAcceptanceReview(
    id: string,
    input: {
      workerId: string;
      leaseToken: string;
      result?: AcceptanceReviewResult;
      model?: string;
      error?: string;
    },
    signal?: AbortSignal,
  ) {
    return this.request(
      `/internal/v2/runtime/acceptance-reviews/${id}/outcome`,
      {
        body: input,
        ...(signal ? { signal } : {}),
      },
    );
  }

  async heartbeat(lease: ActiveLease, signal?: AbortSignal) {
    const started = performance.now();
    const result = await this.request(
      `/internal/v2/runtime/tasks/${lease.taskId}/heartbeat`,
      { body: this.identity(lease), ...(signal ? { signal } : {}) },
    );
    return withConservativeLeaseDuration(
      runtimeTaskHeartbeatOutputSchema.parse(result),
      performance.now() - started,
    );
  }

  async heartbeatSpec(lease: ActiveLease, signal?: AbortSignal) {
    const started = performance.now();
    const result = await this.request(
      `/internal/v2/runtime/spec-tasks/${lease.taskId}/heartbeat`,
      { body: this.identity(lease), ...(signal ? { signal } : {}) },
    );
    return withConservativeLeaseDuration(
      runtimeTaskHeartbeatOutputSchema.parse(result),
      performance.now() - started,
    );
  }

  async appendEvent(
    lease: ActiveLease,
    kind: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    return this.request(`/internal/v2/runtime/tasks/${lease.taskId}/events`, {
      ...(signal ? { signal } : {}),
      body: {
        ...this.identity(lease),
        event: {
          eventId: randomUUID(),
          kind,
          occurredAt: new Date().toISOString(),
          payload: { ...payload, metricsClock: this.metricsClock },
        },
      },
    });
  }

  async appendSpecEvent(
    lease: ActiveLease,
    kind: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    return this.request(
      `/internal/v2/runtime/spec-tasks/${lease.taskId}/events`,
      {
        ...(signal ? { signal } : {}),
        body: {
          ...this.identity(lease),
          event: {
            eventId: randomUUID(),
            kind,
            occurredAt: new Date().toISOString(),
            payload: { ...payload, metricsClock: this.metricsClock },
          },
        },
      },
    );
  }

  async executeSpecTool(
    lease: ActiveLease,
    input: Pick<RuntimeSpecAnalysisToolInput, "arguments" | "callId" | "name">,
    signal?: AbortSignal,
  ) {
    const result = await this.request(
      `/internal/v2/runtime/spec-tasks/${lease.taskId}/tools`,
      {
        body: { ...this.identity(lease), ...input },
        ...(signal ? { signal } : {}),
      },
    );
    return runtimeSpecAnalysisToolOutputSchema.parse(result);
  }

  async acquireBrowser(
    lease: ActiveLease,
    execution: RuntimeBrowserAcquireInput["execution"],
    signal?: AbortSignal,
  ) {
    const result = await this.request(
      `/internal/v2/runtime/tasks/${lease.taskId}/browser/acquire`,
      {
        body: { ...this.identity(lease), execution },
        ...(signal ? { signal } : {}),
      },
    );
    return runtimeBrowserAcquireOutputSchema.parse(result);
  }

  async browserCommand(
    lease: ActiveLease,
    command: RuntimeBrowserCommandInput["command"],
    signal?: AbortSignal,
  ) {
    return this.request(
      `/internal/v2/runtime/tasks/${lease.taskId}/browser/commands`,
      {
        body: { ...this.identity(lease), command },
        timeoutMs: ((command.timeoutSeconds ?? 30) + 5) * 1_000,
        ...(signal ? { signal } : {}),
      },
    );
  }

  async observationOperation(
    lease: ActiveLease,
    operation: "bind" | "read" | "images" | "compare" | "deliver",
    arguments_: unknown,
    signal?: AbortSignal,
  ) {
    const paths = {
      bind: "observation-bindings",
      read: "observation-bindings/read",
      images: "evidence-images/read",
      compare: "visual-comparisons",
      deliver: "evidence-deliveries",
    };
    return this.request(
      `/internal/v2/runtime/tasks/${lease.taskId}/${paths[operation]}`,
      {
        body: { ...this.identity(lease), arguments: arguments_ },
        ...(signal ? { signal } : {}),
      },
    );
  }

  async releaseBrowser(lease: ActiveLease, signal?: AbortSignal) {
    return this.request(
      `/internal/v2/runtime/tasks/${lease.taskId}/browser/release`,
      {
        body: this.identity(lease),
        timeoutMs: 65_000,
        ...(signal ? { signal } : {}),
      },
    );
  }

  async submitOutcome(
    lease: ActiveLease,
    outcome: RuntimeOutcome,
    completionId = randomUUID(),
    signal?: AbortSignal,
  ) {
    const result = await this.request(
      `/internal/v2/runtime/tasks/${lease.taskId}/outcome`,
      {
        timeoutMs: 10_000,
        ...(signal ? { signal } : {}),
        body: {
          ...this.identity(lease),
          completedAt: new Date().toISOString(),
          completionId,
          outcome,
        },
      },
    );
    return runtimeTaskOutcomeOutputSchema.parse(result);
  }

  async submitSpecOutcome(
    lease: ActiveLease,
    outcome: RuntimeSpecAnalysisOutcome,
    completionId = randomUUID(),
    signal?: AbortSignal,
  ) {
    const result = await this.request(
      `/internal/v2/runtime/spec-tasks/${lease.taskId}/outcome`,
      {
        ...(signal ? { signal } : {}),
        body: {
          ...this.identity(lease),
          completedAt: new Date().toISOString(),
          completionId,
          outcome,
        },
      },
    );
    return runtimeSpecAnalysisTaskOutcomeOutputSchema.parse(result);
  }

  private identity(lease: ActiveLease) {
    return {
      fencingToken: lease.fencingToken,
      leaseToken: lease.leaseToken,
      workerId: lease.workerId,
    };
  }

  private async request(
    path: string,
    options: { body: unknown; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    const response = await fetch(new URL(path, this.baseUrl), {
      body: JSON.stringify(options.body),
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal,
    });
    const text = await response.text();
    const body = text ? safeJson(text) : null;
    if (!response.ok) {
      throw new ControlPlaneError(response.status, body);
    }
    return body;
  }
}

function withConservativeLeaseDuration<
  T extends {
    leaseExpiresAt: string;
    serverTime?: string | undefined;
    leaseDurationMs?: number | undefined;
  },
>(lease: T, elapsedMs: number): T {
  if (!lease.serverTime) return lease;
  return {
    ...lease,
    leaseDurationMs: Math.max(
      0,
      Date.parse(lease.leaseExpiresAt) -
        Date.parse(lease.serverTime) -
        elapsedMs,
    ),
  };
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(
      `DevProof control plane returned HTTP ${status}: ${JSON.stringify(body)}`,
    );
    this.name = "ControlPlaneError";
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function activeLease(
  task: RuntimeTaskLease | RuntimeSpecAnalysisTaskLease,
  workerId: string,
): ActiveLease {
  return {
    fencingToken: task.fencingToken,
    leaseToken: task.leaseToken,
    taskId: task.taskId,
    workerId,
  };
}
