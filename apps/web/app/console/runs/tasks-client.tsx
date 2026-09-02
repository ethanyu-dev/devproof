"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunTrajectoryRecord } from "@devproof/contracts";
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  ExternalLink,
  FileSearch,
  Layers3,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/native-select";

import { PageHeader } from "@/components/page-header";
import {
  ErrorState,
  FormMessage,
  LoadingState,
} from "@/components/settings-layout";
import { consoleApi } from "@/lib/api";
import { displayLabel } from "@/lib/display-text";
import {
  aggregateAnalysisEvents,
  analysisEventFilters,
  analysisEventMatches,
  mergePostRunAnalysisEventPage,
  mergePostRunAnalysisEvents,
} from "./post-run-analysis-view";
import { retainedProfilePolicy } from "./profile-policy";
import { RunTrajectory } from "./run-trajectory";
import { taskOutcomeDisplay, verificationVerdictLabel } from "./task-outcome";
import type {
  TaskCase,
  TaskCaseExecution,
  TaskDetail,
  TaskEvent,
  PostRunAnalysisDetail,
  PostRunAnalysisEventCategory,
  PostRunAnalysisEventPage,
  TaskStage,
  TaskSummary,
} from "./task-types";

const PAGE_SIZE = 10;
const terminalLifecycles = new Set(["COMPLETED", "CANCELLED", "TIMED_OUT"]);
type ProfileStrategy =
  "EPHEMERAL" | "REQUESTER" | "ISSUE_ASSIGNEE" | "EXPLICIT_PROFILE";

