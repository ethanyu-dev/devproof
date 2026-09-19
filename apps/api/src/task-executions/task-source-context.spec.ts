import { describe, expect, it } from "vitest";
import { taskLinks } from "./task-source-context.js";

const pr = "https://github.com/acme/web/pull/197";
const task = {
  inputSnapshot: {},
  environmentSnapshot: {},
  sourceKind: "GITHUB_PULL_REQUEST",
  sourceRef: pr,
  specificationSnapshots: [],
  deployments: [],
};

describe("taskLinks", () => {
  it("shows the source PR before analysis and combines PRs without duplicates", () => {
    expect(taskLinks(task).pullRequests).toEqual([pr]);
    const related = "https://github.com/acme/api/pull/42";
    expect(
      taskLinks({
        ...task,
        inputSnapshot: { pullRequestUrls: [pr, related] },
        specificationSnapshots: [{ primaryPullRequestUrl: pr }],
      }).pullRequests,
    ).toEqual([pr, related]);
  });

  it("returns enabled deployment addresses and excludes disabled environments", () => {
    expect(
      taskLinks({
        ...task,
        environmentSnapshot: { targetUrl: "https://old.example.com" },
        deployments: [
          {
            enabled: true,
            name: "Preview",
            targetUrl: "https://preview.example.com",
          },
          {
            enabled: true,
            name: "Staging",
            targetUrl: "https://staging.example.com",
          },
          { enabled: false, name: "Old", targetUrl: "https://old.example.com" },
        ],
      }).environments,
    ).toEqual([
      { name: "Preview", url: "https://preview.example.com" },
      { name: "Staging", url: "https://staging.example.com" },
    ]);
  });

  it("uses the environment snapshot for direct and legacy runs without deployments", () => {
    expect(
      taskLinks({
        ...task,
        sourceKind: "MANUAL",
        sourceRef: null,
        environmentSnapshot: { targetUrl: "http://localhost:3000/app" },
      }),
    ).toEqual({
      pullRequests: [],
      environments: [{ name: "运行环境", url: "http://localhost:3000/app" }],
    });
  });

  it("omits missing or non-web URLs", () => {
    expect(
      taskLinks({
        ...task,
        sourceRef: "javascript:alert(1)",
        inputSnapshot: {
          pullRequestUrls: [null, "invalid", "data:text/html,test"],
        },
        environmentSnapshot: null,
      }),
    ).toEqual({ pullRequests: [], environments: [] });
  });
});
