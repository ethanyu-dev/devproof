export interface TaskRunSummary {
  currentAttemptNumber: number;
  evidenceCount: number;
  executionDisposition: string | null;
  interventionCount: number;
  lifecycle: string;
  maxAttempts: number;
  runId: string;
  verdict: string | null;
}

export interface TaskCaseExecution {
  dispatch: {
    attempts: number;
    lastError: unknown;
    requestedAt: string | null;
    status: string;
  };
  deployment: {
    id: string;
    key: string;
    name: string;
    targetUrl: string;
  };
  executionOrdinal: number;
  id: string;
  run: TaskRunSummary | null;
}

export interface TaskCase {
  definition: {
    authRole: string;
    criteria?: Array<{
      description: string;
      id: string;
      required: boolean;
      requiredEvidenceKinds: string[];
      sourceRefs: string[];
    }>;
    evidence?: Array<{ description: string; kind: string }>;
    expected?: string[];
    name: string;
    preconditions: string[];
    steps: Array<{
      action: string;
      expectedObservation?: string;
      order: number;
    }>;
  };
  definitionHash: string;
  executions: TaskCaseExecution[];
  id: string;
  name: string;
  position: number;
}

export interface TaskStage {
  attempts: Array<{
    error: unknown;
    finishedAt: string | null;
    id: string;
    number: number;
    result: unknown;
    startedAt: string | null;
    status: string;
  }>;
  currentAttemptNumber: number;
  finishedAt: string | null;
  id: string;
  lastError: unknown;
  maxAttempts: number;
  startedAt: string | null;
  status: string;
  type: "SPEC_ANALYSIS" | "PROFILE_RESOLUTION" | "SPEC_EXECUTION";
  waitingReason: string | null;
}

export interface TaskDetail {
  cancelRequestedAt: string | null;
  capabilities: {
    postRunAnalysis: boolean;
  };
  cases: TaskCase[];
  counts: {
    blocked: number;
    failed: number;
    inconclusive: number;
    passed: number;
    running: number;
    total: number;
    waiting: number;
  };
  createdAt: string;
  currentStage: string;
  deadlineAt: string;
  deployments: Array<{
    enabled: boolean;
    environment: unknown;
    id: string;
    key: string;
    name: string;
    targetUrl: string;
  }>;
  environment: unknown;
  executionDisposition: string | null;
  finishedAt: string | null;
  id: string;
  input: unknown;
  kind: "ISSUE_SPEC" | "DIRECT_RUN" | "LEGACY_RUN";
  lifecycle: string;
  profileBinding: {
    failureCode: string | null;
    failureMessage: string | null;
    profileOwnerUserId: string | null;
    requestedProfile: {
      displayName: string;
      id: string;
      owner: { id: string; name: string };
      status: string;
    } | null;
    resolvedAt: string | null;
    resolvedProfile: {
      displayName: string;
      id: string;
      status: string;
    } | null;
    status: string;
    strategy: string;
    triggerSource: string | null;
    unavailablePolicy: string;
  } | null;
  runs: TaskRunSummary[];
  source: { kind: string; ref: string | null };
  specification: {
    completeness: string;
    context: unknown;
    diagnostics: Array<{
      code: string;
      level: "INFO" | "WARNING" | "ERROR";
      message: string;
      reference: string | null;
      source: "LINEAR" | "GITHUB" | "KNOWLEDGE";
    }>;
    generatedAt: string;
    generatorKind: string;
    generatorVersion: string;
    id: string;
    primaryPullRequestUrl: string | null;
    sourceHash: string;
    summary: string;
  } | null;
  stages: TaskStage[];
  startedAt: string | null;
  title: string;
  traceId: string;
  updatedAt: string;
  verdict: string | null;
  waitingReason: string | null;
}

export type TaskSummary = Pick<
  TaskDetail,
  | "counts"
  | "createdAt"
  | "currentStage"
  | "executionDisposition"
  | "id"
  | "kind"
  | "lifecycle"
  | "source"
  | "title"
  | "updatedAt"
  | "verdict"
  | "waitingReason"
>;

export interface TaskEvent {
  actor: string;
  kind: string;
  occurredAt: string;
  payload: unknown;
  sequence: string;
}

export interface PostRunAnalysisDetail {
  analyzerVersion: string;
  attemptNumber: number;
  createdAt: string;
  error: unknown;
  eventCursor: string | null;
  events: Array<{
    actor: string;
    kind: string;
    occurredAt: string;
    payload: unknown;
    sequence: string;
  }>;
  eventsHasMore: boolean;
  eventsTruncated: boolean;
  findings: Array<{
    attemptNumber: number | null;
    category: string;
    component: string;
    confidence: number;
    evidenceRefs: string[];
    failureClass: string;
    id: string;
    impact: string;
    phase: string;
    recommendation: string;
    rootCause: string;
    runId: string | null;
    runtimeId: string | null;
    severity: string;
    title: string;
  }>;
  finishedAt: string | null;
  generation: number;
  id: string;
  input: {
    byteSize: number | null;
    completeness: unknown;
    schemaVersion: string;
    sha256: string;
  } | null;
  maxAttempts: number;
  progress: {
    currentMessage: string;
    deadlineAt: string;
    deadlineRemainingMs: number;
    elapsedMs: number;
    findingCount: number;
    lastActivityAt: string;
    lastEventKind: string | null;
    metrics: {
      bundleReads: number;
      evidenceReads: number;
      failedModelCalls: number;
      inputTokens: number;
      manifestReads: number;
      modelCalls: number;
      modelDurationMs: number;
      models: string[];
      outputTokens: number;
      reportValidationFailures: number;
      totalTokens: number;
      uniqueEvidence: number;
    };
    nextAttemptAt: string | null;
    phase: string;
    phaseLabel: string;
    queueWaitMs: number | null;
    steps: Array<{
      key: string;
      label: string;
      status: "ACTIVE" | "COMPLETED" | "FAILED" | "PENDING";
    }>;
  };
  startedAt: string | null;
  status: string;
  updatedAt: string;
  workItem: {
    body: string;
    createdAt: string;
    externalRef: string | null;
    findingCount: number;
    id: string;
    provider: string;
    status: string;
    title: string;
    updatedAt: string;
  } | null;
}

export type PostRunAnalysisEvent = PostRunAnalysisDetail["events"][number];

export interface PostRunAnalysisEventPage {
  analysisId: string;
  category: PostRunAnalysisEventCategory;
  events: PostRunAnalysisEvent[];
  hasMore: boolean;
  nextBeforeSequence: string | null;
}

export type PostRunAnalysisEventCategory =
  "ALL" | "KEY" | "ERROR" | "MODEL" | "EVIDENCE";