interface TaskPage {
  items: TaskSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface TaskFilters {
  kind: "ALL" | "ISSUE_SPEC" | "DIRECT_RUN" | "LEGACY_RUN";
  period: "ALL" | "DAY" | "WEEK" | "MONTH";
  query: string;
  status:
    | "ALL"
    | "ACTIVE"
    | "WAITING_HUMAN"
    | "PASSED"
    | "VERIFICATION_FAILED"
    | "EXECUTION_FAILED"
    | "COMPLETED"
    | "CANCELLED"
    | "TIMED_OUT";
}

const defaultFilters: TaskFilters = {
  kind: "ALL",
  period: "ALL",
  query: "",
  status: "ALL",
};

const profileStrategyDescriptions = {
  EPHEMERAL: "使用全新临时会话，不读取或保留任何持久化登录状态。",
  EXPLICIT_PROFILE:
    "从你自己的可用浏览器身份中明确指定一个；系统不会自动创建。",
  ISSUE_ASSIGNEE:
    "使用 Linear Issue 当前负责人的浏览器身份；负责人需要已关联 DevProof 用户。",
  REQUESTER:
    "使用任务请求人的浏览器身份；如果当前任务没有请求人，你将认领该任务并自动创建所需身份。",
} as const;

function tone(
  status: string | null,
): "success" | "warning" | "danger" | "neutral" {
  if (["PASSED", "SUCCEEDED", "EXECUTED", "COMPLETED"].includes(status ?? ""))
    return "success";
  if (
    [
      "FAILED",
      "CANCELLED",
      "TIMED_OUT",
      "NOT_RUN",
      "BLOCKED",
      "AGENT_ERROR",
      "PROVIDER_ERROR",
      "BROWSER_UNAVAILABLE",
      "RUNTIME_LOST",
      "CRITICAL",
      "HIGH",
    ].includes(status ?? "")
  )
    return "danger";
  if (
    [
      "PENDING",
      "QUEUED",
      "RUNNING",
      "WAITING_INPUT",
      "WAITING_HUMAN",
      "DISPATCHING",
      "PENDING_CAPTURE",
      "CAPTURING",
      "READY",
      "MEDIUM",
      "LOW",
    ].includes(status ?? "")
  )
    return "warning";
  return "neutral";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (!isRecord(error)) return null;
  const message = error.message;
  const code = error.code;
  if (typeof message !== "string") return null;
  return typeof code === "string" ? `${code}: ${message}` : message;
}

function prettyValue(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatByteSize(byteSize: number | null) {
  if (byteSize === null) return "大小未知";
  if (byteSize < 1_024) return `${byteSize} B`;
  if (byteSize < 1_048_576) return `${(byteSize / 1_024).toFixed(1)} KB`;
  return `${(byteSize / 1_048_576).toFixed(1)} MB`;
}

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function TasksClient({ initialId }: { initialId?: string | undefined }) {
  return <TaskListClient initialId={initialId} />;
}

function TaskListClient({ initialId }: { initialId?: string | undefined }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<TaskPage | null>(null);
  const [filters, setFilters] = useState<TaskFilters>(defaultFilters);
  const [appliedFilters, setAppliedFilters] =
    useState<TaskFilters>(defaultFilters);
  const [loadingList, setLoadingList] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    new Set(initialId ? [initialId] : []),
  );
  const [message, setMessage] = useState<{
    text: string;
    tone: "error" | "success";
  } | null>(null);

  const load = useCallback(
    async (requestedPage: number, requestedFilters = appliedFilters) => {
      setLoadingList(true);
      setLoadError(null);
      const query = taskListQuery(requestedPage, requestedFilters);
      try {
        const response = await consoleApi<TaskPage>(
          `/tasks?${query.toString()}`,
        );
        if (
          initialId &&
          requestedPage === 1 &&
          !hasTaskFilters(requestedFilters) &&
          !response.items.some((item) => item.id === initialId)
        ) {
          try {
            const focused = await consoleApi<TaskDetail>(`/tasks/${initialId}`);
            response.items = [focused, ...response.items];
          } catch {
            // The normal list remains usable when an old detail link is stale.
          }
        }
        setResult(response);
        setPage(requestedPage);
        return response;
      } catch (error) {
        setLoadError((error as Error).message);
        throw error;
      } finally {
        setLoadingList(false);
      }
    },
    [appliedFilters, initialId],
  );

  useEffect(() => {
    void load(1).catch(() => undefined);
  }, [load]);

  const updateFocusedTask = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (id) next.set("task", id);
      else next.delete("task");
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  function toggle(id: string) {
    const opening = !expanded.has(id);
    const next = new Set(expanded);
    if (opening) next.add(id);
    else next.delete(id);
    setExpanded(next);
    updateFocusedTask(opening ? id : ([...next].at(-1) ?? null));
  }

  const updateSummary = useCallback((detail: TaskDetail) => {
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
  }, []);

  const focusRerun = useCallback(
    async (task: TaskDetail) => {
      setMessage({
        text:
          task.kind === "ISSUE_SPEC"
            ? "已创建新的重跑任务，并从当前 Issue 重新生成 Spec。"
            : "已创建新的重跑任务。",
        tone: "success",
      });
      setExpanded(new Set([task.id]));
      updateFocusedTask(task.id);
      setFilters(defaultFilters);
      setAppliedFilters(defaultFilters);
      await load(1, defaultFilters);
    },
    [load, updateFocusedTask],
  );

  const rows = result?.items ?? null;
  return (
    <>
      <PageHeader
        actions={
          <Button
            onClick={() => {
              setMessage(null);
              void load(page).catch(() => undefined);
            }}
            disabled={loadingList}
            variant="secondary"
          >
            <RefreshCw />
            刷新
          </Button>
        }
        description="查看团队的全部任务，处理等待项，并下钻到每一次浏览器执行与证据。"
        title="任务执行"
      />
      {message ? (
        <FormMessage message={message.text} tone={message.tone} />
      ) : null}
      {loadError && result ? (
        <FormMessage message={loadError} tone="error" />
      ) : null}
      <form
        className="dp-task-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedFilters({ ...filters, query: filters.query.trim() });
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
              setAppliedFilters(defaultFilters);
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
          <ErrorState
            message={loadError}
            onRetry={() => void load(1).catch(() => undefined)}
          />
        ) : rows === null ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <div className="dp-playground-empty">
            <Activity />
            <b>还没有任务</b>
            <span>前往集成试验场，粘贴 Issue 或创建直接执行任务。</span>
          </div>
        ) : (
          <div className="dp-task-list-items">
            {rows.map((task) => (
              <TaskRow
                expanded={expanded.has(task.id)}
                key={task.id}
                onRerun={focusRerun}
                onSummary={updateSummary}
                onToggle={() => toggle(task.id)}
                task={task}
              />
            ))}
          </div>
        )}
        {result && result.total > 0 ? (
          <nav aria-label="任务分页" className="dp-task-pagination">
            <Button
              disabled={loadingList || page <= 1}
              onClick={() => void load(page - 1).catch(() => undefined)}
              variant="secondary"
            >
              <ChevronLeft /> 上一页
            </Button>
            <span>
              第 <b>{page}</b> / {result.totalPages} 页 · 共 {result.total} 条
            </span>
            <Button
              disabled={loadingList || page >= result.totalPages}
              onClick={() => void load(page + 1).catch(() => undefined)}
              variant="secondary"
            >
              下一页 <ChevronRight />
            </Button>
          </nav>
        ) : null}
      </Card>
    </>
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
  expanded,
  onRerun,
  onSummary,
  onToggle,
  task,
}: {
  expanded: boolean;
  onRerun: (task: TaskDetail) => Promise<void>;
  onSummary: (task: TaskDetail) => void;
  onToggle: () => void;
  task: TaskSummary;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [trajectory, setTrajectory] = useState<RunTrajectoryRecord[]>([]);
  const [view, setView] = useState<"analysis" | "logs" | "specs">("specs");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const [message, setMessage] = useState<{
    text: string;
    tone: "error" | "success";
  } | null>(null);

  const load = useCallback(async () => {
    if (loadingRef.current) return null;
    loadingRef.current = true;
    setLoading(true);
    try {
      const [nextDetail, nextEvents] = await Promise.all([
        consoleApi<TaskDetail>(`/tasks/${task.id}`),
        consoleApi<TaskEvent[]>(`/tasks/${task.id}/events`),
      ]);
      const nextTrajectory = projectSpecGenerationTrajectory(
        nextDetail,
        nextEvents,
      );
      setDetail(nextDetail);
      setEvents(nextEvents);
      setTrajectory(nextTrajectory);
      onSummary(nextDetail);
      setMessage((current) => (current?.tone === "error" ? null : current));
      return nextDetail;
    } catch (error) {
      setMessage({ text: (error as Error).message, tone: "error" });
      return null;
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [onSummary, task.id]);

  useEffect(() => {
    if (!expanded) return;
    void load();
  }, [expanded, load]);

  useEffect(() => {
    if (!expanded || !detail || terminalLifecycles.has(detail.lifecycle))
      return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [detail?.lifecycle, expanded, load]);

  useEffect(() => {
    if (
      view === "analysis" &&
      detail &&
      (!detail.capabilities.postRunAnalysis ||
        !terminalLifecycles.has(detail.lifecycle))
    ) {
      setView("specs");
    }
  }, [detail, view]);

  async function mutate(path: string, body?: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await consoleApi<TaskDetail>(`/tasks/${task.id}${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        method: "POST",
      });
      setDetail(updated);
      onSummary(updated);
      await load();
      setMessage({ text: "任务已更新。", tone: "success" });
      return updated;
    } catch (error) {
      setMessage({ text: (error as Error).message, tone: "error" });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (
      !window.confirm("确认取消整个任务？Spec 分析与所有未完成的执行都会停止。")
    )
      return;
    await mutate("/cancel");
  }

  async function rerun() {
    if (
      !window.confirm(
        "确认基于当前任务重新运行？这会创建新任务并保留当前记录。",
      )
    )
      return;
    setBusy(true);
    setMessage(null);
    try {
      const rerunTask = await consoleApi<TaskDetail>(
        `/tasks/${task.id}/rerun`,
        {
          method: "POST",
        },
      );
      await onRerun(rerunTask);
    } catch (error) {
      setMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const displayed = detail ?? task;
  const active = !terminalLifecycles.has(displayed.lifecycle);
  const outcome = taskOutcomeDisplay(displayed);
  return (
    <article className={`dp-task-row ${expanded ? "is-expanded" : ""}`}>
      <div className="dp-task-row-summary">
        <button
          aria-expanded={expanded}
          className="dp-task-row-primary"
          onClick={onToggle}
          type="button"
        >
          <span>
            <strong title={displayed.title}>{displayed.title}</strong>
            <span title={outcome.description ?? undefined}>
              <Badge tone={tone(outcome.toneStatus)}>{outcome.label}</Badge>
            </span>
          </span>
          <small>
            {displayLabel(displayed.kind)} ·{" "}
            {displayLabel(displayed.currentStage)} · Case{" "}
            {displayed.counts.passed +
              displayed.counts.failed +
              displayed.counts.inconclusive}
            /{displayed.counts.total} ·{" "}
            {new Date(displayed.createdAt).toLocaleString("zh-CN")}
          </small>
        </button>
        <div className="dp-task-row-actions">
          {displayed.kind !== "LEGACY_RUN" ? (
            <Button
              aria-label="重新运行任务"
              disabled={busy}
              onClick={() => void rerun()}
              size="icon-sm"
              title="重新运行任务"
              variant="secondary"
            >
              <RotateCcw />
            </Button>
          ) : null}
          {active ? (
            <Button
              aria-label="取消任务"
              disabled={busy}
              onClick={() => void cancel()}
              size="icon-sm"
              title="取消任务"
              variant="danger"
            >
              <XCircle />
            </Button>
          ) : null}
          <Button
            aria-label={expanded ? "收起任务" : "展开任务"}
            onClick={onToggle}
            size="icon-sm"
            title={expanded ? "收起任务" : "展开任务"}
            variant="secondary"
          >
            {expanded ? <ChevronUp /> : <ChevronDown />}
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="dp-task-row-detail">
          {message && (detail || message.tone === "success") ? (
            <FormMessage message={message.text} tone={message.tone} />
          ) : null}
          {loading && !detail ? (
            <LoadingState />
          ) : !detail && message?.tone === "error" ? (
            <ErrorState message={message.text} onRetry={() => void load()} />
          ) : detail ? (
            <>
              <div
                aria-label="任务详情视图"
                className="dp-run-runtime-tabs"
                role="tablist"
              >
                <button
                  aria-selected={view === "specs"}
                  onClick={() => setView("specs")}
                  role="tab"
                  type="button"
                >
                  <Layers3 /> Spec &amp; Runtime
                  <span>{detail.cases.length || detail.runs.length}</span>
                </button>
                <button
                  aria-selected={view === "logs"}
                  onClick={() => setView("logs")}
                  role="tab"
                  type="button"
                >
                  <ScrollText /> 日志
                  <span>{trajectory.length}</span>
                </button>
                {detail.capabilities.postRunAnalysis &&
                terminalLifecycles.has(detail.lifecycle) ? (
                  <button
                    aria-selected={view === "analysis"}
                    onClick={() => setView("analysis")}
                    role="tab"
                    type="button"
                  >
                    <FileSearch /> 自动优化分析
                  </button>
                ) : null}
              </div>
              <div className="dp-task-status-panel" role="tabpanel">
                <TaskStatusPanel
                  busy={busy}
                  detail={detail}
                  onMutate={mutate}
                  trajectory={trajectory}
                  view={view}
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function TaskStatusPanel({
  busy,
  detail,
  onMutate,
  trajectory,
  view,
}: {
  busy: boolean;
  detail: TaskDetail;
  onMutate: (path: string, body?: unknown) => Promise<TaskDetail | null>;
  trajectory: RunTrajectoryRecord[];
  view: "analysis" | "logs" | "specs";
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [deploymentDrafts, setDeploymentDrafts] = useState([
    { id: 1, name: "Preview", targetUrl: "" },
  ]);
  const [profileStrategy, setProfileStrategy] =
    useState<ProfileStrategy>("EPHEMERAL");
  const [profileId, setProfileId] = useState("");
  const [profiles, setProfiles] = useState<
    Array<{ displayName: string; id: string; status: string }>
  >([]);
  const boundProfile =
    detail.profileBinding?.requestedProfile ??
    detail.profileBinding?.resolvedProfile ??
    null;
  const explicitBoundProfile =
    detail.profileBinding?.strategy === "EXPLICIT_PROFILE"
      ? boundProfile
      : null;
  const stages = (
    ["SPEC_ANALYSIS", "PROFILE_RESOLUTION", "SPEC_EXECUTION"] as const
  ).flatMap((type) => {
    const stage = detail.stages.find((item) => item.type === type);
    return stage ? [stage] : [];
  });
  const analysis = detail.stages.find(
    (stage) => stage.type === "SPEC_ANALYSIS",
  );
  const analysisFailure =
    analysis?.lastError ??
    [...(analysis?.attempts ?? [])].reverse().find((attempt) => attempt.error)
      ?.error;
  const showStages =
    !terminalLifecycles.has(detail.lifecycle) ||
    Boolean(detail.waitingReason) ||
    stages.some((stage) => ["FAILED", "RUNNING"].includes(stage.status));

  useEffect(() => {
    if (
      detail.waitingReason !== "DEPLOYMENT_TARGET_REQUIRED" &&
      !detail.waitingReason?.startsWith("PROFILE_")
    )
      return;
    void consoleApi<Array<{ displayName: string; id: string; status: string }>>(
      "/browser-profiles",
    ).then(setProfiles);
  }, [detail.waitingReason]);

  useEffect(() => {
    const strategy = detail.profileBinding?.strategy;
    if (
      strategy &&
      ["EPHEMERAL", "REQUESTER", "ISSUE_ASSIGNEE", "EXPLICIT_PROFILE"].includes(
        strategy,
      )
    ) {
      setProfileStrategy(strategy as ProfileStrategy);
      setProfileId(
        strategy === "EXPLICIT_PROFILE" ? (boundProfile?.id ?? "") : "",
      );
    }
  }, [boundProfile?.id, detail.id, detail.profileBinding?.strategy]);

  const currentProfilePolicy = retainedProfilePolicy(detail.input);
  const profileSelection = (strategy: ProfileStrategy = profileStrategy) => ({
    profilePolicy: {
      onUnavailable: currentProfilePolicy.onUnavailable,
      ...(strategy === "EXPLICIT_PROFILE" ? { profileId } : {}),
      scope: currentProfilePolicy.scope,
      strategy,
    },
  });

  async function submitDeployments() {
    const deployments = deploymentDrafts
      .filter((deployment) => deployment.targetUrl.trim())
      .map((deployment, index) => ({
        environment: {},
        key: `deployment-${index + 1}`,
        name: deployment.name.trim() || `验证环境 ${index + 1}`,
        targetUrl: deployment.targetUrl.trim(),
      }));
    if (
      profileStrategy !== detail.profileBinding?.strategy ||
      (profileStrategy === "EXPLICIT_PROFILE" &&
        profileId !== (boundProfile?.id ?? ""))
    ) {
      const updated = await onMutate("/profile", profileSelection());
      if (!updated) return;
    }
    await onMutate("/deployments", { deployments });
  }

  async function exportAllLogs() {
    setExporting(true);
    setExportError(null);
    try {
      const exported = await consoleApi<unknown>(
        `/tasks/${detail.id}/logs/export`,
      );
      const timestamp = new Date().toISOString().replaceAll(":", "-");
      downloadJson(
        exported,
        `devproof-task-${detail.id}-logs-${timestamp}.json`,
      );
    } catch (error) {
      setExportError((error as Error).message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <section className="dp-task-detail-section" hidden={view !== "specs"}>
        {showStages ? (
          <div className="dp-task-stage-grid">
            {stages.map((stage, index) => (
              <StageCard
                allowRetry={detail.kind === "ISSUE_SPEC"}
                busy={busy}
                index={index + 1}
                key={stage.id}
                onRetry={() =>
                  void onMutate(`/stages/${stage.type}/retry`, {
                    reason: "Manual retry from console",
                  })
                }
                stage={stage}
              />
            ))}
          </div>
        ) : null}

        {analysis?.status === "FAILED" && analysisFailure ? (
          <div className="dp-task-analysis-failure" role="alert">
            <div>
              <Badge tone="danger">Spec 分析失败</Badge>
              <strong>
                {errorMessage(analysisFailure) ??
                  "分析 Worker 未返回可读错误信息。"}
              </strong>
            </div>
            <details>
              <summary>查看完整失败原因</summary>
              <pre>{prettyValue(analysisFailure)}</pre>
            </details>
          </div>
        ) : null}

        {detail.waitingReason === "DEPLOYMENT_TARGET_REQUIRED" ? (
          <Card className="dp-task-input-card">
            <div className="dp-section-head">
              <span>
                <PlayCircle />
                <b>继续 Spec 执行</b>
              </span>
              <Badge tone="warning">等待部署地址</Badge>
            </div>
            <div className="dp-playground-form">
              <Field label="验证环境（可添加多个）">
                <div className="dp-deployment-editor">
                  {deploymentDrafts.map((deployment, index) => (
                    <div className="dp-deployment-row" key={deployment.id}>
                      <Input
                        aria-label={`验证环境 ${index + 1} 名称`}
                        onChange={(event) =>
                          setDeploymentDrafts((current) =>
                            current.map((item) =>
                              item.id === deployment.id
                                ? { ...item, name: event.target.value }
                                : item,
                            ),
                          )
                        }
                        placeholder="环境名称"
                        value={deployment.name}
                      />
                      <Input
                        aria-label={`验证环境 ${index + 1} URL`}
                        onChange={(event) =>
                          setDeploymentDrafts((current) =>
                            current.map((item) =>
                              item.id === deployment.id
                                ? { ...item, targetUrl: event.target.value }
                                : item,
                            ),
                          )
                        }
                        placeholder="https://preview.example.com"
                        value={deployment.targetUrl}
                      />
                      {deploymentDrafts.length > 1 ? (
                        <Button
                          onClick={() =>
                            setDeploymentDrafts((current) =>
                              current.filter(
                                (item) => item.id !== deployment.id,
                              ),
                            )
                          }
                          variant="secondary"
                        >
                          删除
                        </Button>
                      ) : null}
                    </div>
                  ))}
                  <Button
                    disabled={deploymentDrafts.length >= 20}
                    onClick={() =>
                      setDeploymentDrafts((current) => [
                        ...current,
                        {
                          id:
                            Math.max(0, ...current.map((item) => item.id)) + 1,
                          name: `验证环境 ${current.length + 1}`,
                          targetUrl: "",
                        },
                      ])
                    }
                    variant="secondary"
                  >
                    添加验证环境
                  </Button>
                </div>
              </Field>
              <Field
                description={profileStrategyDescriptions[profileStrategy]}
                label="页面登录方式"
              >
                <Select
                  onChange={(event) =>
                    setProfileStrategy(event.target.value as ProfileStrategy)
                  }
                  value={profileStrategy}
                >
                  <option value="EPHEMERAL">不需要登录（临时会话）</option>
                  <option value="REQUESTER">使用我的浏览器身份</option>
                  <option value="ISSUE_ASSIGNEE">
                    使用 Issue 负责人的浏览器身份
                  </option>
                  <option value="EXPLICIT_PROFILE">指定我的浏览器身份</option>
                </Select>
              </Field>
              {profileStrategy === "EXPLICIT_PROFILE" ? (
                <Field label="可用浏览器身份">
                  <Select
                    value={profileId}
                    onChange={(event) => setProfileId(event.target.value)}
                  >
                    <option value="">请选择</option>
                    {explicitBoundProfile &&
                    !profiles.some(
                      (profile) =>
                        profile.id === explicitBoundProfile.id &&
                        profile.status === "READY",
                    ) ? (
                      <option value={explicitBoundProfile.id}>
                        {explicitBoundProfile.displayName}（
                        {displayLabel(explicitBoundProfile.status)}）
                      </option>
                    ) : null}
                    {profiles
                      .filter((profile) => profile.status === "READY")
                      .map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.displayName}
                        </option>
                      ))}
                  </Select>
                </Field>
              ) : null}
              <Button
                disabled={
                  busy ||
                  !deploymentDrafts.some((deployment) =>
                    Boolean(deployment.targetUrl.trim()),
                  ) ||
                  (profileStrategy === "EXPLICIT_PROFILE" && !profileId)
                }
                onClick={() => void submitDeployments()}
              >
                提交并执行全部 Spec × Deployment
              </Button>
            </div>
          </Card>
        ) : null}

        {detail.waitingReason?.startsWith("PROFILE_") &&
        detail.profileBinding?.requestedProfile ? (
          <Card className="dp-task-input-card">
            <div className="dp-section-head">
              <span>
                <PlayCircle />
                <b>完成网页登录</b>
              </span>
              <Badge tone="warning">等待浏览器身份所有人</Badge>
            </div>
            <div className="dp-playground-form">
              <p>
                系统已根据任务目标自动准备浏览器身份「
                {detail.profileBinding.requestedProfile.displayName}
                」。无需填写域名或验证规则，
                {detail.profileBinding.requestedProfile.owner.name}
                只需完成登录并确认授权。
              </p>
              <p>
                如果这个 Issue
                验证的是公开页面、不需要登录，可以直接改用临时会话。
              </p>
              <div className="dp-form-actions">
                <Button asChild>
                  <Link
                    href={`/console/profiles?profile=${detail.profileBinding.requestedProfile.id}`}
                  >
                    前往登录
                  </Link>
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void onMutate("/profile", profileSelection("EPHEMERAL"))
                  }
                  variant="secondary"
                >
                  无需登录，继续执行
                </Button>
              </div>
            </div>
          </Card>
        ) : detail.waitingReason?.startsWith("PROFILE_") ? (
          <Card className="dp-task-input-card">
            <div className="dp-section-head">
              <span>
                <PlayCircle />
                <b>选择浏览器登录身份</b>
              </span>
              <Badge tone="warning">等待浏览器身份</Badge>
            </div>
            <div className="dp-playground-form">
              <Field
                description={profileStrategyDescriptions[profileStrategy]}
                label="浏览器身份策略"
              >
                <Select
                  onChange={(event) =>
                    setProfileStrategy(event.target.value as ProfileStrategy)
                  }
                  value={profileStrategy}
                >
                  <option value="REQUESTER">使用我的浏览器身份</option>
                  <option value="ISSUE_ASSIGNEE">
                    使用 Issue 负责人的浏览器身份
                  </option>
                  <option value="EXPLICIT_PROFILE">指定我的浏览器身份</option>
                  <option value="EPHEMERAL">改用临时会话</option>
                </Select>
              </Field>
              {profileStrategy === "EXPLICIT_PROFILE" ? (
                <Field label="可用浏览器身份">
                  <Select
                    value={profileId}
                    onChange={(event) => setProfileId(event.target.value)}
                  >
                    <option value="">请选择</option>
                    {explicitBoundProfile &&
                    !profiles.some(
                      (profile) =>
                        profile.id === explicitBoundProfile.id &&
                        profile.status === "READY",
                    ) ? (
                      <option value={explicitBoundProfile.id}>
                        {explicitBoundProfile.displayName}（
                        {displayLabel(explicitBoundProfile.status)}）
                      </option>
                    ) : null}
                    {profiles
                      .filter((profile) => profile.status === "READY")
                      .map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.displayName}
                        </option>
                      ))}
                  </Select>
                </Field>
              ) : null}
              <Button
                disabled={
                  busy || (profileStrategy === "EXPLICIT_PROFILE" && !profileId)
                }
                onClick={() => void onMutate("/profile", profileSelection())}
              >
                提交身份选择
              </Button>
            </div>
          </Card>
        ) : null}
        <div className="dp-specification-detail-layout dp-task-detail-layout">
          <SpecificationSnapshot detail={detail} />
          <div className="dp-specification-case-list">
            {detail.kind === "DIRECT_RUN" || detail.kind === "LEGACY_RUN"
              ? detail.runs.map((run, index) => (
                  <RunLinkCard
                    key={run.runId}
                    name={`直接执行 #${index + 1}`}
                    run={run}
                  />
                ))
              : detail.cases.map((testCase) => (
                  <CaseCard
                    busy={busy}
                    canRerun={
                      detail.cancelRequestedAt === null &&
                      new Date(detail.deadlineAt).getTime() - Date.now() >=
                        30_000
                    }
                    key={testCase.id}
                    onRerun={() => void onMutate(`/cases/${testCase.id}/rerun`)}
                    testCase={testCase}
                  />
                ))}
          </div>
        </div>
      </section>

      <section
        className="dp-task-detail-section dp-task-log-module"
        hidden={view !== "logs"}
      >
        {exportError ? (
          <FormMessage message={exportError} tone="error" />
        ) : null}
        <div className="dp-task-status-toolbar">
          <span>
            <b>完整任务日志</b>
          </span>
          <Button
            disabled={exporting}
            onClick={() => void exportAllLogs()}
            size="sm"
            variant="secondary"
          >
            <Download /> {exporting ? "正在导出…" : "导出全部日志"}
          </Button>
        </div>
        <div className="dp-task-trajectory-panel">
          {detail.kind === "ISSUE_SPEC" ? (
            <RunTrajectory
              loadingOlder={false}
              onLoadOlder={async () => undefined}
              page={{
                hasMore: false,
                nextBefore: null,
                records: trajectory,
              }}
            />
          ) : (
            <p className="dp-task-empty-copy">直接任务不经过 Spec 分析。</p>
          )}
        </div>
      </section>

      <section className="dp-task-detail-section" hidden={view !== "analysis"}>
        {view === "analysis" &&
        detail.capabilities.postRunAnalysis &&
        terminalLifecycles.has(detail.lifecycle) ? (
          <PostRunAnalysisPanel taskId={detail.id} />
        ) : null}
      </section>
    </>
  );
}

function PostRunAnalysisPanel({ taskId }: { taskId: string }) {
  const [analysis, setAnalysis] = useState<PostRunAnalysisDetail | null>(null);
  const [eventCategory, setEventCategory] =
    useState<PostRunAnalysisEventCategory>("KEY");
  const [eventError, setEventError] = useState<string | null>(null);
  const [eventPage, setEventPage] = useState<PostRunAnalysisEventPage | null>(
    null,
  );
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingOlderEvents, setLoadingOlderEvents] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollGeneration, setPollGeneration] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const olderEventRequestRef = useRef(0);
  const eventScopeKey = `${analysis?.id ?? "none"}:${eventCategory}:${pollGeneration}`;
  const eventScopeRef = useRef(eventScopeKey);
  eventScopeRef.current = eventScopeKey;

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let current: PostRunAnalysisDetail | null = null;
    let eventCursor: string | null = null;
    const load = async () => {
      try {
        const query = eventCursor
          ? `?afterSequence=${encodeURIComponent(eventCursor)}`
          : "";
        const next = await consoleApi<PostRunAnalysisDetail | null>(
          `/tasks/${taskId}/post-run-analysis${query}`,
        );
        if (!active) return;
        if (!next) {
          current = null;
          eventCursor = null;
          setAnalysis(null);
          setError(null);
          timer = window.setTimeout(() => void load(), 15_000);
          return;
        }
        current =
          current && eventCursor && current.id === next.id
            ? {
                ...next,
                events: mergePostRunAnalysisEvents(current.events, next.events),
                eventsTruncated:
                  current.eventsTruncated || next.eventsTruncated,
              }
            : next;
        eventCursor = current.eventCursor;
        setAnalysis(current);
        setError(null);
        if (
          next.eventsHasMore ||
          !["SUCCEEDED", "FAILED", "CANCELLED"].includes(next.status)
        ) {
          timer = window.setTimeout(
            () => void load(),
            next.eventsHasMore ? 0 : 5_000,
          );
        }
      } catch (loadError) {
        if (!active) return;
        setError((loadError as Error).message);
        timer = window.setTimeout(() => void load(), 5_000);
      }
    };
    void load();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [pollGeneration, taskId]);

  useEffect(() => {
    let active = true;
    if (!analysis) {
      setEventPage(null);
      setEventError(null);
      setLoadingEvents(false);
      return () => {
        active = false;
      };
    }
    const analysisId = analysis.id;
    const requestId = ++olderEventRequestRef.current;
    setLoadingEvents(true);
    setLoadingOlderEvents(false);
    setEventError(null);
    setEventPage(null);
    void consoleApi<PostRunAnalysisEventPage>(
      `/tasks/${taskId}/post-run-analysis/events?category=${eventCategory}`,
    )
      .then((page) => {
        if (active && requestId === olderEventRequestRef.current) {
          setEventPage(
            mergePostRunAnalysisEventPage(null, page, {
              analysisId,
              category: eventCategory,
            }),
          );
        }
      })
      .catch((loadError: unknown) => {
        if (active) setEventError((loadError as Error).message);
      })
      .finally(() => {
        if (active) setLoadingEvents(false);
      });
    return () => {
      active = false;
    };
  }, [analysis?.id, eventCategory, pollGeneration, taskId]);

  const visibleEvents = useMemo(() => {
    const pageEvents =
      eventPage &&
      eventPage.analysisId === analysis?.id &&
      eventPage.category === eventCategory
        ? eventPage.events
        : [];
    const liveEvents = (analysis?.events ?? []).filter((event) =>
      analysisEventMatches(event, eventCategory),
    );
    return mergePostRunAnalysisEvents(pageEvents, liveEvents);
  }, [analysis?.events, analysis?.id, eventCategory, eventPage]);
  const groupedEvents = useMemo(
    () => aggregateAnalysisEvents(visibleEvents),
    [visibleEvents],
  );

  async function loadOlderEvents() {
    const analysisId = analysis?.id;
    const beforeSequence = visibleEvents.at(0)?.sequence;
    if (!analysisId || !beforeSequence) return;
    const category = eventCategory;
    const scopeKey = eventScopeRef.current;
    const requestId = ++olderEventRequestRef.current;
    setLoadingOlderEvents(true);
    setEventError(null);
    try {
      const page = await consoleApi<PostRunAnalysisEventPage>(
        `/tasks/${taskId}/post-run-analysis/events?category=${category}&beforeSequence=${encodeURIComponent(beforeSequence)}`,
      );
      if (
        requestId !== olderEventRequestRef.current ||
        scopeKey !== eventScopeRef.current
      ) {
        return;
      }
      setEventPage((current) =>
        mergePostRunAnalysisEventPage(current, page, {
          analysisId,
          category,
        }),
      );
    } catch (loadError) {
      if (
        requestId === olderEventRequestRef.current &&
        scopeKey === eventScopeRef.current
      ) {
        setEventError((loadError as Error).message);
      }
    } finally {
      if (requestId === olderEventRequestRef.current) {
        setLoadingOlderEvents(false);
      }
    }
  }

  async function retry() {
    setRetrying(true);
    setError(null);
    try {
      const next = await consoleApi<PostRunAnalysisDetail | null>(
        `/tasks/${taskId}/post-run-analysis/retry`,
        { method: "POST" },
      );
      setAnalysis(next);
      setPollGeneration((generation) => generation + 1);
    } catch (retryError) {
      setError((retryError as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Card className="dp-task-input-card dp-post-run-analysis">
      <div className="dp-section-head">
        <span>
          <FileSearch />
          <b>运行后自动优化分析</b>
        </span>
        {analysis ? (
          <Badge tone={tone(analysis.status)}>
            {displayLabel(analysis.status)}
          </Badge>
        ) : null}
      </div>
      {error ? <FormMessage message={error} tone="error" /> : null}
      {analysis ? (
        <>
          <div className="dp-post-run-analysis-meta">
            <span>
              分析器 <b>{analysis.analyzerVersion}</b>
            </span>
            <span>
              运行代 <b>{analysis.generation}</b>
            </span>
            <span>
              尝试{" "}
              <b>
                {analysis.attemptNumber}/{analysis.maxAttempts}
              </b>
            </span>
            {analysis.input ? (
              <span>
                日志包{" "}
                <b>
                  {analysis.input.schemaVersion} ·{" "}
                  {formatByteSize(analysis.input.byteSize)}
                </b>
              </span>
            ) : (
              <span>正在等待日志与制品收口</span>
            )}
          </div>
          <section className="dp-post-run-analysis-overview">
            <div className="dp-post-run-analysis-overview-head">
              <span>
                <Activity />
                <b>{analysis.progress.phaseLabel}</b>
              </span>
              <small>
                最近活动{" "}
                {new Date(analysis.progress.lastActivityAt).toLocaleTimeString(
                  "zh-CN",
                  { hour12: false },
                )}
              </small>
            </div>
            <p>{analysis.progress.currentMessage}</p>
            <div className="dp-post-run-analysis-steps">
              {analysis.progress.steps.map((step) => (
                <div
                  className={`is-${step.status.toLowerCase()}`}
                  key={step.key}
                >
                  <i aria-hidden="true" />
                  <span>{step.label}</span>
                </div>
              ))}
            </div>
            <div className="dp-post-run-analysis-kpis">
              <div>
                <small>总耗时</small>
                <b>{formatAnalysisDuration(analysis.progress.elapsedMs)}</b>
              </div>
              <div>
                <small>排队等待</small>
                <b>
                  {analysis.progress.queueWaitMs === null
                    ? "—"
                    : formatAnalysisDuration(analysis.progress.queueWaitMs)}
                </b>
              </div>
              <div>
                <small>模型调用</small>
                <b>
                  {formatAnalysisNumber(analysis.progress.metrics.modelCalls)}{" "}
                  次
                  {analysis.progress.metrics.modelDurationMs
                    ? ` · ${formatAnalysisDuration(
                        analysis.progress.metrics.modelDurationMs,
                      )}`
                    : ""}
                  {analysis.progress.metrics.failedModelCalls
                    ? ` · ${formatAnalysisNumber(
                        analysis.progress.metrics.failedModelCalls,
                      )} 失败`
                    : ""}
                </b>
              </div>
              <div>
                <small>已核验证据</small>
                <b>
                  {formatAnalysisNumber(
                    analysis.progress.metrics.uniqueEvidence,
                  )}
                </b>
              </div>
              <div>
                <small>Token 输入 / 输出</small>
                <b>
                  {formatAnalysisNumber(analysis.progress.metrics.inputTokens)}{" "}
                  /{" "}
                  {formatAnalysisNumber(analysis.progress.metrics.outputTokens)}
                </b>
              </div>
              <div>
                <small>分析发现</small>
                <b>{formatAnalysisNumber(analysis.progress.findingCount)}</b>
              </div>
            </div>
            {!["SUCCEEDED", "FAILED", "CANCELLED"].includes(analysis.status) ? (
              <small className="dp-post-run-analysis-deadline">
                当前期限剩余{" "}
                {formatAnalysisDuration(analysis.progress.deadlineRemainingMs)}
              </small>
            ) : null}
          </section>
          {analysis.error ? (
            <div className="dp-post-run-analysis-alert">
              <XCircle />
              <div>
                <b>{analysisErrorTitle(analysis.error)}</b>
                <p>{analysisErrorMessage(analysis.error)}</p>
              </div>
            </div>
          ) : null}
          <div className="dp-run-technical-body dp-post-run-analysis-body">
            {analysis.input ? (
              <details className="dp-run-technical-details dp-post-run-analysis-details">
                <summary>
                  <span>
                    <ScrollText />
                    <b>日志包完整性</b>
                  </span>
                  <ChevronDown />
                </summary>
                <pre>{prettyValue(analysis.input.completeness)}</pre>
              </details>
            ) : null}
            {analysis.events.length || eventPage?.events.length ? (
              <details className="dp-run-technical-details dp-post-run-analysis-details">
                <summary>
                  <span>
                    <Activity />
                    <b>技术事件</b>
                    <small>
                      {groupedEvents.length} 组 · {visibleEvents.length} 条事件
                      {eventPage?.hasMore ? " · 可加载更早记录" : ""}
                    </small>
                  </span>
                  <ChevronDown />
                </summary>
                <div className="dp-post-run-analysis-event-tools">
                  <div role="tablist" aria-label="分析事件筛选">
                    {analysisEventFilters.map((filter) => (
                      <button
                        aria-selected={eventCategory === filter.key}
                        className={
                          eventCategory === filter.key ? "is-active" : ""
                        }
                        key={filter.key}
                        onClick={() => setEventCategory(filter.key)}
                        role="tab"
                        type="button"
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                  {loadingEvents ? <small>正在加载事件…</small> : null}
                </div>
                {eventError ? (
                  <FormMessage message={eventError} tone="error" />
                ) : null}
                <div className="dp-post-run-analysis-events">
                  {groupedEvents.map((group) => (
                    <article key={group.id}>
                      <header>
                        <span>
                          <strong>
                            {group.title ?? displayLabel(group.kind)}
                          </strong>
                          <small>
                            {group.meta ? `${group.meta} · ` : ""}
                            {group.actor} · #{group.sequence}
                          </small>
                        </span>
                        <time dateTime={group.occurredAt}>
                          {new Date(group.occurredAt).toLocaleTimeString(
                            "zh-CN",
                            { hour12: false },
                          )}
                        </time>
                      </header>
                      {group.summary ? <p>{group.summary}</p> : null}
                      {hasDisplayPayload(group.payload) ? (
                        <details className="dp-post-run-analysis-event-raw">
                          <summary>查看原始数据</summary>
                          <pre>{prettyValue(group.payload)}</pre>
                        </details>
                      ) : null}
                    </article>
                  ))}
                  {!loadingEvents && !groupedEvents.length ? (
                    <p className="dp-post-run-analysis-event-empty">
                      当前筛选条件下没有事件。
                    </p>
                  ) : null}
                </div>
                {eventPage?.hasMore ? (
                  <div className="dp-post-run-analysis-event-more">
                    <Button
                      disabled={loadingOlderEvents}
                      onClick={() => void loadOlderEvents()}
                      size="sm"
                      variant="secondary"
                    >
                      {loadingOlderEvents ? "正在加载…" : "加载更早事件"}
                    </Button>
                  </div>
                ) : null}
              </details>
            ) : null}
            {analysis.error ? (
              <details className="dp-run-technical-details dp-post-run-analysis-details">
                <summary>
                  <span>
                    <XCircle />
                    <b>分析失败原因</b>
                  </span>
                  <ChevronDown />
                </summary>
                <pre>{prettyValue(analysis.error)}</pre>
              </details>
            ) : null}
            {analysis.findings.length ? (
              <div className="dp-post-run-analysis-findings">
                {analysis.findings.map((finding) => (
                  <article
                    className="dp-post-run-analysis-finding"
                    key={finding.id}
                  >
                    <div>
                      <Badge tone={tone(finding.severity)}>
                        {finding.severity}
                      </Badge>
                      <strong>{finding.title}</strong>
                    </div>
                    <p>{finding.impact}</p>
                    <small>
                      {finding.category} · {finding.component} · 置信度{" "}
                      {finding.confidence.toFixed(2)}
                    </small>
                    <small>
                      阶段 {finding.phase} · {finding.failureClass}
                      {finding.attemptNumber
                        ? ` · Attempt #${finding.attemptNumber}`
                        : ""}
                      {finding.runId
                        ? ` · Run ${finding.runId.slice(0, 8)}`
                        : ""}
                      {finding.runtimeId
                        ? ` · Runtime ${finding.runtimeId.slice(0, 8)}`
                        : ""}
                    </small>
                    <details className="dp-run-technical-details dp-post-run-analysis-details">
                      <summary>
                        <span>
                          <FileSearch />
                          <b>根因、建议与证据</b>
                        </span>
                        <ChevronDown />
                      </summary>
                      <pre>
                        {prettyValue({
                          evidenceRefs: finding.evidenceRefs,
                          recommendation: finding.recommendation,
                          rootCause: finding.rootCause,
                        })}
                      </pre>
                    </details>
                  </article>
                ))}
              </div>
            ) : analysis.status === "SUCCEEDED" ? (
              <p className="dp-post-run-analysis-empty">
                本次分析没有发现达到置信度阈值的可执行问题。
              </p>
            ) : null}
            {analysis.workItem ? (
              <details className="dp-run-technical-details dp-post-run-analysis-details">
                <summary>
                  <span>
                    <FileSearch />
                    <b>
                      改进任务：{analysis.workItem.title}（
                      {analysis.workItem.status}）
                    </b>
                  </span>
                  <ChevronDown />
                </summary>
                <pre>{analysis.workItem.body}</pre>
              </details>
            ) : null}
            {analysis.status === "FAILED" ? (
              <div className="dp-post-run-analysis-actions">
                <Button
                  disabled={retrying}
                  onClick={() => void retry()}
                  size="sm"
                  variant="secondary"
                >
                  <RefreshCw /> {retrying ? "正在重试…" : "重试自动分析"}
                </Button>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div className="dp-run-technical-body dp-post-run-analysis-body">
          <p className="dp-post-run-analysis-empty">
            暂无自动优化分析记录。系统会继续等待补偿任务，也可以立即开始分析。
          </p>
          <div className="dp-post-run-analysis-actions">
            <Button
              disabled={retrying}
              onClick={() => void retry()}
              size="sm"
              variant="secondary"
            >
              <RefreshCw /> {retrying ? "正在启动…" : "开始自动分析"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function hasDisplayPayload(value: unknown) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function formatAnalysisDuration(milliseconds: number) {
  if (milliseconds < 1_000)
    return `${Math.max(0, Math.round(milliseconds))} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)} 秒`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function formatAnalysisNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function analysisErrorTitle(value: unknown) {
  if (!isRecord(value)) return "自动优化分析未完成";
  return typeof value.code === "string"
    ? displayLabel(value.code)
    : "自动优化分析未完成";
}

function analysisErrorMessage(value: unknown) {
  if (!isRecord(value)) return "请展开技术详情查看失败信息。";
  return typeof value.message === "string"
    ? value.message
    : "请展开技术详情查看失败信息。";
}

function summarizeCaseExecution(testCase: TaskCase) {
  const executions = latestTaskCaseExecutions(testCase.executions);
  const active = executions.find(
    (execution) =>
      execution.run && !terminalLifecycles.has(execution.run.lifecycle),
  );
  const pending = executions.find((execution) => !execution.run);
  const outcomes = executions.flatMap((execution) =>
    execution.run ? [taskOutcomeDisplay(execution.run)] : [],
  );
  const aggregateOutcome =
    outcomes.find((outcome) => outcome.toneStatus === "FAILED") ??
    outcomes.find((outcome) => outcome.toneStatus === "INCONCLUSIVE") ??
    outcomes[0];
  const status =
    active?.run?.lifecycle ??
    pending?.dispatch.status ??
    aggregateOutcome?.toneStatus ??
    "PENDING";
  return {
    active,
    aggregateOutcome,
    dispatchStatus:
      pending?.dispatch.status ?? (executions.length ? "LINKED" : "PENDING"),
    executionStatus:
      active?.run?.lifecycle ??
      (executions.length && executions.every((execution) => execution.run)
        ? "COMPLETED"
        : "PENDING"),
    executions,
    pending,
    status,
  };
}

function SpecificationSnapshot({ detail }: { detail: TaskDetail }) {
  const analysis = detail.stages.find(
    (stage) => stage.type === "SPEC_ANALYSIS",
  );
  const emptyMessage =
    detail.kind === "DIRECT_RUN"
      ? "直接任务不需要生成 Spec。"
      : detail.lifecycle === "CANCELLED"
        ? "任务在分析完成前已取消；未完成的 Spec 不会保存或展示。"
        : analysis?.status === "FAILED"
          ? "Spec 分析失败，没有生成可执行的 Case。"
          : "分析 Worker 尚未生成 Spec。";
  return (
    <details className="dp-verification-detail dp-specification-snapshot">
      <summary className="dp-specification-snapshot-summary">
        <FileSearch />
        <span>
          <b>Spec 分析快照</b>
          <small>{detail.specification?.summary ?? emptyMessage}</small>
        </span>
        <Badge tone={tone(analysis?.status ?? "PENDING")}>
          {displayLabel(analysis?.status ?? "PENDING")}
        </Badge>
        <ChevronDown className="dp-specification-snapshot-chevron" />
      </summary>
      <div className="dp-specification-snapshot-body">
        {detail.specification ? (
          <>
            <div className="dp-specification-facts">
              <p>{detail.specification.summary}</p>
              <p>
                Generator: {detail.specification.generatorKind} ·{" "}
                {detail.specification.generatorVersion}
              </p>
              <code>{detail.specification.sourceHash}</code>
            </div>
            {detail.specification.diagnostics.length ? (
              <div className="dp-specification-diagnostics">
                {detail.specification.diagnostics.map((diagnostic, index) => (
                  <div
                    key={`${diagnostic.source}:${diagnostic.code}:${diagnostic.reference ?? "none"}:${index}`}
                  >
                    <span>
                      <Badge
                        tone={
                          diagnostic.level === "ERROR"
                            ? "danger"
                            : diagnostic.level === "WARNING"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {displayLabel(diagnostic.level)}
                      </Badge>
                      {diagnostic.source} · {diagnostic.code}
                    </span>
                    <p>{diagnostic.message}</p>
                  </div>
                ))}
              </div>
            ) : null}
            {detail.specification.primaryPullRequestUrl ? (
              <a
                className="dp-specification-external-link"
                href={detail.specification.primaryPullRequestUrl}
                rel="noreferrer"
                target="_blank"
              >
                查看关联 Pull Request <ExternalLink />
              </a>
            ) : null}
          </>
        ) : (
          <p className="dp-task-empty-copy">{emptyMessage}</p>
        )}
      </div>
    </details>
  );
}

function CaseCard({
  busy,
  canRerun,
  onRerun,
  testCase,
}: {
  busy: boolean;
  canRerun: boolean;
  onRerun: () => void;
  testCase: TaskCase;
}) {
  const {
    active,
    aggregateOutcome,
    dispatchStatus,
    executionStatus,
    executions,
    pending,
    status,
  } = summarizeCaseExecution(testCase);
  const rerunnable =
    executions.length > 0 &&
    executions.every(
      (execution) =>
        execution.run && terminalLifecycles.has(execution.run.lifecycle),
    );
  return (
    <details className="dp-verification-detail dp-specification-case">
      <summary className="dp-specification-case-summary">
        <ChevronDown className="dp-specification-case-chevron" />
        <span>
          <b>
            {testCase.position + 1}. {testCase.name}
          </b>
          <small>
            {testCase.definition.criteria?.length ?? 0} 条验收 ·{" "}
            {testCase.executions.length} 个 Runtime
          </small>
        </span>
        <Badge tone={tone(status)}>
          {active || pending
            ? displayLabel(status)
            : (aggregateOutcome?.label ?? displayLabel(status))}
        </Badge>
      </summary>
      <div className="dp-spec-run-state">
        <span>
          派发 <b>{displayLabel(dispatchStatus)}</b>
        </span>
        <span>
          执行 <b>{displayLabel(executionStatus)}</b>
        </span>
        <span>
          判定{" "}
          <b>{aggregateOutcome?.label ?? verificationVerdictLabel(null)}</b>
        </span>
      </div>
      <div className="dp-specification-case-body">
        <p>
          {(
            testCase.definition.criteria?.map(
              (criterion) => criterion.description,
            ) ??
            testCase.definition.expected ??
            []
          ).join("；")}
        </p>
        <small>
          {testCase.definition.steps
            .map(
              (step) =>
                `${step.order}. ${step.action}${
                  step.expectedObservation
                    ? `（预期：${step.expectedObservation}）`
                    : ""
                }`,
            )
            .join(" → ")}
        </small>
        {testCase.executions.map((item) => (
          <CaseExecutionLink execution={item} key={item.id} />
        ))}
        {rerunnable ? (
          <div className="dp-specification-case-actions">
            <Button
              disabled={busy || !canRerun}
              onClick={() => {
                if (
                  window.confirm(
                    "确认重跑该 Spec Runtime？当前执行及证据会保留，并新建一次执行。",
                  )
                ) {
                  onRerun();
                }
              }}
              size="sm"
              title={
                canRerun
                  ? "保留当前记录并创建新的 Runtime"
                  : "任务已取消或剩余时间不足，无法重跑 Runtime"
              }
              variant="secondary"
            >
              <RotateCcw /> 重跑 Runtime
            </Button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function CaseExecutionLink({ execution }: { execution: TaskCaseExecution }) {
  const status = execution.run?.lifecycle ?? execution.dispatch.status;
  const outcome = execution.run ? taskOutcomeDisplay(execution.run) : null;
  const content = (
    <>
      <span>
        <b>{execution.deployment.name}</b>
        <small>
          Runtime #{execution.executionOrdinal} ·{" "}
          {execution.deployment.targetUrl}
        </small>
      </span>
      {execution.run ? (
        <small>
          尝试 {execution.run.currentAttemptNumber}/{execution.run.maxAttempts}{" "}
          · 证据 {execution.run.evidenceCount}
        </small>
      ) : (
        <small>派发尝试 {execution.dispatch.attempts}</small>
      )}
      <Badge tone={tone(outcome?.toneStatus ?? status)}>
        {outcome?.label ?? displayLabel(status)}
      </Badge>
      {execution.run ? <ExternalLink /> : null}
    </>
  );
  if (execution.run) {
    return (
      <Link
        className="dp-spec-runtime-row"
        href={`/console/executions/${execution.run.runId}`}
      >
        {content}
      </Link>
    );
  }
  const failure = errorMessage(execution.dispatch.lastError);
  return (
    <div className="dp-spec-runtime-pending">
      <div className="dp-spec-runtime-row">{content}</div>
      {failure ? (
        <small className="dp-spec-dispatch-error">{failure}</small>
      ) : null}
    </div>
  );
}

function latestTaskCaseExecutions(executions: readonly TaskCaseExecution[]) {
  const latest = new Map<string, TaskCaseExecution>();
  for (const execution of executions) {
    const previous = latest.get(execution.deployment.id);
    if (!previous || execution.executionOrdinal > previous.executionOrdinal) {
      latest.set(execution.deployment.id, execution);
    }
  }
  return [...latest.values()];
}

function StageCard({
  allowRetry,
  busy,
  index,
  onRetry,
  stage,
}: {
  allowRetry: boolean;
  busy: boolean;
  index: number;
  onRetry: () => void;
  stage: TaskStage;
}) {
  const retryable =
    allowRetry &&
    stage.type !== "PROFILE_RESOLUTION" &&
    stage.status === "FAILED";
  return (
    <Card
      className={`dp-task-stage ${stage.status === "RUNNING" ? "is-active" : ""}`}
    >
      <div className="dp-task-stage-number">{index}</div>
      <div>
        <small>{displayLabel(stage.type)}</small>
        <b>
          {stage.type === "SPEC_ANALYSIS"
            ? "分析 Issue 并生成 Spec Case"
            : stage.type === "PROFILE_RESOLUTION"
              ? "解析用户、授权域名并预约浏览器身份"
              : "派发 Case 并聚合执行结果"}
        </b>
        <span>
          尝试 {stage.currentAttemptNumber}/{stage.maxAttempts}
          {stage.waitingReason ? ` · ${displayLabel(stage.waitingReason)}` : ""}
        </span>
      </div>
      <Badge tone={tone(stage.status)}>{displayLabel(stage.status)}</Badge>
      {retryable ? (
        <Button disabled={busy} onClick={onRetry} variant="secondary">
          <RotateCcw /> 重试阶段
        </Button>
      ) : null}
    </Card>
  );
}

function RunLinkCard({
  name,
  run,
}: {
  name: string;
  run: TaskDetail["runs"][number];
}) {
  const outcome = taskOutcomeDisplay(run);
  return (
    <Card className="dp-verification-detail dp-specification-case">
      <div className="dp-section-head">
        <span>
          <b>{name}</b>
        </span>
        <Badge tone={tone(outcome.toneStatus)}>{outcome.label}</Badge>
      </div>
      <div className="dp-specification-case-body">
        <small>
          {displayLabel(run.lifecycle)} · 尝试 {run.currentAttemptNumber}/
          {run.maxAttempts} · 证据 {run.evidenceCount} · 人工操作{" "}
          {run.interventionCount}
        </small>
        <Link href={`/console/executions/${run.runId}`}>
          查看执行详情 <ExternalLink />
        </Link>
      </div>
    </Card>
  );
}

function projectSpecGenerationTrajectory(
  detail: TaskDetail,
  events: TaskEvent[],
): RunTrajectoryRecord[] {
  const analysis = detail.stages.find(
    (stage) => stage.type === "SPEC_ANALYSIS",
  );
  const eventRecords = events
    .filter((event) => specGenerationEvent(event, analysis?.status))
    .map((event): RunTrajectoryRecord => {
      if (event.kind.startsWith("agent.")) {
        return projectAgentTaskEvent(event);
      }
      const payload = isRecord(event.payload) ? event.payload : {};
      const attemptNumber =
        typeof payload.attemptNumber === "number" && payload.attemptNumber > 0
          ? Math.floor(payload.attemptNumber)
          : null;
      return {
        actor: event.actor,
        attemptNumber,
        callId: null,
        completedAt: event.occurredAt,
        durationMs: null,
        error: errorMessage(payload.error),
        id: `task:${event.sequence}`,
        input: event.kind === "task.created" ? payload : null,
        kind: "INPUT",
        lane: "INPUT",
        metadata: { scope: "TASK", taskEventSequence: event.sequence },
        output: event.kind === "task.created" ? null : payload,
        segmentId: null,
        sequence: event.sequence,
        startedAt: event.occurredAt,
        status: taskEventStatus(event.kind),
        step: null,
        title: displayLabel(event.kind),
      };
    });
  const attemptRecords = (analysis?.attempts ?? []).map(
    (attempt): RunTrajectoryRecord => {
      const startedAt = attempt.startedAt ?? detail.createdAt;
      const completedAt = attempt.finishedAt;
      const durationMs = completedAt
        ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
        : null;
      return {
        actor: "SPEC_ANALYSIS_WORKER",
        attemptNumber: attempt.number,
        callId: null,
        completedAt,
        durationMs,
        error: trajectoryError(attempt.error),
        id: `analysis:${attempt.id}`,
        input: detail.input,
        kind: "RUNTIME",
        lane: "INPUT",
        metadata: { stage: "SPEC_ANALYSIS", status: attempt.status },
        output: attempt.result,
        segmentId: null,
        sequence: "0",
        startedAt,
        status: trajectoryStatus(attempt.status),
        step: null,
        title: `Spec 生成 · Attempt ${attempt.number}`,
      };
    },
  );
  return [...eventRecords, ...attemptRecords]
    .sort(
      (left, right) =>
        Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
        left.id.localeCompare(right.id),
    )
    .map((record, index) => ({ ...record, sequence: String(index + 1) }));
}

function specGenerationEvent(event: TaskEvent, analysisStatus?: string) {
  if (
    [
      "task.created",
      "task.rerun.created",
      "task.rerun.linked",
      "task.spec.shadow_compared",
    ].includes(event.kind)
  ) {
    return true;
  }
  const payload = isRecord(event.payload) ? event.payload : {};
  if (event.kind.startsWith("agent.") && payload.stage === "SPEC_ANALYSIS") {
    return true;
  }
  if (
    event.kind.startsWith("task.stage.") &&
    payload.stage === "SPEC_ANALYSIS"
  ) {
    return true;
  }
  return (
    analysisStatus !== "SUCCEEDED" &&
    ["task.cancel_requested", "task.completed", "task.timed_out"].includes(
      event.kind,
    )
  );
}

function projectAgentTaskEvent(event: TaskEvent): RunTrajectoryRecord {
  const payload = isRecord(event.payload) ? event.payload : {};
  const durationMs =
    typeof payload.durationMs === "number" && payload.durationMs >= 0
      ? Math.floor(payload.durationMs)
      : null;
  const completed = /(?:completed|failed|generated|validation_failed)$/u.test(
    event.kind,
  );
  const occurredAtMs = Date.parse(event.occurredAt);
  const startedAt = new Date(
    Math.max(0, occurredAtMs - (completed ? (durationMs ?? 0) : 0)),
  ).toISOString();
  const isAnalysis = event.kind === "agent.analysis.completed";
  const isModel = event.kind.startsWith("agent.model.");
  const isTool = event.kind.startsWith("agent.tool.");
  const input =
    payload.inputPreview ??
    (isAnalysis
      ? null
      : event.kind === "agent.segment.started"
        ? payload
        : null);
  const output = isAnalysis
    ? {
        sourceRefs: payload.sourceRefs ?? [],
        summary: payload.summary ?? null,
      }
    : (payload.outputPreview ??
      (event.kind === "agent.spec.generated"
        ? {
            caseCount: payload.caseCount,
            sourceRefs: payload.sourceRefs,
          }
        : null));
  return {
    actor: event.actor,
    attemptNumber:
      typeof payload.attemptNumber === "number" && payload.attemptNumber > 0
        ? Math.floor(payload.attemptNumber)
        : null,
    callId: typeof payload.callId === "string" ? payload.callId : null,
    completedAt: completed ? event.occurredAt : null,
    durationMs,
    error:
      typeof payload.errorMessage === "string" ? payload.errorMessage : null,
    id: `task:${event.sequence}`,
    input,
    kind: isAnalysis
      ? "ANALYSIS"
      : isModel
        ? "MODEL"
        : isTool
          ? "TOOL"
          : "RUNTIME",
    lane: isAnalysis
      ? "ANALYSIS"
      : isModel
        ? "MODEL"
        : isTool
          ? "TOOLS"
          : "INPUT",
    metadata: {
      ...(typeof payload.model === "string" ? { model: payload.model } : {}),
      ...(typeof payload.provider === "string"
        ? { provider: payload.provider }
        : {}),
      ...(payload.usage ? { usage: payload.usage } : {}),
      stage: "SPEC_ANALYSIS",
      stageAttemptId: payload.stageAttemptId ?? null,
      taskEventSequence: event.sequence,
    },
    output,
    segmentId: typeof payload.segmentId === "string" ? payload.segmentId : null,
    sequence: event.sequence,
    startedAt,
    status:
      payload.status === "FAILED" ||
      /failed|validation_failed/iu.test(event.kind)
        ? "FAILED"
        : payload.status === "WAITING_HUMAN"
          ? "WAITING_HUMAN"
          : /started/iu.test(event.kind)
            ? "RUNNING"
            : "SUCCEEDED",
    step:
      typeof payload.step === "number" && payload.step > 0
        ? Math.floor(payload.step)
        : null,
    title: agentEventTitle(event.kind, payload),
  };
}

function agentEventTitle(kind: string, payload: Record<string, unknown>) {
  if (kind === "agent.analysis.completed") return "Agent 分析";
  if (kind.startsWith("agent.model.")) {
    return `模型 ${displayLabel(kind.split(".").at(-1) ?? kind)}`;
  }
  if (kind.startsWith("agent.tool.")) {
    const name = typeof payload.name === "string" ? payload.name : "Tool";
    return `${name} · ${displayLabel(kind.split(".").at(-1) ?? kind)}`;
  }
  if (kind === "agent.spec.validation_failed") return "Spec 校验失败";
  if (kind === "agent.spec.generated") return "Spec 已生成";
  if (kind === "agent.segment.started") return "Spec Agent 开始";
  if (kind === "agent.segment.completed") return "Spec Agent 完成";
  return displayLabel(kind);
}

function trajectoryError(error: unknown) {
  if (error === null || error === undefined) return null;
  return errorMessage(error) ?? prettyValue(error);
}

function trajectoryStatus(status: string): RunTrajectoryRecord["status"] {
  if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(status)) return "FAILED";
  if (status === "SUCCEEDED") return "SUCCEEDED";
  if (["PENDING", "RUNNING"].includes(status)) return "RUNNING";
  return "INFO";
}

function taskEventStatus(kind: string): RunTrajectoryRecord["status"] {
  if (/failed|cancelled|timed_out/iu.test(kind)) return "FAILED";
  if (/waiting/iu.test(kind)) return "WAITING_HUMAN";
  if (/started|queued/iu.test(kind)) return "RUNNING";
  if (/succeeded|completed|created|provided|linked/iu.test(kind))
    return "SUCCEEDED";
  return "INFO";
}
