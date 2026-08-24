import { specificationPullRequestContextSchema } from "@devproof/contracts";
import { describe, expect, it } from "vitest";

import { ContextSourceError } from "./context-source.error.js";
import { IssueContextResolverService } from "./issue-context-resolver.service.js";

describe("IssueContextResolverService", () => {
  it("keeps a normalized placeholder when one GitHub repository is unavailable", async () => {
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
      getPullRequest: async (url: string, isPrimary: boolean) => {
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
    const knowledge = {
      resolve: async () => ({ diagnostics: [], items: [] }),
    };

    const result = await new IssueContextResolverService(
      linear as never,
      github as never,
      knowledge as never,
    ).resolve("PAY-1");

    expect(result.completeness).toBe("PARTIAL");
    expect(result.context.pullRequests).toHaveLength(2);
    expect(result.context.pullRequests[0]).toMatchObject({
      isPrimary: true,
      repository: "private/web",
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
