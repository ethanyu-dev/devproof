export interface ExecutionContextAttempt {
  id: string;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  executionOrdinal: number | null;
  goal: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  capturedCalls: number;
}

export interface ExecutionContextList {
  items: ExecutionContextAttempt[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StepContextCall {
  id: string;
  model: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED";
  startedAt: string;
  durationMs: number | null;
  intent: string | null;
  hasFullContext: boolean;
  toolNames: string[];
}

export interface ExecutionContextDetail {
  attempt: ExecutionContextAttempt;
  relatedAttempts: ExecutionContextAttempt[];
  caseId: string | null;
  steps: Array<{
    number: number;
    segmentId: string;
    localStep: number;
    calls: StepContextCall[];
  }>;
}

export const STEP_CONTEXT_SECTIONS = [
  ["fixedTask", "固定任务"],
  ["executionState", "执行状态"],
  ["savedObservations", "保存的观察"],
  ["recentOperations", "最近操作"],
  ["currentPage", "当前页面"],
  ["currentGoal", "当前目标"],
  ["tools", "工具定义"],
] as const;

export type StepContextSection = (typeof STEP_CONTEXT_SECTIONS)[number][0];

export interface StepContextContent {
  completeness: "FULL" | "LEGACY_PREVIEW";
  sha256: string | null;
  byteLength: number | null;
  sections: Record<StepContextSection, unknown>;
  request: unknown;
  metrics: unknown;
  redactedPaths: string[];
  decision: unknown;
  modelError: string | null;
  tools: Array<{
    name: string;
    status: string;
    input: unknown;
    output: unknown;
  }>;
}

/** Presentation only. Never reinterpret a truncated historical preview as JSON. */
export function splitStepContext(
  request: unknown,
): Record<StepContextSection, unknown> {
  const body = object(request);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parsed = messages.map((message) => {
    const item = object(message);
    if (typeof item.content !== "string") return { message, value: null };
    try {
      return { message, value: JSON.parse(item.content) };
    } catch {
      return { message, value: null };
    }
  });
  const data = (kind: string) =>
    parsed.find((p) => object(p.value).kind === kind)?.value;
  const state = object(object(data("browser_working_state")).data);
  return {
    fixedTask: parsed
      .filter(
        (p) =>
          !object(p.value).kind &&
          typeof object(p.message).content === "string",
      )
      .map((p) => p.message),
    executionState: Object.fromEntries(
      Object.entries(state).filter(
        ([key]) =>
          ![
            "savedCriterionObservations",
            "objectEvidence",
            "currentGoal",
          ].includes(key),
      ),
    ),
    savedObservations: {
      savedCriterionObservations: state.savedCriterionObservations ?? null,
      objectEvidence: state.objectEvidence ?? null,
    },
    recentOperations: data("recent_operations") ?? null,
    currentPage: {
      page: data("current_browser_page") ?? null,
      images: messages.filter((m) => Array.isArray(object(m).content)),
    },
    currentGoal: state.currentGoal ?? null,
    tools: body.tools ?? null,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
