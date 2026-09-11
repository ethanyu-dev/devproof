export interface TaskFilters {
  kind: "ALL" | "ISSUE_SPEC" | "DIRECT_RUN" | "LEGACY_RUN";
  period: "ALL" | "DAY" | "WEEK" | "MONTH";
  query: string;
  status:
    | "ALL"
    | "ACTIVE"
    | "WAITING_HUMAN"
    | "PASSED"
    | "VERIFICATION_FAILED"
    | "EXECUTION_FAILED"
    | "COMPLETED"
    | "CANCELLED"
    | "TIMED_OUT";
}

export const defaultFilters: TaskFilters = {
  kind: "ALL",
  period: "ALL",
  query: "",
  status: "ALL",
};

export function readTaskListState(params: Pick<URLSearchParams, "get">) {
  const kind = params.get("kind");
  const period = params.get("period");
  const status = params.get("status");
  const page = Number(params.get("page"));
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    filters: {
      kind: ["ISSUE_SPEC", "DIRECT_RUN", "LEGACY_RUN"].includes(kind ?? "")
        ? (kind as TaskFilters["kind"])
        : "ALL",
      period: ["DAY", "WEEK", "MONTH"].includes(period ?? "")
        ? (period as TaskFilters["period"])
        : "ALL",
      query: params.get("query")?.trim() ?? "",
      status: [
        "ACTIVE",
        "WAITING_HUMAN",
        "PASSED",
        "VERIFICATION_FAILED",
        "EXECUTION_FAILED",
        "COMPLETED",
        "CANCELLED",
        "TIMED_OUT",
      ].includes(status ?? "")
        ? (status as TaskFilters["status"])
        : "ALL",
    } satisfies TaskFilters,
  };
}

export function taskListHref(page = 1, filters = defaultFilters) {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (filters.query.trim()) params.set("query", filters.query.trim());
  if (filters.status !== "ALL") params.set("status", filters.status);
  if (filters.kind !== "ALL") params.set("kind", filters.kind);
  if (filters.period !== "ALL") params.set("period", filters.period);
  return `/console/runs${params.size ? `?${params}` : ""}`;
}

// Return links only restore recognized list state, never arbitrary destinations.
export function taskReturnHref(value: string | null) {
  if (!value || value.split("?")[0] !== "/console/runs") return "/console/runs";
  const { page, filters } = readTaskListState(
    new URLSearchParams(value.slice(value.indexOf("?") + 1)),
  );
  return taskListHref(page, filters);
}

export function taskDetailHref(id: string, returnTo = "/console/runs") {
  const back = taskReturnHref(returnTo);
  return `/console/runs/${encodeURIComponent(id)}${back === "/console/runs" ? "" : `?${new URLSearchParams({ returnTo: back })}`}`;
}

export function executionHref(runId: string, taskHref: string) {
  return `/console/executions/${encodeURIComponent(runId)}?${new URLSearchParams({ returnTo: taskHref })}`;
}

export function executionReturnHref(value: string | null) {
  if (!value) return "/console/runs";
  const [path, query] = value.split("?");
  const match = /^\/console\/runs\/([^/?#]+)$/.exec(path ?? "");
  if (!match) return "/console/runs";
  try {
    return taskDetailHref(
      decodeURIComponent(match[1]!),
      new URLSearchParams(query).get("returnTo") ?? undefined,
    );
  } catch {
    return "/console/runs";
  }
}
