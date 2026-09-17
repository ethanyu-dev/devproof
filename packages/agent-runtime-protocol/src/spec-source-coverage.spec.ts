import { describe, expect, it } from "vitest";

import {
  specPullRequestCoverage,
  specSelectedSourceCoverageError,
} from "./spec-source-coverage.js";

const url = "https://github.com/acme/web/pull/42";

describe("specPullRequestCoverage", () => {
  it("allows no PR and deletion-only changes but still requires selected metadata and diffs", () => {
    expect(specSelectedSourceCoverageError([], [])).toBeNull();
    expect(specSelectedSourceCoverageError([{ url }], [])).toContain("元数据");
    const sources = [
      { kind: "GITHUB_PULL_REQUEST", uri: url, locator: {} },
      {
        kind: "GITHUB_DIFF",
        uri: `${url}/files#deleted`,
        locator: { path: "src/deleted.ts", status: "removed" },
      },
    ];
    expect(
      specSelectedSourceCoverageError(
        [{ url, changedFiles: ["src/deleted.ts"] }],
        sources,
      ),
    ).toBeNull();
    expect(
      specSelectedSourceCoverageError(
        [{ url, changedFiles: ["src/deleted.ts", "src/modified.ts"] }],
        sources,
      ),
    ).toContain("相关文件");
  });
  it("does not match a PR with the same numeric prefix", () => {
    expect(
      specPullRequestCoverage(
        [{ url }],
        [
          {
            kind: "GITHUB_PULL_REQUEST",
            uri: `${url}0`,
            locator: {},
          },
        ],
      )[0]!.metadataRead,
    ).toBe(false);
  });

  it("discovers Route Specs from diffs but does not require reading deleted files at head", () => {
    const [coverage] = specPullRequestCoverage(
      [{ url, changedFiles: ["specs/routes/deleted.md"] }],
      [
        {
          kind: "GITHUB_DIFF",
          uri: `${url}/files#deleted`,
          locator: { path: "specs/routes/deleted.md", status: "removed" },
        },
        {
          kind: "GITHUB_DIFF",
          uri: `${url}/files#changed`,
          locator: { path: "specs/routes/changed.md", status: "modified" },
        },
      ],
    );
    expect(coverage!.unreadRouteSpecs).toEqual(["specs/routes/changed.md"]);
  });
});
