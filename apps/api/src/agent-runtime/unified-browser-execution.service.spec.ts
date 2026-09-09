import { describe, expect, it, vi } from "vitest";

import { ExecutionRunnerUnavailableError } from "../verification/runtime-adapters.js";
import { UnifiedBrowserExecutionService } from "./unified-browser-execution.service.js";
import { VISUAL_OBSERVATION_MAX_BYTES } from "@devproof/runtime-protocol";

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
    browserRuntimeSession: { findUnique: vi.fn() },
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
      findUnique: vi.fn().mockResolvedValue({ id: browserExecutionId }),
      upsert: vi.fn().mockResolvedValue({
        attemptId,
        id: browserExecutionId,
        runId,
      }),
    },
  };
  const browser = {
    acquireForExecutionRun: vi.fn(),
    executeForExecutionRun: vi.fn(),
  };
  const storage = { get: vi.fn() };
  return {
    browser,
    prisma,
    storage,
    service: new UnifiedBrowserExecutionService(
      prisma as never,
      browser as never,
      storage as never,
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

it("does not reuse an older preallocated browser as visually capable", async () => {
  const { service, browser, prisma } = setup();
  prisma.browserExecution.upsert.mockResolvedValue({
    attemptId,
    id: browserExecutionId,
    runId,
    runtimeSessionId: "older-session",
  } as never);
  prisma.browserRuntimeSession.findUnique.mockResolvedValue({
    runtime: { capabilities: ["browser"] },
  });
  await expect(service.acquire(teamId, taskId, input("WAIT"))).rejects.toThrow(
    /does not support DOM/u,
  );
  expect(browser.acquireForExecutionRun).not.toHaveBeenCalled();
});

describe("owned viewport image delivery", () => {
  const bytes = Buffer.from("synthetic viewport image");
  const artifact = () => ({
    id: "3a6cbe48-f36c-4b48-bae1-d8d5e50f4ce0",
    kind: "SCREENSHOT",
    contentType: "image/jpeg",
    storageKey: "private/owned-command/screenshot",
    byteSize: bytes.byteLength,
    metadata: {
      visualObservation: {
        observationId: "6730b25a-d1d3-4a10-a0c1-69fd4d74643a",
        capturedAt: new Date().toISOString(),
        viewport: { width: 1280, height: 720 },
      },
    },
  });
  const command = () => ({
    ...input("WAIT"),
    command: { commandType: "page.snapshot" as const, payload: {} },
  });

  it("hydrates only the current leased command artifact with a bounded read", async () => {
    const { service, browser, storage, prisma } = setup();
    const screenshot = artifact();
    browser.executeForExecutionRun.mockResolvedValue({
      status: "SUCCEEDED",
      artifacts: [screenshot],
    });
    storage.get.mockResolvedValue({ body: bytes, contentType: "image/jpeg" });
    const result = await service.execute(teamId, taskId, command());
    expect(prisma.agentRuntimeTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: taskId, run: { teamId } } }),
    );
    expect(browser.executeForExecutionRun).toHaveBeenCalledWith(
      teamId,
      browserExecutionId,
      command().command,
      undefined,
      expect.objectContaining({ taskId }),
    );
    expect(storage.get).toHaveBeenCalledWith(screenshot.storageKey, {
      start: 0,
      end: VISUAL_OBSERVATION_MAX_BYTES,
    });
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      visualObservation: {
        artifactId: screenshot.id,
        dataBase64: bytes.toString("base64"),
      },
    });
    expect(screenshot).not.toHaveProperty("dataBase64");
  });

  it("rejects a stale lease before accessing the browser or storage", async () => {
    const { service, browser, storage } = setup();
    await expect(
      service.execute(teamId, taskId, { ...command(), fencingToken: "3" }),
    ).rejects.toThrow(/stale/u);
    expect(browser.executeForExecutionRun).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("does not read full-page, oversized, or failed-command images", async () => {
    const { service, browser, storage } = setup();
    for (const result of [
      { status: "SUCCEEDED", artifacts: [{ ...artifact(), metadata: {} }] },
      {
        status: "SUCCEEDED",
        artifacts: [
          { ...artifact(), byteSize: VISUAL_OBSERVATION_MAX_BYTES + 1 },
        ],
      },
      { status: "FAILED", artifacts: [artifact()] },
    ]) {
      browser.executeForExecutionRun.mockResolvedValue(result);
      expect(
        await service.execute(teamId, taskId, command()),
      ).not.toHaveProperty("visualObservation");
    }
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("preserves a successful action when its image cannot be downloaded", async () => {
    const { service, browser, storage } = setup();
    browser.executeForExecutionRun.mockResolvedValue({
      status: "SUCCEEDED",
      artifacts: [artifact()],
      result: { saved: true },
    });
    storage.get.mockRejectedValue(new Error("storage unavailable"));
    expect(await service.execute(teamId, taskId, command())).toMatchObject({
      status: "SUCCEEDED",
      result: { saved: true },
      visualObservationError: expect.stringContaining("UNAVAILABLE"),
    });
    expect(browser.executeForExecutionRun).toHaveBeenCalledOnce();
  });
});
