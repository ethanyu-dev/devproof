/** Constructed by the authenticated gateway, never from a Runtime payload. */
export interface AuthenticatedRuntimeContext {
  runtimeId: string;
  connectionId: string;
  connectionGeneration: bigint;
  negotiatedMinor: number;
  capabilities: ReadonlySet<string>;
  hostInstanceId?: string;
  daemonInstanceId?: string;
}

export interface RuntimeClosureProof {
  evidenceId: string;
  recoveryId: string;
  requestId: string;
  sessionId: string;
  leaseToken: string;
  fencingToken: string;
  hostInstanceId: string;
  daemonInstanceId: string;
  launchIdentityVersion: number;
  method: "LIVE_SESSION_TERMINATED" | "IDENTIFIED_PROCESS_SET_TERMINATED";
  networkRevoked: true;
  closureCompletedAt: string;
}

export interface SessionClosureFailure {
  sessionId: string;
  expectedFencingToken: string;
  expectedLeaseToken: string;
  requestId?: string;
  errorCode: string;
  claimToken?: string;
}

export const RESOLVED_WRITE_STATES = [
  "NOT_APPLICABLE",
  "NO_WRITE_VERIFIED",
  "CONFIRMED",
  "RESOLVED",
] as const;
export const TERMINAL_RUN_STATES = [
  "COMPLETED",
  "CANCELLED",
  "TIMED_OUT",
] as const;
export const TERMINAL_AGENT_STATES = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;
