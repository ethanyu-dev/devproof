"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/native-select";
import {
  Activity,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  RotateCcw,
  Search,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import {
  ErrorState,
  FormMessage,
  LoadingState,
} from "@/components/settings-layout";
import { consoleApi } from "@/lib/api";
import { displayLabel } from "@/lib/display-text";
import { taskOutcomeDisplay } from "./task-outcome";
import { terminalLifecycles, tone } from "./task-display";
import {
  defaultFilters,
  readTaskListState,
  taskListHref,
  taskDetailHref,
  type TaskFilters,
} from "./task-navigation";
import { useTaskActions } from "./use-task-actions";
import type { TaskDetail, TaskSummary } from "./task-types";

const PAGE_SIZE = 10;
interface TaskPage {
  items: TaskSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function TasksClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { page, filters: appliedFilters } = useMemo(
    () => readTaskListState(searchParams),
    [searchParams],
  );
  const returnTo = taskListHref(page, appliedFilters);
  const [filters, setFilters] = useState<TaskFilters>(appliedFilters);
  const [result, setResult] = useState<TaskPage | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => setFilters(appliedFilters), [appliedFilters]);

  const load = useCallback(
    async (background = false) => {
      if (background && requestRef.current) return;
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      if (!background) setLoadingList(true);
      try {
        const response = await consoleApi<TaskPage>(
          `/tasks?${taskListQuery(page, appliedFilters)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setResult(response);
        setLoadError(null);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError((error as Error).message);
      } finally {
        if (requestRef.current === controller) {
          requestRef.current = null;
          setLoadingList(false);
        }
      }
    },
    [page, appliedFilters],
  );

  useEffect(() => {
    void load();
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [load]);

  const hasActiveTasks = result?.items.some(
    (task) => !terminalLifecycles.has(task.lifecycle),
  );
  useEffect(() => {
    if (!hasActiveTasks) return;
    const timer = window.setInterval(() => void load(true), 5_000);
    return () => window.clearInterval(timer);
  }, [hasActiveTasks, load]);

  function navigate(nextPage: number, nextFilters = appliedFilters) {
    const href = taskListHref(nextPage, nextFilters);
    if (href === returnTo) void load();
    else router.push(href, { scroll: false });
  }

  const updateSummary = useCallback(
    (detail: TaskDetail) => {
      setResult((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === detail.id ? detail : item,
              ),
            }
          : current,
      );
      // A status change can remove this row from the current filter.
      void load();
    },
    [load],
  );

  function focusRerun(task: TaskDetail) {
    router.push(taskDetailHref(task.id, returnTo));
  }

  const rows = result?.items ?? null;
  return (
    <div className="dp-task-list-page">
      <PageHeader
        actions={
          <Button
            onClick={() => void load()}
            disabled={loadingList}
            variant="secondary"
          >
            <RefreshCw />
            刷新
          </Button>
        }
        description="查看任务状态与执行进度，进入详情查看 Spec、执行记录和日志。"
        title="任务执行"
      />
      {loadError && result ? (
        <FormMessage message={loadError} tone="error" />
      ) : null}
      <form
        className="dp-task-filters"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(1, { ...filters, query: filters.query.trim() });
        }}
      >
        <Field label="搜索任务">
          <Input
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                query: event.target.value,
              }))
            }
            placeholder="标题、Issue 或来源"
            value={filters.query}
          />
        </Field>
        <Field label="状态">
          <Select
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                status: event.target.value as TaskFilters["status"],
              }))
            }
            value={filters.status}
          >
            <option value="ALL">全部状态</option>
            <option value="ACTIVE">进行中</option>
            <option value="WAITING_HUMAN">等待人工操作</option>
            <option value="PASSED">验证通过</option>
            <option value="VERIFICATION_FAILED">验证未通过</option>
            <option value="EXECUTION_FAILED">任务执行失败</option>
            <option value="COMPLETED">已完成</option>
            <option value="CANCELLED">已取消</option>
            <option value="TIMED_OUT">已超时</option>
          </Select>
        </Field>
        <Field label="任务类型">
          <Select
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                kind: event.target.value as TaskFilters["kind"],
              }))
            }
            value={filters.kind}
          >
            <option value="ALL">全部类型</option>
            <option value="ISSUE_SPEC">Issue 分析任务</option>
            <option value="DIRECT_RUN">直接任务</option>
            <option value="LEGACY_RUN">历史迁移任务</option>
          </Select>
        </Field>
        <Field label="创建时间">
          <Select
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                period: event.target.value as TaskFilters["period"],
              }))
            }
            value={filters.period}
          >
            <option value="ALL">全部时间</option>
            <option value="DAY">最近 24 小时</option>
            <option value="WEEK">最近 7 天</option>
            <option value="MONTH">最近 30 天</option>
          </Select>
        </Field>
        <div className="dp-task-filter-actions">
          <Button disabled={loadingList} type="submit">
            <Search /> 筛选
          </Button>
          <Button
            disabled={
              !hasTaskFilters(filters) && !hasTaskFilters(appliedFilters)
            }
            onClick={() => {
              setFilters(defaultFilters);
              navigate(1, defaultFilters);
            }}
            type="button"
            variant="secondary"
          >
            清空
          </Button>
        </div>
      </form>
      <Card className="dp-verification-list dp-verification-list-view dp-task-list">
        <div className="dp-section-head">
          <span>
            <Activity />
            <b>任务记录</b>
          </span>
          <span className="dp-count">{result?.total ?? 0}</span>
        </div>
        {rows === null && loadError ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : rows === null ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <div className="dp-task-empty">
            <Activity />
            <b>
              {hasTaskFilters(appliedFilters)
                ? "没有符合条件的任务"
                : "还没有任务"}
            </b>
            <span>
              {hasTaskFilters(appliedFilters)
                ? "调整或清空筛选条件后重试。"
                : "前往集成试验场，粘贴 Issue 或创建直接执行任务。"}
            </span>
          </div>
        ) : (
          <div className="dp-task-list-items">
            <div aria-hidden="true" className="dp-task-grid-head">
              <span>任务</span>
              <span>状态</span>
              <span>进度</span>
              <span>创建时间</span>
              <span className="dp-task-actions-heading">操作</span>
            </div>
            {rows.map((task) => (
              <TaskRow
                key={task.id}
                onRerun={focusRerun}
                onSummary={updateSummary}
                href={taskDetailHref(task.id, returnTo)}
                task={task}
              />
            ))}
          </div>
        )}
        {result && result.total > 0 ? (
          <nav aria-label="任务分页" className="dp-task-pagination">
            <Button
              disabled={loadingList || page <= 1}
              onClick={() => navigate(page - 1)}
              variant="secondary"
            >
              <ChevronLeft /> 上一页
            </Button>
            <span>
              第 <b>{page}</b> / {result.totalPages} 页 · 共 {result.total} 条
            </span>
            <Button
              disabled={loadingList || page >= result.totalPages}
              onClick={() => navigate(page + 1)}
              variant="secondary"
            >
              下一页 <ChevronRight />
            </Button>
          </nav>
        ) : null}
      </Card>
    </div>
  );
}

function hasTaskFilters(filters: TaskFilters) {
  return (
    filters.query.trim().length > 0 ||
    filters.status !== "ALL" ||
    filters.kind !== "ALL" ||
    filters.period !== "ALL"
  );
}

function taskListQuery(page: number, filters: TaskFilters) {
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  if (filters.query.trim()) query.set("query", filters.query.trim());
  if (filters.status !== "ALL") query.set("status", filters.status);
  if (filters.kind !== "ALL") query.set("kind", filters.kind);
  if (filters.period !== "ALL") {
    const duration =
      filters.period === "DAY"
        ? 24 * 60 * 60 * 1_000
        : filters.period === "WEEK"
          ? 7 * 24 * 60 * 60 * 1_000
          : 30 * 24 * 60 * 60 * 1_000;
    query.set("createdAfter", new Date(Date.now() - duration).toISOString());
  }
  return query;
}

function TaskRow({
  href,
  onRerun,
  onSummary,
  task,
}: {
  href: string;
  onRerun: (task: TaskDetail) => void;
  onSummary: (task: TaskDetail) => void;
  task: TaskSummary;
}) {
  const { busy, message, cancel, rerun } = useTaskActions({
    id: task.id,
    onUpdated: onSummary,
    onRerun,
  });
  const displayed = task;
  const active = !terminalLifecycles.has(displayed.lifecycle);
  const outcome = taskOutcomeDisplay(displayed);
  const terminalCount =
    displayed.counts.terminal ??
    displayed.counts.passed +
      displayed.counts.failed +
      displayed.counts.inconclusive;
  const createdAt = new Date(displayed.createdAt);
  return (
    <article className="dp-task-row">
      <div className="dp-task-row-grid">
        <Link className="dp-task-title-link" href={href}>
          <strong title={displayed.title}>{displayed.title}</strong>
          <small>
            {displayLabel(displayed.kind)} ·{" "}
            {displayLabel(displayed.currentStage)}
          </small>
        </Link>
        <div
          className="dp-task-status-cell"
          title={outcome.description ?? undefined}
        >
          <span className="dp-task-cell-label">状态</span>
          <Badge
            className="max-w-full whitespace-normal text-left"
            tone={tone(outcome.toneStatus)}
          >
            {outcome.label}
          </Badge>
        </div>
        <div className="dp-task-progress-cell">
          <span className="dp-task-progress-count">
            <b>
              {displayed.counts.total > 0
                ? `${terminalCount} / ${displayed.counts.total}`
                : "暂无执行项"}
            </b>
            {displayed.counts.total > 0 && <span>已结束</span>}
          </span>
          {displayed.counts.total > 0 && (
            <>
              <progress
                aria-label={`${displayed.title}：已结束 ${terminalCount} / ${displayed.counts.total}`}
                max={displayed.counts.total}
                value={terminalCount}
              />
              <small>
                执行 {displayed.counts.running} · 等待{" "}
                {displayed.counts.waiting}
              </small>
            </>
          )}
        </div>
        <time
          className="dp-task-time-cell"
          dateTime={displayed.createdAt}
          title={createdAt.toLocaleString("zh-CN")}
        >
          <span className="dp-task-cell-label">创建时间</span>
          <span>
            {createdAt.toLocaleDateString("zh-CN", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            })}
          </span>
          <small>
            {createdAt.toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </small>
        </time>
        <div className="dp-task-row-controls">
          {displayed.kind !== "LEGACY_RUN" ? (
            <Button
              aria-label="重新运行任务"
              className="col-start-1"
              disabled={busy}
              onClick={() => void rerun()}
              size="icon-sm"
              title="重新运行任务"
              variant="ghost"
            >
              <RotateCcw />
            </Button>
          ) : null}
          {active ? (
            <Button
              aria-label="取消任务"
              className="col-start-2 text-muted-foreground hover:bg-destructive-soft hover:text-destructive"
              disabled={busy}
              onClick={() => void cancel()}
              size="icon-sm"
              title="取消任务"
              variant="ghost"
            >
              <XCircle />
            </Button>
          ) : null}
          <Button
            asChild
            className="col-start-3"
            size="icon-sm"
            variant="ghost"
          >
            <Link
              href={href}
              aria-label={`查看任务详情：${displayed.title}`}
              title="查看任务详情"
            >
              <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>
      {message && (
        <div className="dp-task-row-message">
          <FormMessage message={message.text} tone={message.tone} />
        </div>
      )}
    </article>
  );
}
