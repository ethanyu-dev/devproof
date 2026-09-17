import type { SpecTaskCreateInput } from "@devproof/contracts";

/** Display metadata is a projection, never a task or deduplication key. */
export function taskSourcePresentation(
  input: Pick<
    SpecTaskCreateInput,
    "issueRef" | "pullRequestUrls" | "title" | "goal"
  >,
  context?: {
    issue?: { identifier: string; title: string } | null;
    pullRequests?: Array<{
      url: string;
      repository: string;
      number: number;
      title: string;
    }>;
  },
) {
  const issue = context?.issue;
  const pr =
    context?.pullRequests?.find(
      (item) => item.url === input.pullRequestUrls?.[0],
    ) ?? context?.pullRequests?.[0];
  const issueRef = issue?.identifier ?? input.issueRef;
  const prRef = pr?.url ?? input.pullRequestUrls?.[0];
  return {
    sourceKind: issueRef
      ? "LINEAR_ISSUE"
      : prRef
        ? "GITHUB_PULL_REQUEST"
        : "TASK_BRIEF",
    sourceRef: issueRef ?? prRef ?? null,
    title:
      input.title ??
      (issue
        ? `${issue.identifier} · ${issue.title}`
        : pr
          ? `${pr.repository}#${pr.number} · ${pr.title}`
          : (input.issueRef ??
            input.pullRequestUrls?.[0] ??
            input.goal!.slice(0, 500))),
  };
}
