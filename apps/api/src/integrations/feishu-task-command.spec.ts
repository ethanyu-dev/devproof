import { describe, expect, it } from "vitest";
import { parseFeishuTaskCommand } from "./feishu-task-command.js";
const pr = "https://github.com/acme/web/pull/42";
const target = "https://preview.example.com";
describe("Feishu task references", () => {
  it.each([
    `${pr} ${target}`,
    `${target} ${pr}`,
    `${pr}/files?diff=split#L2， ${target}`,
    `${pr} ${pr} ${target}`,
  ])("accepts PR-only commands and never uses the PR as target: %s", (text) => {
    expect(parseFeishuTaskCommand(text)).toEqual({
      issueRef: undefined,
      pullRequestUrls: [pr],
      targetUrls: [target],
    });
  });
  it("separates Issue, PR and explicitly selected environments", () => {
    expect(
      parseFeishuTaskCommand(
        `ENG-1 ${pr} --target ${target} --target https://staging.example.com`,
      ),
    ).toEqual({
      issueRef: "ENG-1",
      pullRequestUrls: [pr],
      targetUrls: [target, "https://staging.example.com"],
    });
  });
  it("does not require an environment before task creation", () => {
    expect(parseFeishuTaskCommand(pr + " --ephemeral").targetUrls).toEqual([]);
  });
  it("rejects ambiguity and provider pages used as targets", () => {
    expect(() =>
      parseFeishuTaskCommand(`${pr} ${target} https://other.example.com`),
    ).toThrow("多个环境候选");
    expect(() => parseFeishuTaskCommand(`--target ${pr}`)).toThrow(
      "不能使用 Issue 或 PR",
    );
    expect(() =>
      parseFeishuTaskCommand("https://github.com/acme/web/issues/1"),
    ).toThrow("须为 PR");
    expect(() => parseFeishuTaskCommand(`ENG-1 ENG-2 ${target}`)).toThrow(
      "只指定一个 Issue",
    );
    expect(() =>
      parseFeishuTaskCommand(`ENG-1 https://linear.app/acme/issue/ENG-2/title`),
    ).toThrow("只指定一个 Issue");
    expect(() =>
      parseFeishuTaskCommand(`${pr} --target ${target} --target`),
    ).toThrow("完整的测试环境地址");
  });
  it("does not infer Issue IDs from repository names or testing prose", () => {
    expect(
      parseFeishuTaskCommand("https://github.com/acme/ENG-123/pull/42")
        .issueRef,
    ).toBeUndefined();
    expect(
      parseFeishuTaskCommand(`${target} --goal 确认 ENG-123 不会显示在页面上`),
    ).toEqual({
      issueRef: undefined,
      pullRequestUrls: [],
      targetUrls: [target],
      goal: "确认 ENG-123 不会显示在页面上",
    });
  });
});
