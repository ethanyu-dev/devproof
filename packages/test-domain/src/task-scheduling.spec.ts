import { describe, expect, it } from "vitest";
import {
  countCaseExecutions,
  summarizeCaseScheduling,
} from "./task-scheduling.js";

describe("execution phase counts", () => {
  it("counts verdictless timeout, cancellation and exhausted dispatch as terminal", () => {
    const counts = countCaseExecutions(
      [
        {
          dispatchStatus: "LINKED",
          run: {
            lifecycle: "TIMED_OUT",
            executionDisposition: "AGENT_ERROR",
            verdict: null,
          },
        },
        { dispatchStatus: "CANCELLED", run: null },
        { dispatchStatus: "FAILED", dispatchAttempts: 3, run: null },
        { dispatchStatus: "FAILED", dispatchAttempts: 1, run: null },
      ],
      4,
    );
    expect(counts).toMatchObject({
      terminal: 3,
      queued: 1,
      waiting: 1,
      timedOut: 1,
      cancelled: 1,
      dispatchFailed: 1,
    });
    expect(
      counts.queued +
        counts.running +
        counts.recovering +
        counts.waitingHuman +
        counts.terminal,
    ).toBe(4);
  });

  it("keeps recovery and human control separate from active execution", () => {
    const counts = countCaseExecutions(
      [
        {
          dispatchStatus: "LINKED",
          scheduling: { state: "RECOVERING", reason: "LEASE_RECOVERY" },
          run: {
            lifecycle: "RUNNING",
            executionDisposition: null,
            verdict: null,
          },
        },
        {
          dispatchStatus: "LINKED",
          run: {
            lifecycle: "WAITING_HUMAN",
            executionDisposition: null,
            verdict: null,
          },
        },
        {
          dispatchStatus: "LINKED",
          run: {
            lifecycle: "RUNNING",
            executionDisposition: null,
            verdict: null,
          },
        },
      ],
      3,
    );
    expect(counts).toMatchObject({
      recovering: 1,
      waitingHuman: 1,
      running: 1,
      terminal: 0,
      waiting: 0,
    });
  });

  it("covers unmaterialized deployment rows and old cancelled parent rows", () => {
    const rows = [{ dispatchStatus: "PENDING", run: null }];
    expect(countCaseExecutions(rows, 4)).toMatchObject({ queued: 4, total: 4 });
    expect(countCaseExecutions(rows, 4, "CANCELLED")).toMatchObject({
      terminal: 4,
      waiting: 0,
      total: 4,
    });
    expect(
      countCaseExecutions([{ dispatchStatus: "LINKED", run: null }], 1),
    ).toMatchObject({ terminal: 1, dispatchFailed: 1 });
  });

  it("explains an entirely profile-blocked task without calling it running", () => {
    expect(
      summarizeCaseScheduling([
        {
          dispatchStatus: "PENDING",
          run: null,
          scheduling: {
            state: "WAITING",
            reason: "PROFILE_RESERVED",
            waitingSince: "2026-09-04T01:00:00Z",
            evaluatedAt: "2026-09-04T01:01:00Z",
            blockedBy: { resourceType: "PROFILE", taskId: "holder" },
          },
        },
      ]),
    ).toMatchObject({
      state: "WAITING",
      reason: "PROFILE_RESERVED",
      blockedBy: { taskId: "holder" },
      reasons: { PROFILE_RESERVED: 1 },
    });
  });
  it("counts admitted work waiting for an Agent once and preserves its reason and age", () => {
    const admitted = {
      dispatchStatus: "LINKED",
      scheduling: {
        state: "ADMITTED",
        reason: "AGENT_CAPACITY",
        waitingSince: "2026-09-04T01:00:00Z",
        evaluatedAt: "2026-09-04T01:02:00Z",
        blockedBy: { resourceType: "AGENT" },
      },
      run: {
        lifecycle: "PREPARING",
        executionDisposition: null,
        verdict: null,
      },
    };
    const counts = countCaseExecutions([admitted], 1);
    expect(counts).toMatchObject({
      queued: 1,
      running: 0,
      waiting: 1,
      total: 1,
    });
    expect(
      counts.queued +
        counts.running +
        counts.recovering +
        counts.waitingHuman +
        counts.terminal,
    ).toBe(1);
    expect(countCaseExecutions([{ ...admitted, run: null }], 1)).toMatchObject({
      queued: 0,
      terminal: 1,
    });
    expect(summarizeCaseScheduling([admitted])).toMatchObject({
      state: "WAITING",
      reason: "AGENT_CAPACITY",
      waitingSince: "2026-09-04T01:00:00Z",
      reasons: { AGENT_CAPACITY: 1 },
      blockedBy: { resourceType: "AGENT" },
    });
    expect(
      countCaseExecutions(
        [{ ...admitted, run: { ...admitted.run, lifecycle: "RUNNING" } }],
        1,
      ),
    ).toMatchObject({ queued: 1, running: 0 });
    expect(
      countCaseExecutions(
        [{ ...admitted, run: { ...admitted.run, lifecycle: "COMPLETED" } }],
        1,
      ),
    ).toMatchObject({ queued: 0, terminal: 1 });
  });
});
