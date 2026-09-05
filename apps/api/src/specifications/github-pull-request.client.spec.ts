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
    expect(requestTokens.slice(2)).toEqual(
      Array(4).fill("Bearer token-fallback"),
    );
    expect(result.pullRequest).toMatchObject({
      number: 7,
      repository: "organization-a/core-api",
      title: "Test PR",
    });
  });

  it("pins code-search snippets to the pull request head SHA", async () => {
    const access = {
      candidatesForRepository: vi
        .fn()
        .mockResolvedValue([
          { id: "primary", name: "Primary", token: "token-primary" },
        ]),
      configured: vi.fn(),
    };
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/pulls/7")) {
          return Response.json({ head: { sha: "abc123" } });
        }
        if (url.includes("/search/code?")) {
          return Response.json({ items: [{ path: "src/refund.ts" }] });
        }
        if (url.includes("/contents/src/refund.ts?ref=abc123")) {
          return Response.json({
            content: Buffer.from(
              "export function refundOrder() { return 'REFUNDED'; }",
            ).toString("base64"),
            encoding: "base64",
          });
        }
        return new Response(null, { status: 404 });
      }),
    );
    const client = new GithubPullRequestClient(access as never);

    const result = await client.searchPullRequestCode({
      pullRequestUrl: "https://github.com/organization-a/core-api/pull/7",
      query: "refundOrder",
      teamId: "team-1",
    });

    expect(result).toMatchObject({
      matches: [
        expect.objectContaining({
          path: "src/refund.ts",
          revision: "abc123",
          snippet: expect.stringContaining("refundOrder"),
        }),
      ],
      revision: "abc123",
    });
    expect(requested).toContainEqual(
      expect.stringContaining("/contents/src/refund.ts?ref=abc123"),
    );
  });
});

describe("GitHub source boundaries", () => {
  const url = "https://github.com/acme/web/pull/7";
  const client = () =>
    new GithubPullRequestClient({
      candidatesForRepository: async () => [{ token: "test" }],
    } as never);
  it.each([299, 300, 301, 3001])(
    "reports completeness for %i changed files",
    async (count) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          if (input.endsWith("/pulls/7"))
            return Response.json({ head: { sha: "a" }, changed_files: count });
          const page = Number(new URL(input).searchParams.get("page"));
          return Response.json(
            Array.from(
              { length: Math.max(0, Math.min(100, count - (page - 1) * 100)) },
              (_, index) => ({
                filename: `f${(page - 1) * 100 + index}`,
                patch: "x",
              }),
            ),
          );
        }),
      );
      const result = await client().changedFiles("team", url);
      expect(result.files).toHaveLength(Math.min(count, 3000));
      expect(result.total).toBe(count);
      expect(result.truncated).toBe(count > 3000);
    },
  );
  it("fetches only page 16 when requesting the 301st changed file", async () => {
    const fetcher = vi.fn(async (input: string) =>
      input.endsWith("/pulls/7")
        ? Response.json({ head: { sha: "a" }, changed_files: 301 })
        : Response.json([{ filename: "file-301", patch: "last change" }]),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await client().changedFiles("team", url, "a", {
      page: 16,
      perPage: 20,
    });
    expect(result).toMatchObject({
      files: [{ path: "file-301" }],
      total: 301,
      truncated: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]![0]).toContain("per_page=20&page=16");
  });

  it("rejects a force push during mutable diff pagination", async () => {
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.endsWith("/pulls/7")
          ? Response.json({ head: { sha: ++reads === 1 ? "a" : "b" } })
          : Response.json([]),
      ),
    );
    await expect(client().changedFiles("team", url)).rejects.toMatchObject({
      code: "SOURCE_REVISION_CHANGED",
    });
  });
  it("rejects a later file read against a different attempt revision", async () => {
    const fetcher = vi.fn(async () => Response.json({ head: { sha: "b" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      client().readPullRequestFile({
        teamId: "team",
        pullRequestUrl: url,
        path: "a.ts",
        expectedRevision: "a",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_REVISION_CHANGED" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("marks truncated and omitted patches explicitly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.endsWith("/pulls/7")
          ? Response.json({ head: { sha: "a" }, changed_files: 2 })
          : Response.json([
              { filename: "large", patch: "x".repeat(30001) },
              { filename: "binary" },
            ]),
      ),
    );
    const result = await client().changedFiles("team", url);
    expect(result.files.map((file) => file.patchTruncated)).toEqual([
      true,
      true,
    ]);
    expect(result.files[0]!.patch).toHaveLength(30000);
  });
});
