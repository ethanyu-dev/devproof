"use client";
import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Search, RefreshCw, Layers3 } from "lucide-react";
import type { ExecutionContextList } from "@devproof/contracts";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { consoleApi } from "@/lib/api";
import { attemptHref, statusLabel, timestamp } from "./context-display";
import styles from "./step-context.module.css";

export function ExecutionContexts() {
  const search = useSearchParams(),
    router = useRouter();
  const query = search.toString();
  const [q, setQ] = useState(search.get("q") ?? ""),
    [data, setData] = useState<ExecutionContextList | null>(null);
  const [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    setQ(search.get("q") ?? "");
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    consoleApi<ExecutionContextList>(`/execution-contexts?${query}`, {
      signal: controller.signal,
    })
      .then(setData)
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, refresh]);
  function update(values: Record<string, string>) {
    const next = new URLSearchParams(query);
    for (const [k, v] of Object.entries(values))
      v ? next.set(k, v) : next.delete(k);
    router.push(`/console/execution-contexts?${next}`);
  }
  return (
    <div className={styles.page}>
      <PageHeader
        title="执行上下文"
        description="逐轮查看 Agent 看到了什么、准备做什么。每次执行尝试独立留存，重试保留历史。"
        actions={
          <Button
            variant="secondary"
            onClick={() => setRefresh((n) => n + 1)}
            disabled={loading}
          >
            <RefreshCw />
            刷新
          </Button>
        }
      />
      <div className={styles.listHeading}>
        <div>
          <Layers3 size={18} />
          <strong>全部执行记录</strong>
          <span>{data?.total ?? "—"} 次尝试</span>
        </div>
        <span className={styles.muted}>记录标识：execution ID + 尝试次数</span>
      </div>
      <form
        className={styles.filters}
        onSubmit={(e) => {
          e.preventDefault();
          update({ q, page: "1" });
        }}
      >
        <label className={styles.search}>
          <Search size={17} />
          <input
            aria-label="搜索执行 ID 或任务目标"
            placeholder="搜索 execution ID、ID+次数或任务目标…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <select
          aria-label="执行状态"
          value={search.get("status") ?? ""}
          onChange={(e) => update({ status: e.target.value, page: "1" })}
        >
          <option value="">全部状态</option>
          {[
            "PENDING",
            "RUNNING",
            "WAITING_HUMAN",
            "SUCCEEDED",
            "FAILED",
            "CANCELLED",
            "TIMED_OUT",
          ].map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <Button type="submit">搜索</Button>
        {search.get("caseId") && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => update({ caseId: "", page: "1" })}
          >
            清除用例筛选
          </Button>
        )}
      </form>
      {error && (
        <div role="alert" className={styles.warning}>
          {error}
        </div>
      )}
      <div className={styles.tableWrap} aria-busy={loading}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>执行标识</th>
              <th>任务目标</th>
              <th>执行次数</th>
              <th>状态</th>
              <th>上下文留存</th>
              <th>创建时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.items.map((row) => (
              <tr key={row.attemptId}>
                <td>
                  <Link
                    className={styles.id}
                    href={attemptHref(row.runId, row.attemptNumber)}
                  >
                    {row.id}
                  </Link>
                </td>
                <td>
                  <div className={styles.goal} title={row.goal}>
                    {row.goal.split("\n")[0]}
                  </div>
                </td>
                <td>
                  尝试 {row.attemptNumber}
                  {row.executionOrdinal !== null && (
                    <small>用例执行第 {row.executionOrdinal} 次</small>
                  )}
                </td>
                <td>
                  <span className={styles.status} data-status={row.status}>
                    {statusLabel(row.status)}
                  </span>
                </td>
                <td>
                  {row.capturedCalls ? (
                    <span className={styles.complete}>
                      {row.capturedCalls} 份完整输入
                    </span>
                  ) : (
                    <span className={styles.muted}>
                      {["PENDING", "RUNNING"].includes(row.status)
                        ? "尚未采集"
                        : "历史预览"}
                    </span>
                  )}
                </td>
                <td className={styles.date}>{timestamp(row.createdAt)}</td>
                <td>
                  <Link
                    aria-label={`查看 ${row.id}`}
                    href={attemptHref(row.runId, row.attemptNumber)}
                  >
                    <ArrowRight size={17} />
                  </Link>
                </td>
              </tr>
            ))}
            {!data?.items.length && (
              <tr>
                <td colSpan={7} className={styles.empty}>
                  {loading ? "正在读取执行记录…" : "没有匹配的执行记录"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && (
        <div className={styles.pagination}>
          <span>
            第 {data.page} /{" "}
            {Math.max(1, Math.ceil(data.total / data.pageSize))} 页 · 共{" "}
            {data.total} 次尝试
          </span>
          <div>
            <Button
              variant="secondary"
              disabled={loading || data.page === 1}
              onClick={() => update({ page: String(data.page - 1) })}
            >
              上一页
            </Button>
            <Button
              variant="secondary"
              disabled={loading || data.page * data.pageSize >= data.total}
              onClick={() => update({ page: String(data.page + 1) })}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
