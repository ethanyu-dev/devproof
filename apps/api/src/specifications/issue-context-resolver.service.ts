import {
  resolveSpecTaskContext,
  type AnalysisContextManifest,
} from "./spec-task-context.js";
import {
  type SpecificationContextDiagnostic,
  type TestGenerationContext,
} from "@devproof/contracts";
import { Injectable } from "@nestjs/common";

import { GithubPullRequestClient } from "./github-pull-request.client.js";
import { LinearContextClient } from "./linear-context.client.js";

export interface ResolvedIssueContext {
  completeness: "COMPLETE" | "PARTIAL";
  context: TestGenerationContext;
  diagnostics: SpecificationContextDiagnostic[];
  manifest: AnalysisContextManifest;
}

@Injectable()
export class IssueContextResolverService {
  constructor(
    private readonly linear: LinearContextClient,
    private readonly github: GithubPullRequestClient,
  ) {}

  async readiness(teamId: string) {
    const linear = this.linear.configured();
    const github = await this.github.configured(teamId);
    return {
      github: {
        configured: github,
        mode: "TOKEN" as const,
      },
      linear: {
        configured: linear,
        mode: this.linear.mode(),
        tool: this.linear.configuredTool(),
      },
      ready: linear || github,
    };
  }

  async resolve(
    issueRef: string | undefined,
    teamId: string,
    explicitPullRequestUrls?: string[],
    goal?: string,
  ): Promise<ResolvedIssueContext> {
    const resolved = await resolveSpecTaskContext(
      { issueRef, pullRequestUrls: explicitPullRequestUrls, goal },
      teamId,
      this.linear,
      this.github,
    );
    return {
      context: resolved.context,
      completeness: resolved.context.resolution.completeness,
      diagnostics: resolved.manifest.diagnostics,
      manifest: resolved.manifest,
    };
  }
}
