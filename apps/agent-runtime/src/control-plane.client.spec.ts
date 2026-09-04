import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlaneClient } from "./control-plane.client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Spec lease requests", () => {
  it("deducts RPC latency from server-relative claim and renewal lifetimes", async () => {
    const timing = {
      leaseExpiresAt: "2099-01-01T00:01:00.000Z",
      serverTime: "2099-01-01T00:00:00.000Z",
    };
    const claimed = {
      ...timing,
      fencingToken: "1",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      snapshot: {
        attemptNumber: 1,
        deadlineAt: "2099-01-01T00:30:00.000Z",
        issueRef: "ENG-123",
        modelCandidates: [
          {
            apiKey: "test-key",
            baseUrl: "https://model.example.com/v1",
            displayName: "Test model",
            modelId: "test-model",
          },
        ],
        stageAttemptId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
        taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
        teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
        traceId: "1234567890abcdef1234567890abcdef",
      },
      taskId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
    };
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(1_010)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(4_000);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ task: claimed })))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...timing, directive: "CONTINUE" })),
        ),
    );
    const client = new ControlPlaneClient(
      "https://api.example.com",
      "runtime-token",
    );
    expect(await client.claimSpec("worker-1")).toMatchObject({
      leaseDurationMs: 59_000,
    });
    expect(
      await client.heartbeatSpec({
        taskId: claimed.taskId,
        fencingToken: claimed.fencingToken,
        leaseToken: claimed.leaseToken,
        workerId: "worker-1",
      }),
    ).toMatchObject({ leaseDurationMs: 58_000 });
  });

  it.each(["event", "outcome"] as const)(
    "cancels a pending Spec %s request when its lease is lost",
    async (kind) => {
      const fetchMock = vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const client = new ControlPlaneClient(
        "https://api.example.com",
        "runtime-token",
      );
      const lease = {
        taskId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
        fencingToken: "1",
        leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
        workerId: "worker-1",
      };
      const controller = new AbortController();
      const running =
        kind === "event"
          ? client.appendSpecEvent(
              lease,
              "executor.started",
              {},
              controller.signal,
            )
          : client.submitSpecOutcome(
              lease,
              {} as never,
              "53fba2fc-7579-4c1f-adad-601030aa3c0a",
              controller.signal,
            );
      const reason = new Error("Lease lost");
      controller.abort(reason);
      await expect(running).rejects.toBe(reason);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
});

describe("ControlPlaneClient registration", () => {
  it("omits the pool assertion when deployment configuration has not added it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          analysisConcurrency: 0,
          browserConcurrency: 0,
          pools: ["SPEC_ANALYSIS"],
          refreshAfterMs: 5_000,
          specConcurrency: 1,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ControlPlaneClient(
      "https://api.example.com",
      "runtime-token",
    );
    await client.register("worker-1");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).not.toHaveProperty("pool");
  });

  it("sends an explicitly configured pool assertion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          analysisConcurrency: 0,
          browserConcurrency: 0,
          pools: ["BROWSER_EXECUTION"],
          refreshAfterMs: 5_000,
          specConcurrency: 0,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ControlPlaneClient(
      "https://api.example.com",
      "runtime-token",
      "BROWSER_EXECUTION",
    );
    await client.register("worker-1");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      pool: "BROWSER_EXECUTION",
    });
  });
});
