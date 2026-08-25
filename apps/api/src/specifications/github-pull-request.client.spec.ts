import { afterEach, describe, expect, it, vi } from "vitest";

import { GithubPullRequestClient } from "./github-pull-request.client.js";

afterEach(() => vi.unstubAllGlobals());

describe("GithubPullRequestClient credential fallback", () => {
  it("tries matching credentials by priority when the first PAT cannot access a repository", async () => {
    const access = {
      candidatesForRepository: vi.fn().mockResolvedValue([
        { id: "primary", name: "Primary", token: "token-primary" },
        { id: "fallback", name: "Fallback", token: "token-fallback" },
      ]),
      configured: vi.fn(),
    };
    const requestTokens: string[] = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requestTokens.push(
          String((init?.headers as Record<string, string>)?.authorization),
        );
        if (url.endsWith("/pulls/7") && requestTokens.length === 1) {
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
          });
        }
        if (url.endsWith("/pulls/7")) {
          return Response.json({
            head: { ref: "feature", sha: "abc123" },
            html_url: "https://github.com/organization-a/core-api/pull/7",
            id: 7,
            number: 7,
            state: "open",
            title: "Test PR",
          });
        }
        if (url.includes("/files?")) return Response.json([]);
        if (url.includes("/check-runs?")) {
          return Response.json({ check_runs: [] });
        }
        if (url.includes("/deployments?")) return Response.json([]);
        return new Response(null, { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GithubPullRequestClient(access as never);

    const result = await client.getPullRequest(
      "team-1",
      "https://github.com/organization-a/core-api/pull/7",
      true,
    );

    expect(access.candidatesForRepository).toHaveBeenCalledWith(
      "team-1",
      "organization-a",
      "core-api",
    );
    expect(requestTokens.slice(0, 2)).toEqual([
      "Bearer token-primary",
      "Bearer token-fallback",
    ]);
    expect(requestTokens.slice(2)).toEqual([
      "Bearer token-fallback",
      "Bearer token-fallback",
      "Bearer token-fallback",
    ]);
    expect(result.pullRequest).toMatchObject({
      number: 7,
      repository: "organization-a/core-api",
      title: "Test PR",
    });
  });
});
