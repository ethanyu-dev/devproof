import { describe, expect, it } from "vitest";

import { buildSpecAnalysisContext } from "./spec-analysis-runtime.service.js";

type Source = Parameters<typeof buildSpecAnalysisContext>[0][number];
const url = "https://github.com/acme/web/pull/42";
const secondUrl = "https://github.com/acme/api/pull/43";

function issue(pullRequestUrls = [url]): Source {
  return {
    kind: "LINEAR_ISSUE",
    uri: "https://linear.app/acme/issue/ENG-123",
    locator: {},
    content: {
      issue: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Refund flow",
        url: "https://linear.app/acme/issue/ENG-123",
      },
      pullRequestUrls,
    },
  };
}

function metadata(
  prUrl = url,
  changedFiles = ["src/refund.ts"],
  diagnostics: unknown[] = [],
): Source {
  return {
    kind: "GITHUB_PULL_REQUEST",
    uri: prUrl,
    locator: {},
    content: {
      diagnostics,
      pullRequest: {
        id: prUrl,
        number: 42,
        organization: "acme",
        repository: "acme/web",
        title: "Refund flow",
        url: prUrl,
        changedFiles,
      },
    } as Source["content"],
  };
}

function file(
  kind: "GITHUB_DIFF" | "GITHUB_FILE",
  prUrl = url,
  path = "src/refund.ts",
  locator = {},
): Source {
  return {
    kind,
    uri: `${prUrl}/files#${encodeURIComponent(path)}`,
    locator: { path, ...locator },
    content: {},
  };
}

describe("Spec analysis source completeness", () => {
  it("preserves discovery warnings even when the found PR has complete source coverage", () => {
    const source = issue();
    const diagnostic = {
      code: "LINEAR_COMMENTS_UNAVAILABLE",
      source: "LINEAR",
      level: "WARNING",
      message: "部分评论不可用。",
      reference: source.uri,
    };
    source.content = {
      ...(source.content as object),
      discoveryDiagnostics: [diagnostic],
    };
    const context = buildSpecAnalysisContext([
      source,
      metadata(),
      file("GITHUB_DIFF"),
      file("GITHUB_FILE"),
    ]);
    expect(context.resolution.completeness).toBe("PARTIAL");
    expect(context.resolution.diagnostics).toContainEqual(diagnostic);
  });
  it("marks the incident's Issue-only result PARTIAL with an actionable diagnostic", () => {
    const context = buildSpecAnalysisContext([issue([])]);
    expect(context.pullRequests).toEqual([]);
    expect(context.resolution).toMatchObject({
      completeness: "PARTIAL",
      diagnostics: [
        {
          code: "GITHUB_PR_NOT_LINKED",
          source: "GITHUB",
          reference: issue().uri,
        },
      ],
    });
    expect(context.resolution.diagnostics[0]!.message).toContain(
      "未读取 GitHub 代码或检查结果",
    );
  });

  it("reports missing sources per PR instead of accepting coverage from another PR", () => {
    const context = buildSpecAnalysisContext([
      issue([url, secondUrl]),
      metadata(),
      file("GITHUB_DIFF"),
      file("GITHUB_FILE"),
    ]);
    expect(context.resolution.completeness).toBe("PARTIAL");
    expect(
      context.resolution.diagnostics.map(({ code, reference }) => ({
        code,
        reference,
      })),
    ).toEqual([
      { code: "GITHUB_DIFF_NOT_ANALYZED", reference: secondUrl },
      { code: "GITHUB_FILE_NOT_ANALYZED", reference: secondUrl },
      { code: "GITHUB_PR_NOT_ANALYZED", reference: secondUrl },
    ]);
  });

  it("does not count search snippets as file reads and identifies an unread Route Spec", () => {
    const context = buildSpecAnalysisContext([
      issue(),
      metadata(url, ["specs/routes/refund.md"]),
      file("GITHUB_DIFF"),
      file("GITHUB_FILE", url, "specs/routes/refund.md", { query: "refund" }),
    ]);
    expect(context.resolution.completeness).toBe("PARTIAL");
    expect(context.resolution.diagnostics.map(({ code }) => code)).toEqual([
      "GITHUB_FILE_NOT_ANALYZED",
      "GITHUB_ROUTE_SPEC_NOT_ANALYZED",
    ]);
  });

  it("retains GitHub source warnings rather than silently declaring COMPLETE", () => {
    const diagnostic = {
      code: "GITHUB_FILES_UNAVAILABLE",
      level: "WARNING",
      source: "GITHUB",
      reference: url,
      message: "读取变更列表失败。",
    };
    const context = buildSpecAnalysisContext([
      issue(),
      metadata(url, [], [diagnostic]),
      file("GITHUB_DIFF"),
      file("GITHUB_FILE"),
    ]);
    expect(context.resolution).toEqual({
      completeness: "PARTIAL",
      diagnostics: [diagnostic],
    });
  });

  it("keeps informational diagnostics without degrading a fully covered analysis", () => {
    const diagnostic = {
      code: "GITHUB_DEPLOYMENT_NOT_FOUND",
      level: "INFO",
      source: "GITHUB",
      reference: url,
      message: "没有部署 URL。",
    };
    const context = buildSpecAnalysisContext([
      issue(),
      metadata(url, ["specs/routes/refund.md"], [diagnostic]),
      file("GITHUB_DIFF"),
      file("GITHUB_FILE"),
      file("GITHUB_FILE", url, "specs/routes/refund.md"),
    ]);
    expect(context.resolution).toEqual({
      completeness: "COMPLETE",
      diagnostics: [diagnostic],
    });
  });

  it("uses the latest metadata on retry instead of duplicating PRs or keeping recovered warnings", () => {
    const context = buildSpecAnalysisContext([
      issue(),
      metadata(
        url,
        [],
        [
          {
            code: "GITHUB_FILES_UNAVAILABLE",
            level: "WARNING",
            source: "GITHUB",
            message: "暂时不可用。",
          },
        ],
      ),
      metadata(),
      file("GITHUB_DIFF"),
      file("GITHUB_FILE"),
    ]);
    expect(context.pullRequests).toHaveLength(1);
    expect(context.resolution).toEqual({
      completeness: "COMPLETE",
      diagnostics: [],
    });
  });
});
