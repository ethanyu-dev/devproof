"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Download, FileCheck2, RefreshCw } from "lucide-react";
import type {
  TaskAcceptanceReport,
  AcceptanceVerdict,
} from "@devproof/contracts";
import { consoleApi } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/settings-layout";
import { displayLabel } from "@/lib/display-text";
import {
  acceptanceIssueLabels,
  acceptanceLabels,
  acceptanceTitle,
  reportAssessment,
  requirementResultReason,
  releaseLabels,
  taskAcceptanceMarkdown,
} from "./task-acceptance-markdown";
import styles from "./task-acceptance-report.module.css";
import { CleanupReminder } from "./cleanup-reminder";

const tone = (v: AcceptanceVerdict) =>
  v === "PASSED"
    ? "success"
    : v === "FAILED"
      ? "danger"
      : v === "PENDING"
        ? "info"
        : "warning";
export function TaskAcceptanceReportView({
  id,
  updatedAt,
}: {
  id: string;
  updatedAt: string;
}) {
  const [report, setReport] = useState<TaskAcceptanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void consoleApi<TaskAcceptanceReport>(`/tasks/${id}/acceptance-report`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setReport(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      });
    return () => controller.abort();
  }, [id, updatedAt, refresh]);
  useEffect(() => {
    if (
      !report?.final ||
      !["QUEUED", "RUNNING"].includes(report.review?.status ?? "")
    )
      return;
    const timer = window.setTimeout(() => setRefresh((r) => r + 1), 10_000);
    return () => window.clearTimeout(timer);
  }, [report]);
  if (error)
    return (
      <ErrorState message={error} onRetry={() => setRefresh((r) => r + 1)} />
    );
  if (!report || report.taskId !== id) return <LoadingState />;
  return (
    <TaskAcceptanceReportContent
      report={report}
      onRefresh={() => setRefresh((r) => r + 1)}
    />
  );
}

