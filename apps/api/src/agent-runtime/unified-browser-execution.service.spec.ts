import { describe, expect, it, vi } from "vitest";

import { ExecutionRunnerUnavailableError } from "../verification/runtime-adapters.js";
import { UnifiedBrowserExecutionService } from "./unified-browser-execution.service.js";

const teamId = "6f090d88-8987-487f-8338-1a734beab6a6";
const taskId = "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0";
const attemptId = "cc61de8d-cf29-4561-b2cd-c67c304668a5";
const runId = "285146a8-5230-4b02-832a-5eef19e8dc8a";
const browserExecutionId = "ab91fa7b-afd8-42be-982b-e860de0fca67";

function input(availabilityPolicy: "WAIT" | "FAIL_FAST") {
  return {
    execution: {
      availabilityPolicy,
      profile: { mode: "EPHEMERAL" as const },
      requiredCapabilities: ["browser"],
      targetUrl: "https://example.com",
    },
    fencingToken: "4",
    leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
    workerId: "worker-1",
  };
}

function setup() {
  const prisma = {
    agentRuntimeTask: {
      findFirst: vi.fn().mockResolvedValue({
        attemptId,
        fencingToken: 4n,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseOwner: "worker-1",
        leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
        run: { lifecycle: "RUNNING" },
        runId,
        snapshot: {
          attemptId,
          attemptNumber: 1,
          criteria: [
            {
              description: "The page is visible.",
              id: "page-visible",
              required: true,
            },
          ],
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          environment: { targetUrl: "https://example.com" },
          executionPolicy: {},
          goal: "Verify the page.",
          runId,
          teamId,
          traceId: "1234567890abcdef1234567890abcdef",
        },
        status: "RUNNING",
      }),
    },
    browserExecution: {
      upsert: vi.fn().mockResolvedValue({
        attemptId,
        id: browserExecutionId,
        runId,
      }),
    },
  };
  const browser = {
    acquireForExecutionRun: vi.fn(),
  };
  return {
    browser,
    service: new UnifiedBrowserExecutionService(
      prisma as never,
      browser as never,
    ),
  };
}

describe("Run v2 browser capacity acquisition", () => {
  it("marks a successful browser allocation as acquired", async () => {
    const { browser, service } = setup();
    browser.acquireForExecutionRun.mockResolvedValue({
      expiresAt: new Date("2026-08-19T10:10:00.000Z"),
      fencingToken: "5",
      leaseId: "b9af89f9-2f36-498b-a626-6df0af16d815",
      runnerId: "d1b7bc2c-18c6-4fc8-a2eb-ec4474ddf072",
      runnerKind: "BROWSER",
    });

    await expect(
      service.acquire(teamId, taskId, input("WAIT")),
    ).resolves.toMatchObject({
      browserExecutionId,
      expiresAt: "2026-08-19T10:10:00.000Z",
      status: "ACQUIRED",
    });
  });

  it("keeps WAIT requests in the capacity queue", async () => {
    const { browser, service } = setup();
    browser.acquireForExecutionRun.mockRejectedValue(
      new ExecutionRunnerUnavailableError(
        "NO_AVAILABLE_SLOT",
        "Matching Browser Runtimes have no available slot.",
      ),
    );

    await expect(
      service.acquire(teamId, taskId, input("WAIT")),
    ).resolves.toEqual({
      browserExecutionId,
      reason: "NO_AVAILABLE_SLOT",
      retryAfterMs: 2_000,
      status: "WAITING_CAPACITY",
    });
  });

  it("returns a structured conflict for FAIL_FAST requests", async () => {
    const { browser, service } = setup();
    browser.acquireForExecutionRun.mockRejectedValue(
      new ExecutionRunnerUnavailableError(
        "NO_AVAILABLE_SLOT",
        "Matching Browser Runtimes have no available slot.",
      ),
    );

    await expect(
      service.acquire(teamId, taskId, input("FAIL_FAST")),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "NO_AVAILABLE_SLOT",
        retryable: false,
      }),
    });
  });
});
