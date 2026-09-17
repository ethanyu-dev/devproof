import { describe, expect, it, vi } from "vitest";
import { resolveSpecTaskContext } from "./spec-task-context.js";
import { assessAnalysisInputs } from "../task-executions/task-analysis-input.js";
import { ContextSourceError } from "./context-source.error.js";

const url = "https://github.com/acme/web/pull/42";
const targetUrl = "https://preview.example.com";
function harness() {
  const linear = {
    getIssue: vi.fn().mockResolvedValue({
      issue: {
        id: "issue",
        identifier: "ENG-1",
        title: "保存订单",
        description: "保存后状态持久化。",
        url: "https://linear.app/acme/issue/ENG-1",
      },
      pullRequestUrls: [url],
    }),
  };
  const github = {
    discoverIssuePullRequests: vi
      .fn()
      .mockResolvedValue({ pullRequestUrls: [], diagnostics: [] }),
    getPullRequest: vi.fn().mockResolvedValue({
      diagnostics: [],
      pullRequest: {
        id: "pr",
        url,
        repository: "acme/web",
        organization: "acme",
        number: 42,
        title: "保存订单",
        body: "保存后状态持久化。",
        headSha: "head-a",
        deploymentUrl: targetUrl,
      },
    }),
  };
  return { linear, github };
}
describe("Spec source selection", () => {
  it("keeps provider URL casing from changing the selected PR identity", async () => {
    const { linear, github } = harness();
    const response = await github.getPullRequest();
    github.getPullRequest.mockResolvedValue({
      ...response,
      pullRequest: {
        ...response.pullRequest,
        url: "https://github.com/Acme/Web/pull/42",
      },
    });
    const result = await resolveSpecTaskContext(
      { pullRequestUrls: [url] },
      "team",
      linear as never,
      github as never,
    );
    expect(result.pullRequests[0]!.pullRequest.url).toBe(url);
    expect(result.context.pullRequests[0]!.url).toBe(url);
  });
  it("keeps network timeouts retryable rather than asking to replace the source", async () => {
    const { linear, github } = harness();
    github.getPullRequest.mockRejectedValue(
      new ContextSourceError("GITHUB", "GITHUB_REQUEST_FAILED", "timeout", url),
    );
    await expect(
      resolveSpecTaskContext(
        { pullRequestUrls: [url] },
        "team",
        linear as never,
        github as never,
      ),
    ).rejects.toThrow("timeout");
    linear.getIssue.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      resolveSpecTaskContext(
        { issueRef: "ENG-1" },
        "team",
        linear as never,
        github as never,
      ),
    ).rejects.toThrow("fetch failed");
  });
  it("resolves a PR without touching Linear and pins its revision", async () => {
    const { linear, github } = harness();
    const pinned = vi.fn().mockResolvedValue("head-a");
    const result = await resolveSpecTaskContext(
      { pullRequestUrls: [url] },
      "team",
      linear as never,
      github as never,
      pinned,
    );
    expect(linear.getIssue).not.toHaveBeenCalled();
    expect(github.getPullRequest).toHaveBeenCalledWith(
      "team",
      url,
      true,
      "head-a",
    );
    expect(result.context.issue).toBeNull();
    expect(result.manifest.sources).toEqual([
      {
        kind: "GITHUB_PULL_REQUEST",
        ref: url,
        origin: "EXPLICIT",
        status: "READ",
        revision: "head-a",
      },
    ]);
    expect(
      assessAnalysisInputs(
        {
          kind: "SPEC_TASK",
          idempotencyKey: "pr-only-test",
          pullRequestUrls: [url],
        },
        [
          {
            kind: "GITHUB_PULL_REQUEST",
            uri: url,
            content: result.pullRequests[0],
          },
        ],
        result.manifest,
      ),
    ).toMatchObject({ request: null, targetUrl });
  });
  it("allows an Issue when optional discovered PR access fails", async () => {
    const { linear, github } = harness();
    github.getPullRequest.mockRejectedValue(
      new ContextSourceError("GITHUB", "DENIED", "Access denied", url, 403),
    );
    const result = await resolveSpecTaskContext(
      { issueRef: "ENG-1" },
      "team",
      linear as never,
      github as never,
    );
    expect(result.manifest.pullRequestUrls).toEqual([]);
    expect(result.context.resolution.diagnostics[0]?.code).toBe("DENIED");
    expect(
      assessAnalysisInputs(
        {
          kind: "SPEC_TASK",
          idempotencyKey: "issue-only-test",
          issueRef: "ENG-1",
          targetUrl,
        },
        [
          {
            kind: "LINEAR_ISSUE",
            uri: result.context.issue!.url,
            content: result.linear,
          },
        ],
        result.manifest,
      ).request,
    ).toBeNull();
  });
  it("does not silently exclude an explicitly requested unreadable PR", async () => {
    const { linear, github } = harness();
    github.getPullRequest.mockRejectedValue(
      new ContextSourceError("GITHUB", "DENIED", "Access denied", url, 403),
    );
    const result = await resolveSpecTaskContext(
      { pullRequestUrls: [url] },
      "team",
      linear as never,
      github as never,
    );
    expect(result.manifest.pullRequestUrls).toEqual([url]);
    expect(
      assessAnalysisInputs(
        {
          kind: "SPEC_TASK",
          idempotencyKey: "pr-error-test",
          pullRequestUrls: [url],
          targetUrl,
        },
        [],
        result.manifest,
      ).request?.missing,
    ).toEqual(["PULL_REQUEST"]);
  });
  it("keeps an explicit empty PR selection and does not rediscover excluded PRs", async () => {
    const { linear, github } = harness();
    const result = await resolveSpecTaskContext(
      { issueRef: "ENG-1", pullRequestUrls: [] },
      "team",
      linear as never,
      github as never,
    );
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(github.discoverIssuePullRequests).not.toHaveBeenCalled();
    expect(result.manifest.pullRequestUrls).toEqual([]);
  });
  it("keeps transient explicit source failures retryable", async () => {
    const { linear, github } = harness();
    github.getPullRequest.mockRejectedValue(
      new ContextSourceError("GITHUB", "UPSTREAM", "Unavailable", url, 503),
    );
    await expect(
      resolveSpecTaskContext(
        { pullRequestUrls: [url] },
        "team",
        linear as never,
        github as never,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("resolves a manual brief without external providers", async () => {
    const { linear, github } = harness();
    const result = await resolveSpecTaskContext(
      { goal: "保存后状态持久化。" },
      "team",
      linear as never,
      github as never,
    );
    expect(linear.getIssue).not.toHaveBeenCalled();
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(result.context.issue).toBeNull();
    expect(result.context.goal).toBe("保存后状态持久化。");
  });
  it("does not drop a previously selected discovered PR during retry", async () => {
    const { linear, github } = harness();
    const first = await resolveSpecTaskContext(
      { issueRef: "ENG-1" },
      "team",
      linear as never,
      github as never,
    );
    github.getPullRequest.mockRejectedValue(
      new ContextSourceError("GITHUB", "DENIED", "Access denied", url, 403),
    );
    const second = await resolveSpecTaskContext(
      { issueRef: "ENG-1" },
      "team",
      linear as never,
      github as never,
      undefined,
      first.manifest,
    );
    expect(second.manifest.pullRequestUrls).toEqual([url]);
  });
});
