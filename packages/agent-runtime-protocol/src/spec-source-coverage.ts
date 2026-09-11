type AnalysisSource = {
  kind: string;
  uri: string;
  locator: Record<string, unknown>;
};

// Both the executor and control plane assess the same observed source coverage.
// A search snippet is evidence, but does not replace reading the relevant file.
export function specPullRequestCoverage(
  pullRequests: readonly { url: string; changedFiles?: readonly string[] }[],
  sources: readonly AnalysisSource[],
) {
  return pullRequests.map(({ url, changedFiles = [] }) => {
    const related = sources.filter(
      (source) => source.uri === url || source.uri.startsWith(`${url}/files#`),
    );
    const diffs = related.filter((source) => source.kind === "GITHUB_DIFF");
    const files = related.filter(
      (source) =>
        source.kind === "GITHUB_FILE" && source.locator.query === undefined,
    );
    const removedPaths = new Set(
      diffs
        .filter((source) => source.locator.status === "removed")
        .map((source) => source.locator.path),
    );
    const routeSpecs = new Set(
      [...changedFiles, ...diffs.map((source) => source.locator.path)].filter(
        (path): path is string =>
          typeof path === "string" &&
          /(?:^|\/)specs\/routes\/.+\.mdx?$/iu.test(path) &&
          !removedPaths.has(path),
      ),
    );
    return {
      url,
      metadataRead: related.some(
        (source) => source.kind === "GITHUB_PULL_REQUEST",
      ),
      diffSourceCount: diffs.length,
      fileSourceCount: files.length,
      unreadRouteSpecs: [...routeSpecs].filter(
        (path) => !files.some((source) => source.locator.path === path),
      ),
    };
  });
}
