"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { TaskActivity, TokenMetric } from "@devproof/contracts";
import { consoleApi } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/settings-layout";
import styles from "./task-metrics.module.css";
import {
  createTaskMetricsLoader,
  initialMetricsState,
} from "./task-metrics-loader";

const labels: Record<TaskActivity, string> = {
  MODEL: "模型调用",
  TOOL: "工具执行",
  PLATFORM: "平台处理",
  RECOVERY: "恢复处理",
  QUEUE: "排队 / 资源等待",
  HUMAN: "人工 / 输入等待",
  DEPENDENCY: "依赖等待",
  BACKOFF: "重试等待",
  PARALLEL: "并行执行",
  MIXED_WAIT: "混合等待",
  UNKNOWN: "未能归因",
};
const colors: Record<TaskActivity, string> = {
  MODEL: "#4f46e5",
  TOOL: "#0891b2",
  PLATFORM: "#059669",
  RECOVERY: "#7c3aed",
  QUEUE: "#d97706",
  HUMAN: "#db2777",
  DEPENDENCY: "#a16207",
  BACKOFF: "#c2410c",
  PARALLEL: "#2563eb",
  MIXED_WAIT: "#9333ea",
  UNKNOWN: "#94a3b8",
};
const phases: Record<string, string> = {
  SPEC_ANALYSIS: "Spec 分析",
  PROFILE_RESOLUTION: "身份准备",
  SPEC_EXECUTION: "用例执行",
  ACCEPTANCE_REVIEW: "AI 验收评述",
};
const statuses: Record<string, string> = {
  RUNNING: "执行中",
  SUCCEEDED: "成功",
  FAILED: "失败",
  INTERRUPTED: "已中断",
  QUEUED: "排队中",
  COMPLETED: "已完成",
};
export function metricDuration(ms: number | null) {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? `${seconds} 秒`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
      : `${Math.floor(seconds / 3600)} 时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
function count(value: string | null) {
  return value === null ? "未上报" : BigInt(value).toLocaleString("zh-CN");
}
export function metricTokens(metric: TokenMetric) {
  return count(metric.known);
}
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
export function TaskMetricsView({ id }: { id: string }) {
  const [state, setState] = useState(initialMetricsState);
  const [scope, setScope] = useState("ALL");
  const loader = useRef<ReturnType<typeof createTaskMetricsLoader> | null>(
    null,
  );
  useEffect(() => {
    const session = createTaskMetricsLoader(id, consoleApi, setState);
    loader.current = session;
    setState(initialMetricsState);
    void session.refresh();
    return () => {
      session.dispose();
      loader.current = null;
    };
  }, [id]);
  const refresh = () => void loader.current?.refresh();
  const more = (kind: "model-calls" | "timeline") => loader.current?.more(kind);
  const { metrics, error, calls, spans, loadingMore, detailError } = state;
  if (!metrics)
    return error ? (
      <ErrorState message={error} onRetry={refresh} />
    ) : (
      <LoadingState />
    );
  const models = metrics.models.filter(
    (m) => scope === "ALL" || m.scope === scope,
  );
  const sortedSpans = [...(spans?.items ?? [])].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  const first = sortedSpans.length
    ? Math.min(...sortedSpans.map((s) => Date.parse(s.startedAt)))
    : 0;
  const last = sortedSpans.length
    ? Math.max(
        ...sortedSpans.map((s) => Date.parse(s.finishedAt ?? metrics.asOf)),
      )
    : first + 1;
  return (
    <div className={styles.root}>
      <div className={styles.heading}>
        <div>
          <h2>消耗与耗时</h2>
          <p>
            统计截至 {time(metrics.asOf)}
            {metrics.refreshPending ? " · 正在更新" : ""}
          </p>
        </div>
        <Button variant="secondary" onClick={refresh}>
          刷新明细
        </Button>
      </div>
      {error && <p role="alert">{error}，当前展示上次成功读取的数据。</p>}
      <div className={styles.cards}>
        {[
          ["任务总耗时", metricDuration(metrics.elapsedMs)],
          ["执行活动时间", metricDuration(metrics.activeMs)],
          ["无执行活动时的等待", metricDuration(metrics.waitingMs)],
          ["累计 Token", metricTokens(metrics.totals.total)],
        ].map(([label, value]) => (
          <Card key={label} className={styles.stat}>
            <span>{label}</span>
            <strong>{value}</strong>
          </Card>
        ))}
      </div>
      <Card className={styles.panel}>
        <h3>任务内部耗时占比</h3>
        <p>
          按实际经过时间去重。不同活动同时进行计入“并行执行”；未能归因的时间单独保留。
          {metrics.timingQuality !== "ESTIMATED"
            ? "当前时间记录不完整。"
            : "运行节点时间采用估计对齐。"}
        </p>
        <div
          className={styles.bar}
          role="img"
          aria-label={metrics.buckets
            .map((b) => `${labels[b.activity]} ${b.percentage ?? 0}%`)
            .join("，")}
        >
          {metrics.buckets.map((b) => (
            <div
              key={b.activity}
              style={{
                width: `${b.percentage ?? 0}%`,
                background: colors[b.activity],
              }}
              title={`${labels[b.activity]}：${metricDuration(b.durationMs)}（${b.percentage ?? "—"}%）`}
            />
          ))}
        </div>
        <div className={styles.legend}>
          {metrics.buckets.map((b) => (
            <div key={b.activity}>
              <i style={{ background: colors[b.activity] }} />
              <span>{labels[b.activity]}</span>
              <b>{metricDuration(b.durationMs)}</b>
              <span>{b.percentage === null ? "—" : `${b.percentage}%`}</span>
            </div>
          ))}
        </div>
        <div className={styles.phases}>
          {metrics.phases.map((p) => (
            <div key={p.phase}>
              <b>{phases[p.phase] ?? p.phase}</b>
              <span>
                {p.status === "SKIPPED"
                  ? "已跳过"
                  : `${time(p.startedAt)} → ${p.finishedAt ? time(p.finishedAt) : "尚未结束"}`}
              </span>
            </div>
          ))}
        </div>
      </Card>
      <Card className={styles.panel}>
        <div className={styles.heading}>
          <h3>各模型 Token 消耗</h3>
          <label>
            调用范围{" "}
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="ALL">全部</option>
              <option value="EXECUTION">任务执行</option>
              <option value="ACCEPTANCE_REVIEW">AI 验收评述</option>
            </select>
          </label>
        </div>
        <p>
          Input 已包含缓存命中；总量 = Input +
          Output。累计调用耗时允许重叠，不用于上方的耗时占比。
        </p>
        <div className={styles.scroll}>
          <table>
            <thead>
              <tr>
                <th>模型 / 配置</th>
                <th>请求</th>
                <th>Input</th>
                <th>Output</th>
                <th>其中缓存命中</th>
                <th>缓存命中率</th>
                <th>累计调用耗时</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.key}>
                  <td>
                    <b>{m.model}</b>
                    <small>
                      {m.configurationName ?? "历史配置未知"} ·{" "}
                      {m.scope === "ACCEPTANCE_REVIEW" ? "AI 评述" : "任务执行"}
                    </small>
                  </td>
                  <td>
                    {m.calls}
                    <small>
                      失败 {m.failedCalls} · 中断 {m.interruptedCalls}
                      {m.runningCalls ? ` · 执行中 ${m.runningCalls}` : ""}
                    </small>
                  </td>
                  <td>{metricTokens(m.input)}</td>
                  <td>{metricTokens(m.output)}</td>
                  <td>{metricTokens(m.cacheRead)}</td>
                  <td>
                    {m.cacheHitRate === null
                      ? "—"
                      : `${m.cacheHitRate.toFixed(1)}%`}
                    <small>
                      覆盖 {m.cacheCoveredCalls}/{m.calls} 次
                    </small>
                  </td>
                  <td>{metricDuration(m.requestDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!models.length && <p>暂无该范围的模型调用记录。</p>}
        <p>
          AI 验收评述：
          {metrics.reviewStatus
            ? (statuses[metrics.reviewStatus] ?? metrics.reviewStatus)
            : "尚无评述"}{" "}
          · 累计模型调用 {metricDuration(metrics.reviewDurationMs)}。评述 Token
          计入累计消耗，任务完成耗时保持不变。
        </p>
      </Card>
      <Card className={styles.panel}>
        <h3>调用明细</h3>
        <p>包含自动重试与模型回退。未上报不代表消耗为零。</p>
        <div className={styles.scroll}>
          <table>
            <thead>
              <tr>
                <th>时间 / 阶段</th>
                <th>模型</th>
                <th>状态</th>
                <th>Input / Output / Cache</th>
                <th>耗时</th>
                <th>上下文</th>
              </tr>
            </thead>
            <tbody>
              {calls?.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    {time(c.startedAt)}
                    <small>
                      {phases[c.stage] ?? c.stage} · 第 {c.attemptNumber ?? "—"}{" "}
                      次执行
                    </small>
                  </td>
                  <td>{c.model}</td>
                  <td>
                    {statuses[c.outcome] ?? c.outcome}
                    {c.issues.length > 0 && <small>用量字段待核对</small>}
                  </td>
                  <td>
                    {count(c.inputTokens)} / {count(c.outputTokens)} /{" "}
                    {count(c.cacheReadTokens)}
                  </td>
                  <td>{metricDuration(c.durationMs)}</td>
                  <td>
                    {c.runId && c.attemptNumber ? (
                      <Link
                        href={`/console/execution-contexts/${c.runId}/${c.attemptNumber}`}
                      >
                        查看
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {calls?.nextCursor && (
          <Button
            disabled={loadingMore}
            variant="secondary"
            onClick={() => void more("model-calls")}
          >
            加载更多调用
          </Button>
        )}
      </Card>
      <Card className={styles.panel}>
        <h3>执行时间线</h3>
        <p>按已加载区间显示，悬停查看时间。开放区间仅表示尚未收到结束记录。</p>
        <div className={styles.timeline}>
          {sortedSpans.map((s) => (
            <div key={s.id} className={styles.timelineRow}>
              <span title={s.lane}>
                {labels[s.activity]} · {s.label}
              </span>
              <div className={styles.track}>
                <i
                  title={`${time(s.startedAt)} → ${time(s.finishedAt)}${s.estimated ? "（估计）" : ""}`}
                  style={{
                    left: `${((Date.parse(s.startedAt) - first) / Math.max(1, last - first)) * 100}%`,
                    width: `${Math.max(0.3, ((Date.parse(s.finishedAt ?? metrics.asOf) - Date.parse(s.startedAt)) / Math.max(1, last - first)) * 100)}%`,
                    background: colors[s.activity],
                    opacity: s.finishedAt ? 1 : 0.45,
                  }}
                />
              </div>
              <small>
                {s.finishedAt
                  ? metricDuration(
                      Date.parse(s.finishedAt) - Date.parse(s.startedAt),
                    )
                  : "待结束"}
              </small>
            </div>
          ))}
        </div>
        {spans?.nextCursor && (
          <Button
            disabled={loadingMore}
            variant="secondary"
            onClick={() => void more("timeline")}
          >
            加载更多区间
          </Button>
        )}
      </Card>
      {detailError && (
        <p role="alert">
          {detailError}{" "}
          <Button onClick={refresh} variant="secondary">
            重试明细
          </Button>
        </p>
      )}
    </div>
  );
}
