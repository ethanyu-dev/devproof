import { randomUUID } from "node:crypto";

import {
  AGENT_RUNTIME_PROTOCOL,
  runtimeBrowserAcquireOutputSchema,
  runtimePostRunAnalysisClaimOutputSchema,
  runtimePostRunAnalysisTaskOutcomeOutputSchema,
  runtimePostRunAnalysisToolOutputSchema,
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
  type RuntimePostRunAnalysisOutcome,
  type RuntimePostRunAnalysisTaskLease,
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
    const result = await this.request("/internal/v2/runtime/tasks/claim", {
      body: {
        capabilities: ["BROWSER_VERIFICATION"],
        protocol: AGENT_RUNTIME_PROTOCOL,
        workerId,
      },
      ...(signal ? { signal } : {}),
    });
    return runtimeTaskClaimOutputSchema.parse(result).task;
  }

  async claimSpec(workerId: string, signal?: AbortSignal) {
    const result = await this.request("/internal/v2/runtime/spec-tasks/claim", {
      body: { protocol: AGENT_RUNTIME_PROTOCOL, workerId },
      ...(signal ? { signal } : {}),
    });
    return runtimeSpecAnalysisClaimOutputSchema.parse(result).task;
  }

  async claimPostRunAnalysis(workerId: string, signal?: AbortSignal) {
    const result = await this.request(
      "/internal/v2/runtime/post-run-analysis-tasks/claim",
      {
        body: { protocol: AGENT_RUNTIME_PROTOCOL, workerId },
        ...(signal ? { signal } : {}),
      },
    );
    return runtimePostRunAnalysisClaimOutputSchema.parse(result).task;
  }

  async heartbeat(lease: ActiveLease, signal?: AbortSignal) {
    const result = await this.request(
      `/internal/v2/runtime/tasks/${lease.taskId}/heartbeat`,
      { body: this.identity(lease), ...(signal ? { signal } : {}) },
    );
    return runtimeTaskHeartbeatOutputSchema.parse(result);
  }

  async heartbeatSpec(lease: ActiveLease, signal?: AbortSignal) {
    const result = await this.request(
      `/internal/v2/runtime/spec-tasks/${lease.taskId}/heartbeat`,
      { body: this.identity(lease), ...(signal ? { signal } : {}) },
    );
    return runtimeTaskHeartbeatOutputSchema.parse(result);
  }

  async heartbeatPostRunAnalysis(lease: ActiveLease, signal?: AbortSignal) {
    const result = await this.request(
      `/internal/v2/runtime/post-run-analysis-tasks/${lease.taskId}/heartbeat`,
      { body: this.identity(lease), ...(signal ? { signal } : {}) },
    );
    return runtimeTaskHeartbeatOutputSchema.parse(result);
  }

  async appendEvent(
    lease: ActiveLease,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    return this.request(`/internal/v2/runtime/tasks/${lease.taskId}/events`, {
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
  ) {
    return this.request(
      `/internal/v2/runtime/spec-tasks/${lease.taskId}/events`,
      {
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

  async appendPostRunAnalysisEvent(
    lease: ActiveLease,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    return this.request(
      `/internal/v2/runtime/post-run-analysis-tasks/${lease.taskId}/events`,
      {
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

  async readPostRunAnalysisBundle(
    lease: ActiveLease,
    input: {
      analysisSummary: string;
      cursor: number;
      maxBytes: number;
      name: "read_analysis_bundle";
    },
    signal?: AbortSignal,
  ) {
    const result = await this.request(
      `/internal/v2/runtime/post-run-analysis-tasks/${lease.taskId}/tools`,
      {
        body: { ...this.identity(lease), ...input },
        ...(signal ? { signal } : {}),
      },
    );
    return runtimePostRunAnalysisToolOutputSchema.parse(result);
  }

  async readPostRunAnalysisManifest(
    lease: ActiveLease,
    input: {
      analysisSummary: string;
      cursor: number;
      maxBytes: number;
      name: "read_analysis_manifest";
    },
    signal?: AbortSignal,
  ) {
    const result = await this.request(
      `/internal/v2/runtime/post-run-analysis-tasks/${lease.taskId}/tools`,
      {
        body: { ...this.identity(lease), ...input },
        ...(signal ? { signal } : {}),
      },
    );
    return runtimePostRunAnalysisToolOutputSchema.parse(result);
  }

  async readPostRunAnalysisEvidence(
    lease: ActiveLease,
    input: {
      analysisSummary: string;
      cursor: number;
      evidenceRef: string;
      maxBytes: number;
      name: "read_analysis_evidence";
    },
    signal?: AbortSignal,
  ) {
    const result = await this.request(
      `/internal/v2/runtime/post-run-analysis-tasks/${lease.taskId}/tools`,
      {
        body: { ...this.identity(lease), ...input },
        ...(signal ? { signal } : {}),
      },
    );
    return runtimePostRunAnalysisToolOutputSchema.parse(result);
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
  ) {
    const result = await this.request(
      `/internal/v2/runtime/tasks/${lease.taskId}/browser/acquire`,
      { body: { ...this.identity(lease), execution } },
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
        ...(signal ? { signal } : {}),
      },
    );
  }

  async releaseBrowser(lease: ActiveLease) {
    return this.request(
      `/internal/v2/runtime/tasks/${lease.taskId}/browser/release`,
      { body: this.identity(lease) },
    );
  }

  async submitOutcome(
    lease: ActiveLease,
    outcome: RuntimeOutcome,
    completionId = randomUUID(),
  ) {
    const result = await this.request(
      `/internal/v2/runtime/tasks/${lease.taskId}/outcome`,
      {
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
  ) {
    const result = await this.request(
      `/internal/v2/runtime/spec-tasks/${lease.taskId}/outcome`,
      {
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

  async submitPostRunAnalysisOutcome(
    lease: ActiveLease,
    outcome: RuntimePostRunAnalysisOutcome,
    completionId = randomUUID(),
  ) {
    const result = await this.request(
      `/internal/v2/runtime/post-run-analysis-tasks/${lease.taskId}/outcome`,
      {
        body: {
          ...this.identity(lease),
          completedAt: new Date().toISOString(),
          completionId,
          outcome,
        },
      },
    );
    return runtimePostRunAnalysisTaskOutcomeOutputSchema.parse(result);
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
    options: { body: unknown; signal?: AbortSignal },
  ): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), {
      body: JSON.stringify(options.body),
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      method: "POST",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const text = await response.text();
    const body = text ? safeJson(text) : null;
    if (!response.ok) {
      throw new ControlPlaneError(response.status, body);
    }
    return body;
  }
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
  task:
    | RuntimeTaskLease
    | RuntimeSpecAnalysisTaskLease
    | RuntimePostRunAnalysisTaskLease,
  workerId: string,
): ActiveLease {
  return {
    fencingToken: task.fencingToken,
    leaseToken: task.leaseToken,
    taskId: task.taskId,
    workerId,
  };
}
