import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlaneClient } from "./control-plane.client.js";

afterEach(() => vi.unstubAllGlobals());

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
