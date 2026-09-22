import {
  assessAcceptance,
  criterionScoringExclusion,
} from "@devproof/contracts";
import type {
  TaskAcceptanceReport,
  AcceptanceVerdict,
  AcceptanceIssue,
} from "@devproof/contracts";

export const acceptanceLabels: Record<AcceptanceVerdict, string> = {
  PASSED: "通过",
  FAILED: "未通过",
  INCONCLUSIVE: "无法判定",
  PENDING: "待完成",
};
export const acceptanceIssueLabels: Record<
  AcceptanceIssue["category"],
  string
> = {
  CONTEXT: "补充信息",
  PRODUCT: "产品问题",
  EVIDENCE: "证据不足",
  UNDETERMINED: "无法判定",
  COVERAGE: "范围未覆盖",
  PRECONDITION: "前置条件不满足",
  EXECUTION: "执行异常或受阻",
  CANCELLED: "已取消",
  TIMEOUT: "执行超时",
};
export const releaseLabels = {
  RECOMMENDED: "建议进入上线流程",
  NEEDS_VALIDATION: "补充验证后再上线",
  NOT_RECOMMENDED: "建议暂缓上线",
  SCOPED_ONLY: "本次范围通过，需结合整体验证",
  PENDING: "执行中，暂不建议上线",
};
export const reportAssessment = (report: TaskAcceptanceReport) =>
  report.assessment ?? assessAcceptance(report);

export function requirementResultReason(
  report: TaskAcceptanceReport,
  requirement: TaskAcceptanceReport["requirements"][number],
) {
  if (requirement.reason) return requirement.reason;
  const checks = report.cases
    .flatMap((c) => c.criteria)
    .filter((k) => k.required && k.requirementId === requirement.id);
  const failed = checks.filter((k) => k.verdict === "FAILED").length;
  const unknown = checks.filter((k) => k.verdict === "INCONCLUSIVE").length;
  const pending = checks.filter((k) => k.verdict === "PENDING").length;
  return (
    [
      failed ? `${failed} 项不符合需求` : "",
      unknown ? `${unknown} 项待补充验证` : "",
      pending ? `${pending} 项待完成` : "",
    ]
      .filter(Boolean)
      .join("；") || null
  );
}

