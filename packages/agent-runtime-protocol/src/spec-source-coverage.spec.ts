import { describe, expect, it } from "vitest";

import { specPullRequestCoverage } from "./spec-source-coverage.js";

const url = "https://github.com/acme/web/pull/42";

describe("specPullRequestCoverage", () => {
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
