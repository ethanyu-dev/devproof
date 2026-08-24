import {
  specificationPullRequestContextSchema,
  testGenerationContextSchema,
  type SpecificationContextDiagnostic,
  type TestGenerationContext,
} from "@devproof/contracts";
import { Injectable } from "@nestjs/common";

import { ContextSourceError } from "./context-source.error.js";
import {
  GithubPullRequestClient,
  parsePullRequestUrl,
} from "./github-pull-request.client.js";
import { KnowledgeContextClient } from "./knowledge-context.client.js";
import { LinearContextClient } from "./linear-context.client.js";

export interface ResolvedIssueContext {
  completeness: "COMPLETE" | "PARTIAL";
  context: TestGenerationContext;
  diagnostics: SpecificationContextDiagnostic[];
}

@Injectable()
export class IssueContextResolverService {
  constructor(
    private readonly linear: LinearContextClient,
    private readonly github: GithubPullRequestClient,
    private readonly knowledge: KnowledgeContextClient,
  ) {}

  readiness() {
    const linear = this.linear.configured();
    return {
      github: {
        configured: this.github.configured(),
        mode: "TOKEN" as const,
      },
      knowledge: {
        configured: this.knowledge.configured(),
        mode: "MCP" as const,
        optional: true as const,
        tool: this.knowledge.configuredTool(),
      },
      linear: {
        configured: linear,
        mode: this.linear.mode(),
        tool: this.linear.configuredTool(),
      },
      ready: linear,
    };
  }

  async resolve(issueRef: string): Promise<ResolvedIssueContext> {
    const linear = await this.linear.getIssue(issueRef);
    const diagnostics: SpecificationContextDiagnostic[] = [];
    const pullRequests = await Promise.all(
      linear.pullRequestUrls.map(async (url, index) => {
        try {
          const result = await this.github.getPullRequest(url, index === 0);
          diagnostics.push(...result.diagnostics);
          return result.pullRequest;
        } catch (error) {
          const sourceError =
            error instanceof ContextSourceError
              ? error
              : new ContextSourceError(
                  "GITHUB",
                  "GITHUB_PR_RESOLUTION_FAILED",
                  error instanceof Error ? error.message : String(error),
                  url,
                );
          diagnostics.push({
            code: sourceError.code,
            level: "WARNING",
            message: sourceError.message,
            reference: sourceError.reference,
            source: "GITHUB",
          });
          return minimalPullRequest(url, index === 0);
        }
      }),
    );
    const knowledge = await this.knowledge.resolve(linear.issue);
    diagnostics.push(...knowledge.diagnostics);
    const completeness = diagnostics.some(
      (diagnostic) =>
        diagnostic.level === "WARNING" || diagnostic.level === "ERROR",
    )
      ? "PARTIAL"
      : "COMPLETE";
    const context = testGenerationContextSchema.parse({
      issue: linear.issue,
      knowledge: knowledge.items,
      pullRequests,
      resolution: { completeness, diagnostics },
    });
    return { completeness, context, diagnostics };
  }
}

function minimalPullRequest(url: string, isPrimary: boolean) {
  const reference = parsePullRequestUrl(url);
  return specificationPullRequestContextSchema.parse({
    id: url,
    isPrimary,
    number: reference.number,
    organization: reference.owner,
    repository: `${reference.owner}/${reference.repository}`,
    title: `Pull Request #${reference.number}`,
    url,
  });
}
