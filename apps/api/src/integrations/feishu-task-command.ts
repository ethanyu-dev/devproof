import { normalizeGithubPullRequestUrl } from "@devproof/contracts";

/** Parse references before targets; a provider link is never a deployment. */
export function parseFeishuTaskCommand(text: string) {
  const clean = (value: string) => value.replace(/[，。；、！!）)\]}>]+$/u, "");
  const goalMatch = /(?:^|\s)--goal\s+([\s\S]+)$/iu.exec(text);
  const goal = goalMatch?.[1]?.trim();
  const command = goalMatch ? text.slice(0, goalMatch.index) : text;
  const urls = [
    ...new Set((command.match(/https?:\/\/[^\s<>]+/giu) ?? []).map(clean)),
  ];
  const issueIds = new Set(
    command
      .replace(/https?:\/\/[^\s<>]+/giu, "")
      .match(/\b[A-Z][A-Z0-9]{1,20}-\d+\b/gu) ?? [],
  );
  let issueRef = [...issueIds][0];
  const pullRequestUrls: string[] = [];
  const remaining: string[] = [];
  for (const value of urls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("链接格式无效，请使用完整的 HTTPS 或 HTTP 地址。");
    }
    if (url.username || url.password) throw new Error("链接不能包含账号密码。");
    if (url.hostname === "github.com") {
      const pr = normalizeGithubPullRequestUrl(value);
      if (!pr)
        throw new Error(
          "GitHub 来源须为 PR 链接，例如 https://github.com/组织/仓库/pull/123。",
        );
      pullRequestUrls.push(pr);
    } else if (url.hostname === "linear.app") {
      if (
        url.protocol !== "https:" ||
        url.port ||
        !/^\/[^/]+\/issue\/[a-z][a-z0-9]*-\d+(?:\/|$)/iu.test(url.pathname)
      )
        throw new Error("请提供有效的 Linear Issue 链接。");
      issueIds.add(url.pathname.split("/")[3]!.toUpperCase());
      if (issueRef?.startsWith("https://") && issueRef !== value)
        throw new Error("一次任务请只指定一个 Issue。");
      issueRef = value;
    } else remaining.push(value);
  }
  if (issueIds.size > 1) throw new Error("一次任务请只指定一个 Issue。");
  const explicitTargets = [
    ...command.matchAll(/(?:^|\s)--target\s+(https?:\/\/[^\s<>]+)/giu),
  ].map((match) => clean(match[1]!));
  if (
    [...command.matchAll(/(?:^|\s)--target(?:\s|$)/gu)].length !==
    explicitTargets.length
  )
    throw new Error("--target 后需要填写完整的测试环境地址。");
  if (explicitTargets.some((target) => !remaining.includes(target)))
    throw new Error("测试环境不能使用 Issue 或 PR 链接。");
  if (!explicitTargets.length && remaining.length > 1)
    throw new Error(
      "发现多个环境候选，请用 --target 明确指定本次测试环境；多个环境可重复使用 --target。",
    );
  const targetUrls = [
    ...new Set(explicitTargets.length ? explicitTargets : remaining),
  ];
  return {
    issueRef,
    pullRequestUrls: [...new Set(pullRequestUrls)],
    targetUrls,
    ...(goal ? { goal } : {}),
  };
}
