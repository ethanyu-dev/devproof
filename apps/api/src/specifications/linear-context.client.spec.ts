import { describe, expect, it } from "vitest";

import {
  extractGithubPullRequestUrls,
  issueToolArguments,
  normalizeIssueRef,
  normalizeIssueResult,
  selectIssueTool,
} from "./linear-context.client.js";

describe("Linear MCP issue context", () => {
  it("prefers an exact read-only Issue lookup tool", () => {
    const tools = [
      tool("list_issues", { query: { type: "string" } }),
      tool("get_issue", { id: { type: "string" } }, ["id"]),
    ];

    expect(selectIssueTool(tools).name).toBe("get_issue");
    expect(selectIssueTool(tools, "list_issues").name).toBe("list_issues");
  });

  it("rejects a configured write tool", () => {
    expect(() =>
      selectIssueTool(
        [tool("update_issue", { id: { type: "string" } }, ["id"])],
        "update_issue",
      ),
    ).toThrow("不是安全的只读工具");
  });

  it("maps a Linear URL to the inferred Issue argument", () => {
    expect(
      issueToolArguments(
        tool("get_issue", { id: { type: "string" } }, ["id"]),
        normalizeIssueRef(
          "https://linear.app/acme/issue/ENG-123/refund-workflow",
        ),
      ),
    ).toEqual({ id: "ENG-123" });
  });

  it("normalizes the official get_issue result and prioritizes attached PRs", () => {
    const issueUrl = "https://linear.app/acme/issue/ENG-125/frontend-support";
    const result = normalizeIssueResult(
      {
        content: [
          {
            text: "Related: https://github.com/payments/ledger/pull/44",
            type: "text",
          },
        ],
        structuredContent: {
          issue: {
            assignee: {
              email: "Owner@Example.com",
              id: "linear-user-42",
              name: "Issue Owner",
            },
            attachments: [{ url: "https://github.com/acme/web/pull/12" }],
            description: "- 用户应该可以保存下架时间。",
            id: "ENG-125",
            labels: ["regression"],
            priority: { name: "Medium", value: 3 },
            status: "In Review",
            title: "前端支持下架时间",
            url: issueUrl,
          },
        },
      },
      issueUrl,
    );

    expect(result.issue).toMatchObject({
      assignee: {
        email: "owner@example.com",
        externalId: "linear-user-42",
        issuerKey: "linear:mcp:default",
        name: "Issue Owner",
        type: "HUMAN",
      },
      id: "ENG-125",
      identifier: "ENG-125",
      labels: ["regression"],
      priority: 3,
      state: "In Review",
    });
    expect(result.pullRequestUrls).toEqual([
      "https://github.com/acme/web/pull/12",
      "https://github.com/payments/ledger/pull/44",
    ]);
  });

  it("normalizes a content-only MCP result without structuredContent", () => {
    const result = normalizeIssueResult(
      {
        content: [
          {
            text: JSON.stringify({
              description: "验证退款流程。",
              id: "ENG-123",
              identifier: "ENG-123",
              status: "In Review",
              title: "退款流程",
              url: "https://linear.app/acme/issue/ENG-123/refund",
              pullRequestUrl: "https://github.com/acme/web/pull/54",
            }),
            type: "text",
          },
        ],
      },
      "ENG-123",
    );

    expect(result.issue.identifier).toBe("ENG-123");
    expect(result.pullRequestUrls).toEqual([
      "https://github.com/acme/web/pull/54",
    ]);
  });

  it("only extracts canonical GitHub Pull Request URLs", () => {
    expect(
      extractGithubPullRequestUrls(
        "https://github.com/a/one/pull/1 https://evil.test/a/one/pull/2",
      ),
    ).toEqual(["https://github.com/a/one/pull/1"]);
  });
});

function tool(
  name: string,
  properties: Record<string, object>,
  required: string[] = [],
) {
  return {
    annotations: { destructiveHint: false, readOnlyHint: true },
    inputSchema: { properties, required, type: "object" as const },
    name,
  };
}
