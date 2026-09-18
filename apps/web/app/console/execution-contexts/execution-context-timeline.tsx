"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  Download,
  RefreshCw,
  Search,
  ArrowUpRight,
  FileJson,
} from "lucide-react";
import {
  STEP_CONTEXT_SECTIONS,
  type ExecutionContextDetail,
  type StepContextCall,
  type StepContextContent,
} from "@devproof/contracts";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { consoleApi } from "@/lib/api";
import {
  attemptHref,
  bytesLabel,
  statusLabel,
  timestamp,
} from "./context-display";
import styles from "./step-context.module.css";
import { ContextBlocks, ContextContentView } from "./context-blocks";
import { ValueView } from "./context-value";

export function ExecutionContextTimeline({
  runId,
  attempt,
}: {
  runId: string;
  attempt: string;
}) {
  const [data, setData] = useState<ExecutionContextDetail | null>(null),
    [error, setError] = useState("");
  const [query, setQuery] = useState(""),
    [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const base = `/execution-contexts/${encodeURIComponent(runId)}/${encodeURIComponent(attempt)}`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        setData(
          await consoleApi<ExecutionContextDetail>(
            base,
            signal ? { signal } : undefined,
          ),
        );
        setRevision((n) => n + 1);
      } catch (e) {
        if (!signal?.aborted)
          setError(e instanceof Error ? e.message : "读取失败");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [base],
  );
  useEffect(() => {
    setData(null);
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);
  const steps =
    data?.steps.filter((s) =>
      `${s.number} ${s.calls.map((c) => `${c.intent ?? ""} ${c.model} ${c.toolNames.join(" ")}`).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <div className={styles.page}>
      <Link href="/console/execution-contexts" className={styles.back}>
        <ArrowLeft size={15} />
        全部执行记录
      </Link>
      <PageHeader
        title="Step Context"
        description={data?.attempt.goal.split("\n")[0] ?? "执行上下文详情"}
        actions={
          <>
            <Link
              className={styles.textLink}
              href={`/console/executions/${runId}`}
            >
              验证报告
              <ArrowUpRight size={14} />
            </Link>
            <Button
              variant="secondary"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw />
              刷新
            </Button>
          </>
        }
      />
      {error && (
        <div role="alert" className={styles.warning}>
          {error}
        </div>
      )}
      {!data ? (
        <div className={styles.empty}>
          {loading ? "正在读取步骤…" : "暂无数据"}
        </div>
      ) : (
        <>
          <div className={styles.summary}>
            <div>
              <span className={styles.eyebrow}>EXECUTION / ATTEMPT</span>
              <code>{data.attempt.id}</code>
              <span className={styles.muted}>
                {timestamp(data.attempt.createdAt)} ·{" "}
                {data.attempt.executionOrdinal
                  ? `用例第 ${data.attempt.executionOrdinal} 次执行 · `
                  : ""}
                尝试 {data.attempt.attemptNumber}
              </span>
            </div>
            <div className={styles.summaryStats}>
              <span className={styles.status} data-status={data.attempt.status}>
                {statusLabel(data.attempt.status)}
              </span>
              <strong>
                {data.steps.length}
                <small>决策步骤</small>
              </strong>
              <strong>
                {data.attempt.capturedCalls}
                <small>完整输入</small>
              </strong>
            </div>
          </div>
          <details className={styles.history}>
            <summary>
              执行历史 <span>{data.relatedAttempts.length} 次尝试</span>
              <ChevronDown size={14} />
            </summary>
            <div className={styles.historyRows}>
              {data.relatedAttempts.map((row) => (
                <Link
                  key={row.attemptId}
                  className={
                    row.attemptId === data.attempt.attemptId
                      ? styles.historyCurrent
                      : ""
                  }
                  href={attemptHref(row.runId, row.attemptNumber)}
                >
                  <code>{row.id}</code>
                  <span>
                    用例执行 {row.executionOrdinal ?? "—"} / 尝试{" "}
                    {row.attemptNumber}
                  </span>
                  <span>{statusLabel(row.status)}</span>
                </Link>
              ))}
              {data.caseId && (
                <Link
                  className={styles.textLink}
                  href={`/console/execution-contexts?caseId=${data.caseId}`}
                >
                  搜索该用例的全部历史
                </Link>
              )}
            </div>
          </details>
          {!data.attempt.capturedCalls && (
            <div className={styles.notice}>
              这次执行发生在完整上下文采集启用之前，或尚未发起模型调用。历史步骤只展示当时保存的预览；未留存的原文、工具定义和行动计划无法补回。
            </div>
          )}
          <div className={styles.timelineToolbar}>
            <h2>
              决策时间线 <span>STEP 1 → {data.steps.length || "—"}</span>
            </h2>
            <label className={styles.search}>
              <Search size={15} />
              <input
                aria-label="搜索步骤或行动计划"
                placeholder="筛选步骤、行动计划或工具…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <div className={styles.timelineLayout}>
            <nav aria-label="步骤导航" className={styles.stepNav}>
              {steps.map((s) => (
                <a key={s.number} href={`#step-${s.number}`}>
                  <span>{String(s.number).padStart(2, "0")}</span>
                  <span>
                    {s.calls.at(-1)?.intent ||
                      s.calls.at(-1)?.toolNames.join("、") ||
                      "模型调用"}
                  </span>
                </a>
              ))}
            </nav>
            <div className={styles.timeline}>
              {steps.map((step) => (
                <StepCard
                  key={`${base}:${step.segmentId}:${step.localStep}`}
                  step={step}
                  base={base}
                  revision={revision}
                />
              ))}
              {!steps.length && (
                <div className={styles.empty}>
                  {query
                    ? "没有匹配的步骤"
                    : "模型开始执行后，步骤会显示在这里。"}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StepCard({
  step,
  base,
  revision,
}: {
  step: ExecutionContextDetail["steps"][number];
  base: string;
  revision: number;
}) {
  const [open, setOpen] = useState(false),
    [selectedCall, setSelectedCall] = useState<string | null>(null);
  const [content, setContent] = useState<StepContextContent | null>(null),
    [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const call =
    step.calls.find((c) => c.id === selectedCall) ?? step.calls.at(-1)!;
  useEffect(() => {
    setContent(null);
    setError("");
    if (!open) return;
    const c = new AbortController();
    consoleApi<StepContextContent>(`${base}/steps/${call.id}`, {
      signal: c.signal,
    })
      .then(setContent)
      .catch((e: Error) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [base, call.id, call.status, open, retry, revision]);
  const download = `/console/api${base}/steps/${call.id}/download`;
  return (
    <article id={`step-${step.number}`} className={styles.stepCard}>
      <button
        type="button"
        className={styles.stepHeader}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.stepNumber}>
          {String(step.number).padStart(2, "0")}
        </span>
        <div className={styles.stepTitle}>
          <div>
            <strong>Step {step.number}</strong>
            <CallStatus call={call} />
            <span
              className={call.hasFullContext ? styles.complete : styles.muted}
            >
              {call.hasFullContext ? "完整上下文" : "历史预览"}
            </span>
          </div>
          <p>{call.intent ?? "未记录行动计划"}</p>
          <small>
            {call.model} · {timestamp(call.startedAt)}
            {call.durationMs !== null &&
              ` · ${(call.durationMs / 1000).toFixed(1)} s`}
            {step.calls.length > 1 && ` · ${step.calls.length} 次模型请求`}
          </small>
        </div>
        <ChevronDown size={18} className={open ? styles.rotated : ""} />
      </button>
      {!open && (
        <div className={styles.collapsedSections}>
          {STEP_CONTEXT_SECTIONS.map(([key, label]) => (
            <span key={key}>{label}</span>
          ))}
        </div>
      )}
      {open && (
        <div className={styles.stepBody}>
          <div className={styles.callBar}>
            <span title={step.segmentId}>
              执行段 {step.segmentId.split(":").at(-1)} · 段内 Step{" "}
              {step.localStep}
            </span>
            {step.calls.length > 1 && (
              <select
                aria-label={`Step ${step.number} 模型请求`}
                value={call.id}
                onChange={(e) => setSelectedCall(e.target.value)}
              >
                {step.calls.map((c, i) => (
                  <option key={c.id} value={c.id}>
                    请求 {i + 1} · {c.model} · {statusLabel(c.status)}
                  </option>
                ))}
              </select>
            )}
            <a href={download} className={styles.textLink}>
              <Download size={14} />
              下载留存原文
            </a>
          </div>
          {error ? (
            <div className={styles.warning}>
              {error}
              <Button
                variant="secondary"
                onClick={() => setRetry((n) => n + 1)}
              >
                重新加载
              </Button>
            </div>
          ) : !content ? (
            <div className={styles.empty}>加载本轮上下文…</div>
          ) : (
            <>
              {content.modelError && (
                <div className={styles.warning}>
                  模型调用失败：{content.modelError}
                </div>
              )}
              <div className={styles.intent}>
                <span>AGENT 行动计划 · 模型输出</span>
                <p>{call.intent ?? "这次模型调用没有输出 stepIntent。"}</p>
                <small>表示执行前准备做的事，不代表操作成功或验收通过。</small>
              </div>
              {content.completeness === "LEGACY_PREVIEW" && (
                <div className={styles.notice}>
                  以下为历史日志预览，可能包含截断或深度限制。分区无法还原时，请展开底部「原始请求与模型输出」查看已有记录。
                </div>
              )}
              {content.redactedPaths.length > 0 && (
                <div className={styles.notice}>
                  完整保留上下文结构与正文；{content.redactedPaths.length}{" "}
                  处凭据已标记脱敏。
                  <details>
                    <summary>查看脱敏位置</summary>
                    <ValueView value={content.redactedPaths} />
                  </details>
                </div>
              )}
              <ContextBlocks
                key={call.id}
                sections={content.sections}
                completeness={content.completeness}
              />
              <details className={styles.raw}>
                <summary>
                  <FileJson size={15} />
                  原始请求与模型输出{" "}
                  <span>{bytesLabel(content.byteLength)}</span>
                </summary>
                <p className={styles.muted}>
                  完整请求含模型实际收到的
                  messages、tools、参数及图片。可切换原文与结构化查看，下载保留所有字段。工具执行结果来自运行日志预览。
                </p>
                <ContextContentView
                  label="原始请求与模型输出"
                  value={{
                    metrics: content.metrics,
                    decision: content.decision,
                    modelError: content.modelError,
                    toolResults: content.tools,
                    request: content.request,
                  }}
                />
                <p className={styles.hash}>
                  SHA-256: {content.sha256 ?? "历史记录没有完整请求校验值"}
                </p>
              </details>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function CallStatus({ call }: { call: StepContextCall }) {
  return (
    <span className={styles.status} data-status={call.status}>
      {
        {
          SUCCEEDED: "模型已返回",
          FAILED: "模型调用失败",
          RUNNING: "模型调用中",
          INTERRUPTED: "模型调用中断",
        }[call.status]
      }
    </span>
  );
}
