import type {
  AgentRuntimeProvider,
  RuntimeCommandInput,
  VerificationRequest,
  VerificationResult,
} from "@devproof/contracts";

export interface AgentInvocationContext {
  runId: string;
  teamId: string;
  request: VerificationRequest;
}

export interface AgentRuntimeConnector {
  readonly provider: AgentRuntimeProvider;
  invoke(context: AgentInvocationContext): Promise<{ externalRunId: string }>;
  cancel?(externalRunId: string): Promise<void>;
}

export interface ExecutionRunnerDescriptor {
  id: string;
  kind: string;
  capabilities: string[];
  available: boolean;
}

export interface ExecutionRunnerLease {
  leaseId: string;
  runnerId: string;
  runnerKind: string;
  fencingToken: string;
  expiresAt: Date;
  routing?: {
    hostname: string | null;
    priority: number;
    ruleId: string | null;
    source: "DOMAIN_RULE" | "POOL";
    targetRuntimeId: string | null;
  };
}

export type ExecutionUnavailableReason =
  | "NO_MATCHING_RUNNER"
  | "NO_AVAILABLE_SLOT"
  | "SESSION_OPEN_FAILED"
  | "DATA_LOCK"
  | "IDENTITY_CAPACITY"
  | "AUTH_REQUIRED"
  | "AUTH_REFRESH"
  | "CASE_DEPENDENCY"
  | "LEASE_RECOVERY"
  | "ADMISSION_STALE"
  | "PROTOCOL_UNSUPPORTED"
  | "AGENT_CAPACITY";

export class ExecutionRunnerUnavailableError extends Error {
  constructor(
    readonly reason: ExecutionUnavailableReason,
    message: string,
    readonly availabilityPolicyOverride?: "WAIT" | "FAIL_FAST",
    readonly blockedBy?: {
      resourceType: string;
      taskId?: string;
      runId?: string;
      sessionId?: string;
      recoveryId?: string;
      recoveryPhase?: string;
      rootReason?: string;
    },
  ) {
    super(message);
    this.name = "ExecutionRunnerUnavailableError";
  }
}

export interface ExecutionRunner {
  readonly kind: string;
  describe(teamId: string): Promise<ExecutionRunnerDescriptor[]>;
  acquire(
    teamId: string,
    runId: string,
    request: VerificationRequest,
  ): Promise<ExecutionRunnerLease>;
  execute(
    teamId: string,
    runId: string,
    command: RuntimeCommandInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  release(teamId: string, runId: string): Promise<void>;
  purgeProfile(
    teamId: string,
    profileKey: string,
  ): Promise<{ profileKey: string; purged: boolean; runtimeId: string | null }>;
}

export interface VerificationCompletionSink {
  complete(runId: string, result: VerificationResult): Promise<void>;
}

export interface HitlRequest {
  runId: string;
  reason: string;
  prompt: string;
  context: Record<string, unknown>;
  expiresAt: Date;
  channels: Array<"FEISHU">;
}

export interface HitlDispatcher {
  request(input: HitlRequest): Promise<{ checkpointId: string }>;
}