export function acceptanceTitle(report: TaskAcceptanceReport) {
  if (!report.final) return "AI 验收进行中";
  if (report.aiAccepted) return "AI 验收通过";
  if (report.verdict === "PASSED") return "本次范围验收通过";
  return report.verdict === "FAILED" ? "AI 验收未通过" : "AI 验收待补充验证";
}
const md = (text: string | number | null) =>
  String(text ?? "—")
    .replace(/[\r\n]+/gu, " ")
    .replace(/[\\`*_[\]{}<>#|!]/gu, "\\$&");
function link(label: string, path: string, origin: string) {
  try {
    const url = new URL(path, origin);
    if (!["http:", "https:"].includes(url.protocol)) return md(label);
    return `[${md(label)}](${url.href.replaceAll("(", "%28").replaceAll(")", "%29")})`;
  } catch {
    return md(label);
  }
}

export function taskAcceptanceMarkdown(
  report: TaskAcceptanceReport,
  origin: string,
): string {
  const assessment = reportAssessment(report);
  const lines = [
    `# ${md(report.title)} · AI 验收报告`,
    "",
    `**${acceptanceTitle(report)}**`,
    "",
    report.summary,
    "",
    `- 任务：${link(report.taskId, `/console/runs/${report.taskId}?view=report`, origin)}`,
    `- 范围：${report.scope === "REQUIREMENT" ? "整个需求" : report.scope === "CASE" ? "单独 Case 重跑" : "直接任务指定范围"}`,
    `- 报告：${report.final ? "已结束执行的结果快照" : "执行中进度快照"} · 版本 ${report.version} · 修订 ${report.revision}`,
    `- 生成时间：${report.generatedAt}`,
    `- Spec：${md(report.specificationId)} · 来源版本：${md(report.sourceHash)}`,
    `- 来源：${md(report.sourceRef)}`,
    ...(report.pullRequestUrl
      ? [`- PR：${link(report.pullRequestUrl, report.pullRequestUrl, origin)}`]
      : []),
    "",
    "## 评分与上线建议",
    "",
    `- ${report.final ? "证据评分" : "当前进度评分"}：**${assessment.score === null ? "暂不评分" : `${assessment.score}/100`}**（计分验收点通过 ${assessment.passed}/${assessment.total}；环境受阻不计分 ${assessment.excluded ?? 0}）`,
    `- 上线建议：**${releaseLabels[assessment.recommendation]}**`,
    `- ${md(assessment.reason)}`,
    "- 评分口径：通过的必需验收点 ÷ 参与评分的必需验收点，向下取整；有明确环境或前置条件阻塞的未验证项排除评分，仅保留提示。已确认的通过和失败仍计分，其他未知项保留在分母，补充检查不影响分数。全部必需项被排除时暂不评分，排除项恢复条件后仍需补验。分数不是上线成功概率。",
    ...(assessment.exclusions?.length
      ? [
          "",
          "## 环境与前置条件提示 · 不参与评分",
          "",
          ...assessment.exclusions.map(
            (e) =>
              `- **${md(e.caseName)} · ${md(e.deployment)}**：${md(e.reason)} 下一步：${md(e.nextStep)}${e.runId ? ` ${link("查看执行记录", `/console/executions/${e.runId}`, origin)}` : ""}`,
          ),
        ]
      : []),
    ...(report.review?.status === "COMPLETED"
      ? [
          "",
          "### AI 综合评述",
          "",
          md(report.review.summary),
          "",
          md(report.review.releaseReason),
          "",
          `评述模型：${md(report.review.model)} · ${md(report.review.generatedAt)}`,
        ]
      : [
          "",
          `AI 评述：${report.review?.status === "FAILED" ? "暂时不可用，已保留证据评分。" : report.final ? "待生成，当前建议基于已保存的判定规则。" : "全部用例结束后生成。"}`,
        ]),
    "",
    ...(report.cases.some((c) => c.cleanup)
      ? [
          "## 后续收尾提醒",
          "",
          "以下事项不影响验证结果，可后续核对处理。",
          ...report.cases
            .filter((c) => c.cleanup)
            .map(
              (c) =>
                `- ${md(c.name)}：${md(c.cleanup!.note.replace(/^清理未完成[：:][；;]?\s*/u, ""))}`,
            ),
          "",
        ]
      : []),
    "## 结果概览",
    "",
    "| 范围 | 总数 | 通过 | 未通过 | 无法判定 | 待完成 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...(
      [
        ["Case × 环境", report.counts.cases],
        ["验收点", report.counts.criteria],
      ] as const
    ).map(
      ([name, count]) =>
        `| ${name} | ${count.total} | ${count.PASSED} | ${count.FAILED} | ${count.INCONCLUSIVE} | ${count.PENDING} |`,
    ),
    "",
    `必需验收点：${report.counts.criteria.required}。通过率只描述已定义范围，不替代需求覆盖判断。`,
    "",
    "## 产品偏差与待验证风险",
    "",
    ...assessment.findings.flatMap((f, index) => {
      const review = report.review?.focusAreas.find(
        (a) => a.criterionKey === f.key,
      );
      return [
        `### ${index + 1}. ${f.kind === "PRODUCT" ? "已确认产品偏差" : "待验证风险"} · ${md(f.caseName)}`,
        "",
        `- 需求：${md(f.requirement)}`,
        `- 预期：${md(f.expected)}`,
        `- 实际观察：${md(f.observed)}`,
        ...(review ? [`- AI 影响评估：${md(review.impact)}`] : []),
        `- 下一步：${md(review?.nextStep ?? f.nextStep)}`,
        `- 证据：${f.evidence.map((e) => (e.downloadPath ? link(e.kind, e.downloadPath, origin) : md(e.ref))).join("；") || "尚无对应证据"}`,
        "",
      ];
    }),
    ...(assessment.findings.length
      ? []
      : [
          assessment.exclusions?.length
            ? "当前没有已确认的产品偏差；环境受阻项见上方提示，恢复条件后补验。"
            : "当前没有已确认的产品偏差或待确认验收点。",
          "",
        ]),
    "## 需求覆盖",
    "",
    "| 需求 | 判定 | 关联 Case 数 | 未覆盖原因 |",
    "| --- | --- | ---: | --- |",
    ...report.requirements.map(
      (r) =>
        `| ${md(r.description)} | ${acceptanceLabels[r.verdict]} | ${r.caseIds.length} | ${md(requirementResultReason(report, r))} |`,
    ),
    ...(report.requirements.length ? [] : ["当前没有结构化的需求映射。"]),
    "",
    "## 阻塞与待处理事项",
    "",
    ...report.issues.map(
      (i) =>
        `- **${acceptanceIssueLabels[i.category]}**（${md(i.code)}）：${md(i.message)} 下一步：${md(i.nextStep)}`,
    ),
    ...(report.issues.length
      ? []
      : ["任务层面无额外阻塞；各 Case 的发现与证据如下。"]),
    "",
    "## Case 结果与证据",
    "",
  ];
  report.cases.forEach((c, index) => {
    lines.push(
      `### ${index + 1}. ${md(c.name)} · ${md(c.deployment)}`,
      "",
      `判定：**${acceptanceLabels[c.verdict]}** · 执行状态：${md(c.lifecycle)} / ${md(c.executionDisposition)} · 批次 ${c.executionOrdinal} · 尝试 ${c.attemptNumber ?? "—"}`,
      "",
      `环境：${c.targetUrl ? link(c.targetUrl, c.targetUrl, origin) : "未指定"}`,
      "",
      ...(c.runId
        ? [
            `执行记录：${link(c.runId, `/console/executions/${c.runId}`, origin)}`,
            "",
          ]
        : []),
      ...c.issues.map(
        (i) =>
          `- ${acceptanceIssueLabels[i.category]}（${md(i.code)}）：${md(i.message)} 下一步：${md(i.nextStep)}`,
      ),
      "",
      "| 验收标准 | 必需 | 判定 | 实际观察与原因 | 证据 |",
      "| --- | --- | --- | --- | --- |",
      ...c.criteria.map(
        (k) =>
          `| ${md(k.description)} | ${k.required ? "是" : "否"} | ${criterionScoringExclusion(c, k) ? "环境或前置条件受阻 · 不计分" : acceptanceLabels[k.verdict]} | ${md(k.summary)}${k.issues
            .filter((i) => i.category !== "PRODUCT")
            .map((i) => `；${md(i.message)}`)
            .join(
              "",
            )} | ${k.evidence.map((e) => (e.downloadPath ? link(e.kind, e.downloadPath, origin) : md(`${e.kind}: ${e.ref}`))).join("；") || "未取得"} |`,
      ),
      "",
    );
  });
  lines.push(
    "## 判定规则",
    "",
    "只有完整需求范围、全部必需验收点和对应证据均满足要求时，才授予“AI 验收通过”。产品问题与证据不足、账号或环境问题、执行中断分别记录；取消、超时、未执行不计为通过。报告仅使用最新 Case 批次及当前执行尝试，不合并旧尝试的通过结果。",
    "",
    "本报告由已保存的规格、判定和证据引用生成，评分由固定规则计算；AI 评述单独标注模型和生成时间，不改写已保存的验收判定。报告不代表发布批准；后续重跑或证据保留状态变化会生成不同修订。",
    "",
  );
  return lines.join("\n");
}
