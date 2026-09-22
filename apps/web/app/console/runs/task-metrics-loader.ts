import type {
  TaskMetrics,
  TaskMetricCall,
  TaskMetricSpan,
  TaskRuntimeKind,
} from "@devproof/contracts";

type Page<T> = { items: T[]; nextCursor: string | null };
type DetailKind = "model-calls" | "timeline";
type Request = <T>(path: string, init: { signal: AbortSignal }) => Promise<T>;
export type MetricsState = {
  metrics: TaskMetrics | null;
  calls: Page<TaskMetricCall> | null;
  spans: Page<TaskMetricSpan> | null;
  error: string | null;
  detailError: string | null;
  loadingMore: boolean;
};
export const initialMetricsState: MetricsState = {
  metrics: null,
  calls: null,
  spans: null,
  error: null,
  detailError: null,
  loadingMore: false,
};

// One session per mounted task. Refresh and pagination share a queue so a slow
// refresh cannot overwrite a page the user just loaded.
export function createTaskMetricsLoader(
  id: string,
  request: Request,
  onChange: (state: MetricsState) => void,
) {
  const controller = new AbortController();
  const base = `/tasks/${id}/metrics`;
  let state = initialMetricsState;
  let queue = Promise.resolve();
  let refreshing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timelineRuntime: TaskRuntimeKind | null = null;
  // Bumped when the filter changes so an in-flight page cannot reuse `after`.
  let timelineEpoch = 0;
  const pageCounts = { "model-calls": 1, timeline: 1 };
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  function detailPath(
    kind: DetailKind,
    after: string | null,
    runtime: TaskRuntimeKind | null,
  ) {
    const params = new URLSearchParams();
    if (after) params.set("after", after);
    if (kind === "timeline" && runtime) params.set("runtime", runtime);
    const query = params.toString();
    return `${base}/${kind}${query ? `?${query}` : ""}`;
  }
  function update(patch: Partial<MetricsState>) {
    if (controller.signal.aborted) return;
    state = { ...state, ...patch };
    onChange(state);
  }
  function enqueue(work: () => Promise<void>) {
    queue = queue.then(async () => {
      if (!controller.signal.aborted) await work();
    });
    return queue;
  }
  async function pages<T extends { id: string }>(
    kind: DetailKind,
  ): Promise<Page<T> | "stale"> {
    const epoch = timelineEpoch;
    const runtime = kind === "timeline" ? timelineRuntime : null;
    const count = pageCounts[kind];
    const items = new Map<string, T>();
    let nextCursor: string | null = null;
    for (let index = 0; index < count; index++) {
      // A filter change makes the previous page's id skip or 404. Stop before
      // the next `after` and let the caller load the first page again.
      if (kind === "timeline" && epoch !== timelineEpoch) return "stale";
      const page: Page<T> = await request(
        detailPath(kind, nextCursor, runtime),
        {
          signal: controller.signal,
        },
      );
      if (kind === "timeline" && epoch !== timelineEpoch) return "stale";
      for (const item of page.items) items.set(item.id, item);
      nextCursor = page.nextCursor;
      if (!nextCursor) break;
    }
    return { items: [...items.values()], nextCursor };
  }
  function refresh(): Promise<void> {
    if (controller.signal.aborted) return Promise.resolve();
    if (refreshing) return refreshing;
    const epoch = timelineEpoch;
    clearTimeout(timer);
    refreshing = enqueue(async () => {
      await Promise.all([
        request<TaskMetrics>(base, { signal: controller.signal })
          .then((metrics) => update({ metrics, error: null }))
          .catch((error) => update({ error: message(error) })),
        Promise.all([
          pages<TaskMetricCall>("model-calls"),
          pages<TaskMetricSpan>("timeline"),
        ])
          .then(([calls, spans]) =>
            update({
              ...(calls === "stale" ? {} : { calls }),
              ...(spans === "stale" ? {} : { spans }),
              detailError: null,
            }),
          )
          .catch((error) => update({ detailError: message(error) })),
      ]);
    }).finally(() => {
      refreshing = null;
      if (controller.signal.aborted) return;
      if (epoch !== timelineEpoch) return refresh();
      timer = setTimeout(() => void refresh(), 5000);
    });
    return refreshing;
  }
  async function more(kind: DetailKind) {
    if (controller.signal.aborted || state.loadingMore) return;
    const epoch = timelineEpoch;
    update({ loadingMore: true });
    await enqueue(async () => {
      try {
        if (kind === "timeline" && epoch !== timelineEpoch) return;
        const key = kind === "model-calls" ? "calls" : "spans";
        const current = state[key];
        if (!current?.nextCursor) return;
        const page = await request<Page<TaskMetricCall | TaskMetricSpan>>(
          detailPath(
            kind,
            current.nextCursor,
            kind === "timeline" ? timelineRuntime : null,
          ),
          { signal: controller.signal },
        );
        if (kind === "timeline" && epoch !== timelineEpoch) return;
        const items = new Map(
          [...current.items, ...page.items].map((item) => [item.id, item]),
        );
        const merged = { ...page, items: [...items.values()] };
        pageCounts[kind]++;
        update(
          key === "calls"
            ? { calls: merged as Page<TaskMetricCall>, detailError: null }
            : { spans: merged as Page<TaskMetricSpan>, detailError: null },
        );
      } catch (error) {
        update({ detailError: message(error) });
      } finally {
        update({ loadingMore: false });
      }
    });
  }
  function setTimelineRuntime(runtime: TaskRuntimeKind | null) {
    if (controller.signal.aborted || runtime === timelineRuntime)
      return Promise.resolve();
    timelineRuntime = runtime;
    timelineEpoch += 1;
    pageCounts.timeline = 1;
    if (state.spans)
      update({ spans: { items: state.spans.items, nextCursor: null } });
    return refresh();
  }
  return {
    refresh,
    more,
    setTimelineRuntime,
    dispose() {
      controller.abort();
      clearTimeout(timer);
    },
  };
}
