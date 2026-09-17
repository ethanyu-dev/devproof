import {
  normalizeGithubPullRequestUrl,
  testGenerationContextSchema,
  type SpecTaskCreateInput,
  type SpecificationContextDiagnostic,
} from "@devproof/contracts";
import { ContextSourceError } from "./context-source.error.js";
import type { GithubPullRequestClient } from "./github-pull-request.client.js";
import type { LinearContextClient } from "./linear-context.client.js";

export type AnalysisContextManifest = {
  version: 2;
  pullRequestUrls: string[];
  diagnostics: SpecificationContextDiagnostic[];
  sources: Array<{
    kind: "LINEAR_ISSUE" | "GITHUB_PULL_REQUEST" | "TASK_BRIEF";
    ref: string;
    origin: "EXPLICIT" | "DISCOVERED";
    status: "READ" | "UNAVAILABLE";
    revision?: string;
  }>;
};

export function readAnalysisManifest(
  value: unknown,
): AnalysisContextManifest | undefined {
  const item = value as Partial<AnalysisContextManifest> | null;
  return item?.version === 2 && Array.isArray(item.pullRequestUrls)
    ? (item as AnalysisContextManifest)
    : undefined;
}

/** Both analysis modes resolve sources with the same selection/failure policy. */
export async function resolveSpecTaskContext(
  input: Pick<SpecTaskCreateInput, "issueRef" | "pullRequestUrls" | "goal">,
  teamId: string,
  linearClient: Pick<LinearContextClient, "getIssue">,
  github: Pick<
    GithubPullRequestClient,
    "getPullRequest" | "discoverIssuePullRequests"
  >,
  pinnedRevision?: (url: string) => Promise<string | undefined>,
  previous?: AnalysisContextManifest,
  onIssueRead?: (
    issue: Awaited<ReturnType<LinearContextClient["getIssue"]>>,
  ) => Promise<void>,
) {
  const manifest: AnalysisContextManifest = {
    version: 2,
    pullRequestUrls: [],
    diagnostics: [],
    sources: [],
  };
  let linear: Awaited<ReturnType<LinearContextClient["getIssue"]>> | null =
    null;
  const failure = (
    error: unknown,
    source: "LINEAR" | "GITHUB",
    ref: string,
    required: boolean,
  ) => {
    if (required && !(error instanceof ContextSourceError)) throw error;
    if (
      required &&
      error instanceof ContextSourceError &&
      ((error.status !== null &&
        (error.status >= 500 || error.status === 429)) ||
        (error.status === null && /REQUEST_FAILED$/u.test(error.code)))
    )
      throw error;
    manifest.diagnostics.push({
      source,
      reference: ref,
      level: "WARNING",
      code:
        error instanceof ContextSourceError ? error.code : "SOURCE_UNAVAILABLE",
      message: (error instanceof Error ? error.message : String(error)).slice(
        0,
        2_000,
      ),
    });
  };
  if (input.issueRef) {
    try {
      linear = await linearClient.getIssue(input.issueRef);
    } catch (error) {
      failure(error, "LINEAR", input.issueRef, true);
    }
    if (linear) await onIssueRead?.(linear);
    manifest.sources.push({
      kind: "LINEAR_ISSUE",
      ref: input.issueRef,
      origin: "EXPLICIT",
      status: linear ? "READ" : "UNAVAILABLE",
    });
    manifest.diagnostics.push(...(linear?.diagnostics ?? []));
  }
  if (input.goal)
    manifest.sources.push({
      kind: "TASK_BRIEF",
      ref: "task:brief",
      origin: "EXPLICIT",
      status: "READ",
    });
  // An explicit list, including [], is the user's selected PR scope.
  let discovered =
    input.pullRequestUrls === undefined ? (linear?.pullRequestUrls ?? []) : [];
  if (
    !previous &&
    input.pullRequestUrls === undefined &&
    !discovered.length &&
    linear
  ) {
    try {
      const discovery = await github.discoverIssuePullRequests(
        teamId,
        linear.issue.url,
      );
      discovered = discovery.pullRequestUrls;
      manifest.diagnostics.push(...discovery.diagnostics);
    } catch (error) {
      failure(error, "GITHUB", linear.issue.url, false);
    }
  }
  const urls = [
    ...new Set(
      previous?.pullRequestUrls ??
        [...(input.pullRequestUrls ?? []), ...discovered]
          .map(normalizeGithubPullRequestUrl)
          .filter((url): url is string => Boolean(url)),
    ),
  ].slice(0, 25);
  const pullRequests: Awaited<
    ReturnType<GithubPullRequestClient["getPullRequest"]>
  >[] = [];
  for (const url of urls) {
    const explicit = input.pullRequestUrls?.includes(url) ?? false;
    // Once selected in an attempt, a discovered source cannot disappear on retry.
    const required =
      explicit || Boolean(previous?.pullRequestUrls.includes(url));
    try {
      const resolved = await github.getPullRequest(
        teamId,
        url,
        pullRequests.length === 0,
        await pinnedRevision?.(url),
      );
      // GitHub's html_url can have different casing; keep the selected canonical
      // reference stable for coverage, authorization and revision pinning.
      resolved.pullRequest = { ...resolved.pullRequest, url };
      if (resolved.pullRequest.headSha === "unknown")
        throw new Error("PR revision is unavailable.");
      pullRequests.push(resolved);
      manifest.pullRequestUrls.push(url);
      manifest.diagnostics.push(...resolved.diagnostics);
      manifest.sources.push({
        kind: "GITHUB_PULL_REQUEST",
        ref: url,
        origin: explicit ? "EXPLICIT" : "DISCOVERED",
        status: "READ",
        revision: resolved.pullRequest.headSha,
      });
    } catch (error) {
      failure(error, "GITHUB", url, required);
      manifest.sources.push({
        kind: "GITHUB_PULL_REQUEST",
        ref: url,
        origin: explicit ? "EXPLICIT" : "DISCOVERED",
        status: "UNAVAILABLE",
      });
      if (required) manifest.pullRequestUrls.push(url);
    }
  }
  const context = testGenerationContextSchema.parse({
    contextVersion: 2,
    issue: linear?.issue ?? null,
    ...(input.goal ? { goal: input.goal } : {}),
    pullRequests: pullRequests.map((item) => item.pullRequest),
    resolution: {
      completeness: manifest.diagnostics.some((item) => item.level !== "INFO")
        ? "PARTIAL"
        : "COMPLETE",
      diagnostics: manifest.diagnostics,
    },
  });
  return { linear, pullRequests, context, manifest };
}
