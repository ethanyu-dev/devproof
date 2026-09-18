import { specificationPullRequestContextSchema } from "@devproof/contracts";
import { describe, expect, it } from "vitest";

import { ContextSourceError } from "./context-source.error.js";
import { IssueContextResolverService } from "./issue-context-resolver.service.js";

describe("IssueContextResolverService", () => {
  it("resolves available Issue content for prerequisite checks", async () => {
    const linear = {
      configured: () => true,
      configuredTool: () => null,
      mode: () => "API",
      getIssue: async () => ({
        issue: {
          id: "issue-1",
          identifier: "PAY-1",
          title: "Refund order",
          url: "https://linear.app/acme/issue/PAY-1",
        },
        pullRequestUrls: [],
      }),
    };
    const service = new IssueContextResolverService(
      linear as never,
      {
        configured: async () => false,
        discoverIssuePullRequests: async () => ({
          pullRequestUrls: [],
          diagnostics: [],
        }),
      } as never,
    );

    expect(await service.readiness("team-1")).toEqual({
      github: { configured: false, mode: "TOKEN" },
      linear: { configured: true, mode: "API", tool: null },
      ready: true,
    });
    const result = await service.resolve("PAY-1", "team-1");
    expect(result.completeness).toBe("COMPLETE");
    expect(result.diagnostics).toEqual([]);
    expect(result.context.knowledge).toEqual([]);
    expect(result.context.pullRequests).toEqual([]);
  });

  it("retains a warning but excludes an unavailable discovered PR", async () => {
    const urls = [
      "https://github.com/private/web/pull/1",
      "https://github.com/acme/api/pull/2",
    ];
    const linear = {
      getIssue: async () => ({
        issue: {
          description: "- User should be able to refund an order",
          id: "issue-1",
          identifier: "PAY-1",
          labels: ["payments"],
          priority: 1,
          state: "In Review",
          title: "Refund order",
          url: "https://linear.app/acme/issue/PAY-1",
        },
        pullRequestUrls: urls,
      }),
    };
    const github = {
      getPullRequest: async (
        _teamId: string,
        url: string,
        isPrimary: boolean,
      ) => {
        if (url.includes("private/web")) {
          throw new ContextSourceError(
            "GITHUB",
            "GITHUB_REPOSITORY_NOT_AUTHORIZED",
            "Token cannot access private/web.",
            url,
          );
        }
        return {
          diagnostics: [],
          pullRequest: specificationPullRequestContextSchema.parse({
            body: "Implements PAY-1",
            changedFiles: ["services/refund.ts"],
            id: "pr-2",
            headSha: "abc123",
            isPrimary,
            number: 2,
            organization: "acme",
            repository: "acme/api",
            title: "Refund API",
            url,
          }),
        };
      },
    };
    const result = await new IssueContextResolverService(
      linear as never,
      github as never,
    ).resolve("PAY-1", "team-1");

    expect(result.completeness).toBe("PARTIAL");
    expect(result.context.pullRequests).toHaveLength(1);
    expect(result.context.pullRequests[0]).toMatchObject({
      isPrimary: true,
      repository: "acme/api",
    });
    expect(result.context.resolution.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "GITHUB_REPOSITORY_NOT_AUTHORIZED",
          level: "WARNING",
        }),
      ]),
    );
  });
});
