export type TriggerSource = "CONSOLE" | "FEISHU" | "ISSUE_ASSIGNEE";

export interface Profile {
  activeSession: {
    humanControlExpiresAt: string | null;
    id: string;
    status: string;
  } | null;
  assignedRuntime: {
    deviceInfo: string;
    id: string;
    lastSeenAt: string | null;
    name: string;
    status: string;
  } | null;
  authRole: string;
  configurationSource: "MANUAL" | "TASK";
  createdAt: string;
  displayName: string;
  environmentKey: string;
  executionMode?: "SERIAL_PERSISTENT" | "ISOLATED_AUTH";
  executionConcurrency?: number;
  authSnapshotGeneration?: number | null;
  isolatedExecutionAvailable?: boolean;
  grants: Array<{ hostnamePattern: string; triggerSource: TriggerSource }>;
  id: string;
  inactivityExpiresAt: string | null;
  lastUsedAt: string | null;
  lastVerifiedAt: string | null;
  pendingTriggerSources: TriggerSource[];
  siteHostname: string | null;
  status: string;
  verificationUrl: string | null;
  verificationError?: { message?: string } | null;
}
