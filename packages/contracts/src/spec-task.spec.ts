import { describe, expect, it } from "vitest";
import {
  isSpecTask,
  taskExecutionCreateInputSchema,
  testGenerationContextSchema,
  normalizeGithubPullRequestUrl,
} from "./index.js";

const base = { kind: "SPEC_TASK", idempotencyKey: "new-test-request" };
const pr = "https://github.com/acme/web/pull/42";
describe("source-independent task contract", () => {
  it.each([
    { issueRef: "ENG-42" },
    { pullRequestUrls: [pr] },
    { goal: "保存订单后重新打开，核对订单状态。" },
  ])("accepts one sufficient source: %j", (source) => {
    const input = taskExecutionCreateInputSchema.parse({ ...base, ...source });
    expect(isSpecTask(input)).toBe(true);
  });
  it("rejects a title or deployment without test context", () => {
    expect(
      taskExecutionCreateInputSchema.safeParse({
        ...base,
        title: "测试任务",
        targetUrl: "https://preview.example.com",
      }).success,
    ).toBe(false);
  });
  it("preserves legacy inputs while rejecting owner mode without an Issue", () => {
    expect(
      taskExecutionCreateInputSchema.parse({
        ...base,
        kind: "ISSUE_SPEC",
        issueRef: "ENG-42",
      }).kind,
    ).toBe("ISSUE_SPEC");
    expect(
      taskExecutionCreateInputSchema.safeParse({
        ...base,
        pullRequestUrls: [pr],
        profilePolicy: { strategy: "ISSUE_ASSIGNEE" },
      }).success,
    ).toBe(false);
  });
  it("canonicalizes PR views and deduplicates without changing primary order", () => {
    expect(
      taskExecutionCreateInputSchema.parse({
        ...base,
        pullRequestUrls: [
          pr + "/files?diff=split#L42",
          pr,
          "https://github.com/ACME/Web/pull/43/commits",
        ],
      }),
    ).toMatchObject({
      pullRequestUrls: [pr, "https://github.com/acme/web/pull/43"],
    });
    for (const invalid of [
      "https://github.com/acme/web/issues/42",
      "https://github.com.evil.test/acme/web/pull/42",
      "https://u:p@github.com/acme/web/pull/42",
      "http://github.com/acme/web/pull/42",
    ])
      expect(normalizeGithubPullRequestUrl(invalid)).toBeNull();
  });
  it("reads a context without fabricating a Linear identity", () => {
    expect(
      testGenerationContextSchema.parse({
        goal: "验证保存结果",
        pullRequests: [],
      }),
    ).toMatchObject({ issue: null, goal: "验证保存结果" });
  });
});