export function TaskAcceptanceReportContent({
  report,
  onRefresh,
}: {
  report: TaskAcceptanceReport;
  onRefresh?: () => void;
}) {
  const id = report.taskId;
  const assessment = reportAssessment(report);
  const cleanupCount = report.cases.filter((c) => c.cleanup).length;
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([taskAcceptanceMarkdown(report, window.location.origin)], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `devproof-acceptance-${report.taskId}-${report.revision}.md`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const allIssues = [
    ...report.issues,
    ...report.cases.flatMap((c) =>
      c.issues.map((i) => ({
        ...i,
        message: `${c.name} · ${c.deployment}：${i.message}`,
      })),
    ),
  ];
  return (
    <div className={styles.report}>
      <Card className={styles.hero}>
        <div className={styles.heading}>
          <div>
            <div className={styles.eyebrow}>
              <FileCheck2 size={16} /> AI 验收报告 ·{" "}
              {report.final ? "执行已结束" : "进度快照"}
            </div>
            <h2>{acceptanceTitle(report)}</h2>
          </div>
          <div className={styles.actions}>
            <Button variant="ghost" onClick={onRefresh}>
              <RefreshCw /> 刷新报告
            </Button>
            <Button variant="secondary" onClick={download}>
              <Download /> 导出 Markdown
            </Button>
          </div>
        </div>
        <div className={styles.assessment}>
          <div className={styles.score}>
            <span>{report.final ? "证据评分" : "当前进度评分"}</span>
            <div>
              <strong>{assessment.score ?? "—"}</strong>
              <span>/ 100</span>
            </div>
            <span>
              必需验收点通过 {assessment.passed}/{assessment.total}
            </span>
          </div>
          <div className={styles.recommendation}>
            <Badge
              tone={
                assessment.recommendation === "RECOMMENDED"
                  ? "success"
                  : assessment.recommendation === "NOT_RECOMMENDED"
                    ? "danger"
                    : "warning"
              }
            >
              {releaseLabels[assessment.recommendation]}
            </Badge>
            <p>{assessment.reason}</p>
            <div
              className={styles.scoreBar}
              role="img"
              aria-label={`必需验收点：通过 ${assessment.passed}，未通过 ${assessment.failed}，待确认 ${assessment.unknown + assessment.pending}`}
            >
              {assessment.total > 0 && (
                <>
                  <span
                    className={styles.passed}
                    style={{
                      width: `${(assessment.passed / assessment.total) * 100}%`,
                    }}
                  />
                  <span
                    className={styles.failed}
                    style={{
                      width: `${(assessment.failed / assessment.total) * 100}%`,
                    }}
                  />
                </>
              )}
            </div>
            <small>
              通过 {assessment.passed} · 产品问题 {assessment.failed} · 待确认{" "}
              {assessment.unknown + assessment.pending}
            </small>
          </div>
        </div>
        {cleanupCount > 0 && (
          <p className={styles.caption}>
            {cleanupCount} 个用例有后续收尾事项，不影响验证结果。详情见下方 Case
            记录。
          </p>
        )}
        <details className={styles.scoringRules}>
          <summary>评分与验收规则</summary>
          <p>
            分数 = 有完整证据的通过项 ÷ 全部必需验收点 ×
            100，向下取整。受阻用例中已通过的验收点仍计分；未知项保留在分母，补充检查不参与评分。该分数表示已验证的程度，不代表上线成功概率。必需项存在产品问题时暂缓上线；存在验证缺口时补验后再决定。
          </p>
        </details>
        <div className={styles.aiReview}>
          <strong>AI 综合评述</strong>
          {report.review?.status === "COMPLETED" ? (
            <>
              <p>{report.review.summary}</p>
              <p>{report.review.releaseReason}</p>
              <small>
                {report.review.model} ·{" "}
                {report.review.generatedAt
                  ? new Date(report.review.generatedAt).toLocaleString(
                      "zh-CN",
                      { hour12: false },
                    )
                  : ""}
              </small>
            </>
          ) : (
            <p>
              {!report.final
                ? "全部用例结束后，AI 将综合解释已验证能力、产品偏差和剩余风险。"
                : report.review?.status === "FAILED"
                  ? (report.review.error ??
                    "AI 评述暂时不可用，证据评分和原始结果已保留。")
                  : report.review?.status === "RUNNING"
                    ? "AI 正在综合分析需求和验收结果，完成后自动更新。"
                    : "AI 评述等待分析 Runtime 处理；当前分数与上线建议已根据证据生成。"}
            </p>
          )}
        </div>
        <div className={styles.meta}>
          <Badge tone={tone(report.verdict)}>
            {acceptanceLabels[report.verdict]}
          </Badge>
          <span>
            {report.scope === "REQUIREMENT"
              ? "整个需求"
              : report.scope === "CASE"
                ? "单独 Case 重跑"
                : "直接任务范围"}
          </span>
          <span>
            {report.coverageComplete ? "范围覆盖完整" : "范围覆盖待补齐"}
          </span>
          <span>修订 {report.revision}</span>
        </div>
        <div className={styles.metrics}>
          {(
            [
              ["通过", report.counts.cases.PASSED],
              ["未通过", report.counts.cases.FAILED],
              ["无法判定", report.counts.cases.INCONCLUSIVE],
              ["待完成", report.counts.cases.PENDING],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <p className={styles.caption}>
          共 {report.counts.cases.total} 个 Case × 环境执行项，
          {report.counts.criteria.required}{" "}
          个必需验收点。以最新批次、当前尝试的结果为准；进度完成率不等于验收通过率。
        </p>
      </Card>
      {assessment.findings.length > 0 && (
        <Card className={styles.section}>
          <h3>产品偏差与待验证风险 · {assessment.findings.length}</h3>
          <div className={styles.findings}>
            {assessment.findings.map((f) => {
              const focus = report.review?.focusAreas.find(
                (a) => a.criterionKey === f.key,
              );
              return (
                <article key={f.key} className={styles.finding}>
                  <div className={styles.findingHeading}>
                    <Badge tone={f.kind === "PRODUCT" ? "danger" : "warning"}>
                      {f.kind === "PRODUCT" ? "已确认产品偏差" : "待验证风险"}
                    </Badge>
                    <strong>{f.caseName}</strong>
                    {!f.required && <small>补充检查</small>}
                  </div>
                  <dl>
                    <div>
                      <dt>关联需求</dt>
                      <dd>{f.requirement}</dd>
                    </div>
                    <div>
                      <dt>验收预期</dt>
                      <dd>{f.expected}</dd>
                    </div>
                    <div>
                      <dt>实际观察</dt>
                      <dd>{f.observed}</dd>
                    </div>
                    {focus && (
                      <div>
                        <dt>AI 影响评估</dt>
                        <dd>{focus.impact}</dd>
                      </div>
                    )}
                    <div>
                      <dt>下一步</dt>
                      <dd>{focus?.nextStep ?? f.nextStep}</dd>
                    </div>
                  </dl>
                  <div className={styles.evidence}>
                    {f.runId && (
                      <Link
                        href={`/console/executions/${f.runId}?${new URLSearchParams({ returnTo: `/console/runs/${id}?view=report` })}`}
                      >
                        查看执行记录
                      </Link>
                    )}
                    {f.evidence.map((e) =>
                      e.downloadPath ? (
                        <a
                          key={e.id}
                          href={e.downloadPath}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {e.kind} 证据 ↗
                        </a>
                      ) : (
                        <span key={e.id}>
                          {e.kind} · {e.ref}
                        </span>
                      ),
                    )}
                    {!f.evidence.length && (
                      <span>尚无对应证据，不能据此认定产品存在缺陷</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </Card>
      )}
      <Card className={styles.section}>
        <h3>需求覆盖</h3>
        {report.requirements.length ? (
          <div className={styles.tableScroll}>
            <table>
              <thead>
                <tr>
                  <th>需求</th>
                  <th>验收判定</th>
                  <th>关联 Case</th>
                  <th>缺口</th>
                </tr>
              </thead>
              <tbody>
                {report.requirements.map((r) => (
                  <tr key={r.id}>
                    <td>{r.description}</td>
                    <td>
                      <Badge tone={tone(r.verdict)}>
                        {acceptanceLabels[r.verdict]}
                      </Badge>
                    </td>
                    <td>{r.caseIds.length}</td>
                    <td>{requirementResultReason(report, r) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>
            当前规格没有结构化的需求映射，不能由 Case 通过率推断整个需求已通过。
          </p>
        )}
      </Card>
      {allIssues.length > 0 && (
        <Card className={styles.section}>
          <details className={styles.diagnostics}>
            <summary>执行诊断与补充信息 · {allIssues.length}</summary>
            <ul className={styles.issues}>
              {allIssues.map((i, n) => (
                <li key={`${i.code}-${n}`}>
                  <strong>{acceptanceIssueLabels[i.category]}</strong>
                  <span>{i.message}</span>
                  <small>
                    {i.nextStep} <code>{i.code}</code>
                  </small>
                </li>
              ))}
            </ul>
          </details>
        </Card>
      )}
      <Card className={styles.section}>
        <h3>Case 结果与证据</h3>
        {report.cases.map((c, index) => (
          <details
            className={styles.case}
            key={`${c.caseId}:${c.deployment}:${index}`}
          >
            <summary>
              <span>
                {c.name} · {c.deployment}
              </span>
              <Badge tone={tone(c.verdict)}>
                {acceptanceLabels[c.verdict]}
              </Badge>
            </summary>
            <div className={styles.caseBody}>
              <p className={styles.caption}>
                {c.targetUrl ?? "未指定环境"} · 批次 {c.executionOrdinal} · 尝试{" "}
                {c.attemptNumber ?? "—"} · {displayLabel(c.lifecycle)}
                {c.executionDisposition
                  ? ` / ${displayLabel(c.executionDisposition)}`
                  : ""}
                {c.runId && (
                  <>
                    {" "}
                    ·{" "}
                    <Link
                      href={`/console/executions/${c.runId}?${new URLSearchParams({ returnTo: `/console/runs/${id}` })}`}
                    >
                      查看执行记录
                    </Link>
                  </>
                )}
              </p>
              {c.cleanup && <CleanupReminder note={c.cleanup.note} />}
              {c.criteria.map((k) => (
                <div className={styles.criterion} key={k.id}>
                  <div>
                    <Badge tone={tone(k.verdict)}>
                      {acceptanceLabels[k.verdict]}
                    </Badge>
                    <strong>{k.description}</strong>
                    {!k.required && <small>补充检查</small>}
                  </div>
                  <p>{k.summary}</p>
                  {k.issues
                    .filter((i) => i.category !== "PRODUCT")
                    .map((i) => (
                      <p className={styles.caption} key={i.code}>
                        {acceptanceIssueLabels[i.category]}：{i.message}
                      </p>
                    ))}
                  <div className={styles.evidence}>
                    {k.evidence.length ? (
                      k.evidence.map((e) =>
                        e.downloadPath ? (
                          <a
                            key={e.id}
                            href={e.downloadPath}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {e.kind} 证据 ↗
                          </a>
                        ) : (
                          <span key={e.id}>
                            {e.kind} · {e.ref}
                          </span>
                        ),
                      )
                    ) : (
                      <span>当前尝试尚无对应证据</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ))}
      </Card>
      <p className={styles.caption}>
        证据评分根据已保存的 Spec、验收结果和证据引用计算，AI 评述单独标注。Spec{" "}
        {report.specificationId ?? "未生成"} ·{" "}
        {new Date(report.generatedAt).toLocaleString("zh-CN", {
          hour12: false,
        })}
        。单个 Case 的通过结论不等于整个需求通过，AI 验收结论也不等于发布批准。
      </p>
    </div>
  );
}
