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
      fileReadRequired: !(
        changedFiles.length > 0 &&
        changedFiles.every((path) => removedPaths.has(path))
      ),
      unreadRouteSpecs: [...routeSpecs].filter(
        (path) => !files.some((source) => source.locator.path === path),
      ),
    };
  });
}

/** Enforced identically by the worker and control plane. Empty selection is valid. */
export function specSelectedSourceCoverageError(
  pullRequests: readonly { url: string; changedFiles?: readonly string[] }[],
  sources: readonly AnalysisSource[],
) {
  for (const coverage of specPullRequestCoverage(pullRequests, sources)) {
    if (!coverage.metadataRead)
      return `完成 Spec 前必须读取选定 PR 的元数据：${coverage.url}`;
    if (
      !coverage.diffSourceCount ||
      (coverage.fileReadRequired && !coverage.fileSourceCount)
    )
      return `完成 Spec 前必须检查选定 PR 的变更 diff 和相关文件内容；代码搜索片段不能替代文件读取：${coverage.url}`;
    if (coverage.unreadRouteSpecs.length)
      return `完成 Spec 前必须读取 ${coverage.url} 的 Route Spec：${coverage.unreadRouteSpecs.join("、")}`;
  }
  return null;
}
