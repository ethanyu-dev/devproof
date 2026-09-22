import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskMetricsLoader,
  initialMetricsState,
  type MetricsState,
} from "./task-metrics-loader";

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  let state = initialMetricsState;
  const changes: MetricsState[] = [];
  const request = vi.fn(
    async (path: string, _init: { signal: AbortSignal }): Promise<unknown> => {
      if (path.endsWith("/metrics")) return { asOf: "first" };
      if (path.includes("?after="))
        return { items: [{ id: "second" }], nextCursor: null };
      return { items: [{ id: "first" }], nextCursor: "first" };
    },
  );
  const loader = createTaskMetricsLoader(
    "task",
    request as Parameters<typeof createTaskMetricsLoader>[1],
    (next) => {
      state = next;
      changes.push(next);
    },
  );
  return {
    loader,
    request,
    changes,
    get state() {
      return state;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("task metrics background refresh", () => {
  it("keeps rendered data during slow polls and coalesces repeated refreshes", async () => {
    vi.useFakeTimers();
    const context = setup();
    await context.loader.refresh();
    const previous = context.state;
    const pending = deferred();
    context.request.mockImplementation(() => pending.promise);
    await vi.advanceTimersByTimeAsync(5000);
    const refresh = context.loader.refresh();
    expect(context.loader.refresh()).toBe(refresh);
    expect(context.state).toBe(previous);
    await vi.advanceTimersByTimeAsync(15000);
    expect(context.request).toHaveBeenCalledTimes(6);
    pending.resolve({
      items: [{ id: "updated" }],
      nextCursor: null,
      asOf: "updated",
    });
    await refresh;
    expect(context.state.calls?.items[0]?.id).toBe("updated");
    expect(
      context.changes
        .slice(2)
        .every((state) => state.calls !== null && state.spans !== null),
    ).toBe(true);
    context.loader.dispose();
  });

  it("refreshes every expanded page without collapsing rows or duplicating ids", async () => {
    const context = setup();
    await context.loader.refresh();
    await context.loader.more("model-calls");
    await context.loader.more("timeline");
    expect(context.state.calls?.items.map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
    context.request.mockImplementation(async (path) =>
      path.endsWith("/metrics")
        ? { asOf: "updated" }
        : path.includes("?after=")
          ? {
              items: [{ id: "first", outcome: "SUCCEEDED" }, { id: "second" }],
              nextCursor: "second",
            }
          : {
              items: [{ id: "first", outcome: "RUNNING" }],
              nextCursor: "first",
            },
    );
    await context.loader.refresh();
    expect(context.state.calls?.items.map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
    expect(context.state.calls?.items[0]?.outcome).toBe("SUCCEEDED");
    expect(context.state.spans?.items).toHaveLength(2);
    expect(context.state.calls?.nextCursor).toBe("second");
    context.loader.dispose();
  });

  it("queues load more behind refresh and ignores duplicate load-more clicks", async () => {
    const context = setup();
    await context.loader.refresh();
    const pending = deferred();
    context.request.mockImplementationOnce(() => pending.promise);
    const refresh = context.loader.refresh();
    await Promise.resolve();
    const more = context.loader.more("model-calls");
    await context.loader.more("model-calls");
    expect(context.state.loadingMore).toBe(true);
    expect(
      context.request.mock.calls.some(([path]) => path.includes("?after=")),
    ).toBe(false);
    pending.resolve({ asOf: "updated" });
    await Promise.all([refresh, more]);
    expect(context.state.calls?.items).toHaveLength(2);
    expect(
      context.request.mock.calls.filter(([path]) => path.includes("?after=")),
    ).toHaveLength(1);
    expect(context.state.loadingMore).toBe(false);
    context.loader.dispose();
  });

  it("retains successful data on failure and recovers on the next poll", async () => {
    vi.useFakeTimers();
    const context = setup();
    await context.loader.refresh();
    const previous = context.state;
    context.request.mockRejectedValueOnce(new Error("offline"));
    context.request.mockRejectedValueOnce(new Error("offline"));
    await context.loader.refresh();
    expect(context.state.metrics).toBe(previous.metrics);
    expect(context.state.calls).toBe(previous.calls);
    expect(context.state.spans).toBe(previous.spans);
    expect(context.state.error).toBe("offline");
    expect(context.state.detailError).toBe("offline");
    await vi.advanceTimersByTimeAsync(5000);
    expect(context.state.error).toBeNull();
    expect(context.state.detailError).toBeNull();
    context.loader.dispose();
  });

  it("aborts requests and prevents late responses or queued work after unmount", async () => {
    vi.useFakeTimers();
    const context = setup();
    const pending = deferred();
    context.request.mockImplementation(() => pending.promise);
    const refresh = context.loader.refresh();
    await Promise.resolve();
    context.loader.dispose();
    expect(
      context.request.mock.calls.every(([, init]) => init.signal.aborted),
    ).toBe(true);
    pending.resolve({ items: [], nextCursor: null });
    await refresh;
    await vi.advanceTimersByTimeAsync(15000);
    expect(context.request).toHaveBeenCalledTimes(3);
    expect(context.changes).toHaveLength(0);
  });

  it("drops the timeline cursor when the runtime filter changes", async () => {
    vi.useFakeTimers();
    const context = setup();
    await context.loader.refresh();
    await context.loader.more("timeline");
    expect(context.request.mock.calls.map(([path]) => String(path))).toContain(
      "/tasks/task/metrics/timeline?after=first",
    );
    context.request.mockClear();
    await context.loader.setTimelineRuntime("BROWSER");
    const switched = context.request.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.includes("/timeline"));
    expect(switched).toEqual(["/tasks/task/metrics/timeline?runtime=BROWSER"]);
    const afterSwitch = context.request.mock.calls.length;
    await context.loader.setTimelineRuntime("BROWSER");
    expect(context.request.mock.calls.length).toBe(afterSwitch);
    context.request.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      context.request.mock.calls
        .map(([path]) => String(path))
        .filter((path) => path.includes("/timeline")),
    ).toEqual(["/tasks/task/metrics/timeline?runtime=BROWSER"]);
    await context.loader.more("timeline");
    expect(context.request.mock.calls.map(([path]) => String(path))).toContain(
      "/tasks/task/metrics/timeline?after=first&runtime=BROWSER",
    );
    context.loader.dispose();
  });

  it("does not continue an in-flight timeline page after the runtime filter changes", async () => {
    const context = setup();
    await context.loader.refresh();
    await context.loader.more("timeline");
    const pending = deferred();
    context.request.mockClear();
    context.request.mockImplementation((path: string) => {
      if (path.endsWith("/metrics")) return Promise.resolve({ asOf: "next" });
      if (path.includes("/model-calls"))
        return Promise.resolve({ items: [{ id: "call" }], nextCursor: null });
      if (path.includes("runtime=SPEC_ANALYSIS"))
        return Promise.resolve({
          items: [{ id: "analysis" }],
          nextCursor: null,
        });
      if (path.includes("after="))
        return Promise.resolve({
          items: [{ id: "skipped" }],
          nextCursor: null,
        });
      return pending.promise;
    });
    const refresh = context.loader.refresh();
    for (
      let attempt = 0;
      attempt < 10 &&
      !context.request.mock.calls.some(
        ([path]) =>
          String(path).includes("/timeline") &&
          !String(path).includes("runtime="),
      );
      attempt += 1
    )
      await Promise.resolve();
    const switched = context.loader.setTimelineRuntime("SPEC_ANALYSIS");
    pending.resolve({
      items: [{ id: "stale" }],
      nextCursor: "stale-cursor",
    });
    await Promise.all([refresh, switched]);
    const timeline = context.request.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.includes("/timeline"));
    expect(timeline.some((path) => path.includes("after="))).toBe(false);
    expect(timeline).toContain(
      "/tasks/task/metrics/timeline?runtime=SPEC_ANALYSIS",
    );
    expect(context.state.spans?.items.map((item) => item.id)).toEqual([
      "analysis",
    ]);
    context.loader.dispose();
  });
});
