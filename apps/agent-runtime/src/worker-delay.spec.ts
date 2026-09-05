import { getEventListeners } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRuntimeWorker } from "./worker.js";

afterEach(() => vi.useRealTimers());

it("removes delay listeners during long-running registration and shutdown", async () => {
  vi.useFakeTimers();
  const control = {
    register: vi.fn().mockResolvedValue({
      pools: ["SPEC_ANALYSIS"],
      specConcurrency: 0,
      browserConcurrency: 0,
      analysisConcurrency: 0,
      refreshAfterMs: 10,
    }),
  };
  const worker = new AgentRuntimeWorker(
    {
      DEVPROOF_AGENT_RUNTIME_POOL: "SPEC_ANALYSIS",
      DEVPROOF_AGENT_WORKER_ID: "review",
      DEVPROOF_AGENT_POLL_INTERVAL_MS: 10,
    } as never,
    control as never,
    {} as never,
  );
  const shutdown = new AbortController();
  const running = worker.run(shutdown.signal);
  await vi.advanceTimersByTimeAsync(2000);
  const count = getEventListeners(shutdown.signal, "abort").length;
  shutdown.abort();
  await running;
  expect(count).toBeLessThanOrEqual(1);
  expect(control.register.mock.calls.length).toBeGreaterThanOrEqual(100);
  expect(getEventListeners(shutdown.signal, "abort")).toHaveLength(0);
});
