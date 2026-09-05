import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyApiRequest } from "./api-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("recovery Console BFF", () => {
  it("forwards authenticated recovery actions and preserves safe conflict responses", async () => {
    vi.stubEnv("API_BASE_URL", "http://api.test:4433");
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(new Headers(init.headers).get("cookie")).toBe(
        "session=test-session",
      );
      expect(new Headers(init.headers).get("idempotency-key")).toBe(
        "request-1",
      );
      expect(new Headers(init.headers).has("x-forwarded-user")).toBe(false);
      expect(init.method).toBe("POST");
      expect(await new Response(init.body).json()).toEqual({
        expectedVersion: 3,
      });
      return Response.json(
        { message: "Recovery version changed; refresh its status." },
        { status: 409 },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const response = await proxyApiRequest(
      new Request(
        "https://console.test/console/api/runtime-recoveries/recovery-1/retry",
        {
          method: "POST",
          headers: {
            cookie: "session=test-session",
            "idempotency-key": "request-1",
            "content-type": "application/json",
            "x-forwarded-user": "admin",
          },
          body: JSON.stringify({ expectedVersion: 3 }),
        },
      ),
    );
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      "http://api.test:4433/console/api/runtime-recoveries/recovery-1/retry",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Recovery version changed; refresh its status.",
    });
  });
});
