import type { SpecTaskCreateInput } from "@devproof/contracts";

export function taskLinks(task: {
  inputSnapshot: unknown;
  environmentSnapshot: unknown;
  sourceKind: string;
  sourceRef: string | null;
  specificationSnapshots: Array<{ primaryPullRequestUrl?: string | null }>;
  deployments: Array<{ enabled: boolean; name: string; targetUrl: string }>;
}) {
  const input = object(task.inputSnapshot);
  const pullRequests = [
    task.specificationSnapshots[0]?.primaryPullRequestUrl,
    ...(Array.isArray(input.pullRequestUrls) ? input.pullRequestUrls : []),
    task.sourceKind === "GITHUB_PULL_REQUEST" ? task.sourceRef : null,
  ].filter(isWebUrl);
  const environments = task.deployments
    .filter((deployment) => deployment.enabled !== false)
    .map((deployment) => ({
      name: deployment.name,
      url: deployment.targetUrl,
    }))
    .filter((environment) => isWebUrl(environment.url));
  const targetUrl = object(task.environmentSnapshot).targetUrl;
  if (task.deployments.length === 0 && isWebUrl(targetUrl)) {
    environments.push({ name: "运行环境", url: targetUrl });
  }
  return { pullRequests: [...new Set(pullRequests)], environments };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isWebUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

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
