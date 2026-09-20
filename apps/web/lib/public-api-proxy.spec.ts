import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyPublicApiRequest } from "./public-api-proxy";
import { docsFetch } from "./docs-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("public API documentation requests", () => {
  it("loads the public contract without forwarding browser sessions", async () => {
    vi.stubEnv("API_BASE_URL", "http://api.internal:4433");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { openapi: "3.1.0" },
          { headers: { "set-cookie": "session=ignored" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxyPublicApiRequest(
      new Request("https://web.example.com/v2/openapi.json", {
        headers: { cookie: "session=private" },
      }),
    );
    expect(fetchMock.mock.calls[0]![0].toString()).toBe(
      "http://api.internal:4433/v2/openapi.json",
    );
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).has("cookie")).toBe(
      false,
    );
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.json()).toEqual({ openapi: "3.1.0" });
  });
  it("preserves explicit token, request body and upstream errors for test requests", async () => {
    vi.stubEnv("API_BASE_URL", "http://api.internal:4433");
    const fetchMock = vi.fn(async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer dvp_sk_example",
      );
      expect(new Headers(init.headers).has("cookie")).toBe(false);
      expect(await new Response(init.body).json()).toEqual({
        kind: "SPEC_TASK",
      });
      return Response.json({ message: "Invalid token" }, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxyPublicApiRequest(
      new Request("https://web.example.com/v2/tasks", {
        method: "POST",
        headers: {
          cookie: "session=private",
          authorization: "Bearer dvp_sk_example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "SPEC_TASK" }),
      }),
    );
    expect(response.status).toBe(401);
  });
  it("omits browser cookies and rejects redirects even when Scalar requests otherwise", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", fetchMock);
    await docsFetch("/v2/tasks", {
      credentials: "include",
      redirect: "follow",
      headers: { authorization: "Bearer example" },
    });
    expect(fetchMock).toHaveBeenCalledWith("/v2/tasks", {
      credentials: "omit",
      redirect: "error",
      headers: { authorization: "Bearer example" },
    });
  });
});
