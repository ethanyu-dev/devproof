import { describe, expect, it } from "vitest";
import { specAnalysisInputRequestSchema } from "@devproof/agent-runtime-protocol";
import { assessAnalysisInputs } from "./task-analysis-input.js";

const prUrl = "https://github.com/acme/web/pull/42";
const targetUrl = "https://preview.example.com";
const input = {
  kind: "ISSUE_SPEC",
  issueRef: "ENG-123",
  idempotencyKey: "analysis-input-test",
  pullRequestUrls: [prUrl],
};
const issueSource = {
  kind: "LINEAR_ISSUE",
  uri: "https://linear.app/acme/issue/ENG-123",
  content: {
    issue: { description: "Verify the refund behavior." },
    pullRequestUrls: [prUrl],
  },
};
function prSource(uri = prUrl, deployment: Record<string, unknown> = {}) {
  return {
    kind: "GITHUB_PULL_REQUEST",
    uri,
    content: {
      pullRequest: { title: "Refund", headSha: "abc123", ...deployment },
    },
  };
}

describe("analysis prerequisites", () => {
  it.each([
    [prUrl, prUrl],
    [`${prUrl}/`, prUrl],
    [prUrl, `${prUrl}/`],
    [`${prUrl}/`, `${prUrl}/`],
  ])("matches explicit %s with persisted %s", (requested, persisted) => {
    const result = assessAnalysisInputs(
      { ...input, pullRequestUrls: [requested], targetUrl },
      [
        {
          ...issueSource,
          content: { ...issueSource.content, pullRequestUrls: [persisted] },
        },
        prSource(persisted),
      ],
    );
    expect(result).toEqual({
      request: null,
      targetUrl,
      pullRequestUrls: [prUrl],
    });
  });

  it("still requests PR content when only its link is available", () => {
    const result = assessAnalysisInputs({ ...input, targetUrl }, [issueSource]);
    expect(result.request?.missing).toEqual(["PULL_REQUEST"]);
  });

  it("accepts unique deployment URLs from older sources without candidate lists", () => {
    expect(
      assessAnalysisInputs(input, [
        issueSource,
        prSource(prUrl, { deploymentUrl: targetUrl }),
      ]),
    ).toMatchObject({ request: null, targetUrl });
  });

  it("requires a choice across all PR candidates and accepts an explicit target", () => {
    const otherPr = "https://github.com/acme/api/pull/7";
    const candidates = [targetUrl, "https://staging.example.com"];
    const sources = [
      issueSource,
      prSource(prUrl, {
        deploymentUrl: null,
        deploymentCandidates: candidates,
      }),
      prSource(otherPr, { deploymentUrl: "https://api.example.com" }),
    ];
    const requestInput = { ...input, pullRequestUrls: [prUrl, otherPr] };
    const result = assessAnalysisInputs(requestInput, sources);
    expect(result.targetUrl).toBeNull();
    expect(result.request).toMatchObject({
      missing: ["DEPLOYMENT_TARGET"],
      deploymentCandidates: [...candidates, "https://api.example.com"],
    });
    expect(
      assessAnalysisInputs(
        {
          ...requestInput,
          deployments: [
            { key: "staging", name: "Staging", targetUrl: candidates[1] },
          ],
        },
        sources,
      ),
    ).toMatchObject({ request: null, targetUrl: candidates[1] });
  });

  it("deduplicates candidate lists and the legacy deployment URL", () => {
    expect(
      assessAnalysisInputs(input, [
        issueSource,
        prSource(prUrl, {
          deploymentUrl: targetUrl,
          deploymentCandidates: [targetUrl, targetUrl],
        }),
      ]),
    ).toMatchObject({ request: null, targetUrl });
  });

  it("bounds displayed candidates without treating an ambiguous set as unique", () => {
    const urls = Array.from(
      { length: 3 },
      (_, i) => `https://github.com/acme/web/pull/${i + 1}`,
    );
    const result = assessAnalysisInputs({ ...input, pullRequestUrls: urls }, [
      {
        ...issueSource,
        content: { ...issueSource.content, pullRequestUrls: urls },
      },
      ...urls.map((url, i) =>
        prSource(url, {
          deploymentCandidates: Array.from(
            { length: 10 },
            (_, j) => `https://preview-${i}-${j}.example.com`,
          ),
        }),
      ),
    ]);
    expect(result.targetUrl).toBeNull();
    expect(result.request?.deploymentCandidates).toHaveLength(25);
    expect(
      specAnalysisInputRequestSchema.safeParse(result.request).success,
    ).toBe(true);
  });
});
