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
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly pool?: RuntimePool,
  ) {}

  async register(workerId: string, signal?: AbortSignal) {
    const result = await this.request("/internal/v2/runtime/registration", {
      body: { pool: this.pool, protocol: AGENT_RUNTIME_PROTOCOL, workerId },
      ...(signal ? { signal } : {}),
    });
    return runtimeRegistrationOutputSchema.parse(result);
  }

  async claim(workerId: string, signal?: AbortSignal) {
    const started = performance.now();
    const result = await this.request("/internal/v2/runtime/tasks/claim", {
      body: {
        capabilities: ["BROWSER_VERIFICATION"],
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
          payload,
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
            payload,
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

  async releaseBrowser(lease: ActiveLease) {
    return this.request(
      `/internal/v2/runtime/tasks/${lease.taskId}/browser/release`,
      { body: this.identity(lease), timeoutMs: 65_000 },
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
