import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskLease } from "@devproof/agent-runtime-protocol";

import { classifyFailure, RuntimeDeadlineController } from "./worker.js";

const task = {
  snapshot: { attemptNumber: 2 },
} as RuntimeTaskLease;

describe("Agent Runtime failure classification", () => {
  it("classifies provider disconnects without a product verdict", () => {
    const outcome = classifyFailure(
      new Error("OpenAI provider stream disconnected."),
      task,
    );

    expect(outcome).toMatchObject({
      executionDisposition: "PROVIDER_ERROR",
      kind: "RETRYABLE_FAILURE",
    });
    expect(outcome).not.toHaveProperty("verdict");
  });

  it("classifies an adaptive model-call cutoff as a retryable provider error", () => {
    expect(
      classifyFailure(new Error("Model response exceeded 300 seconds."), task),
    ).toMatchObject({
      error: { failureClass: "PROVIDER" },
      executionDisposition: "PROVIDER_ERROR",
      kind: "RETRYABLE_FAILURE",
    });
  });

  it("classifies browser capacity separately from assertion failures", () => {
    const outcome = classifyFailure(
      new Error("Browser Runtime has no available slot."),
      task,
    );

    expect(outcome).toMatchObject({
      executionDisposition: "BROWSER_UNAVAILABLE",
      kind: "RETRYABLE_FAILURE",
    });
    expect(outcome).not.toHaveProperty("verdict");
  });

  it("does not retry deterministic model tool schema errors", () => {
    const outcome = classifyFailure(
      new Error(
        "400 Invalid schema for function 'browser_command': 'uri' is not a valid format.",
      ),
      task,
    );

    expect(outcome).toMatchObject({
      error: {
        code: "AGENT_TOOL_SCHEMA_INVALID",
        failureClass: "TOOL_EXECUTION",
      },
      executionDisposition: "AGENT_ERROR",
      kind: "FATAL_FAILURE",
    });
  });
});

describe("RuntimeDeadlineController", () => {
  afterEach(() => vi.useRealTimers());

  it("re-arms the local abort timer when the control plane extends a run", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-24T01:00:00.000Z");
    vi.setSystemTime(startedAt);
    const abort = new AbortController();
    const deadline = new RuntimeDeadlineController(
      abort,
      new Date(startedAt + 1_000).toISOString(),
    );

    await vi.advanceTimersByTimeAsync(500);
    deadline.rearm(new Date(startedAt + 2_000).toISOString());
    deadline.rearm(new Date(startedAt + 750).toISOString());
    await vi.advanceTimersByTimeAsync(600);
    expect(abort.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(900);
    expect(abort.signal.aborted).toBe(true);
    deadline.dispose();
  });
});
