"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/native-select";
import type {
  ExecutionConcurrencyPolicy,
  RunTrajectoryRecord,
} from "@devproof/contracts";
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
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { PageHeader } from "@/components/page-header";
import {
  ErrorState,
  FormMessage,
  LoadingState,
} from "@/components/settings-layout";
import { consoleApi } from "@/lib/api";
import { displayLabel } from "@/lib/display-text";
import { retainedProfilePolicy } from "./profile-policy";
import { RunTrajectory } from "./run-trajectory";
import { projectSpecGenerationTrajectory } from "./spec-generation-trajectory";
import {
  executionSchedulingLabel,
  concurrencyPolicyExplanation,
  schedulingWaitText,
  taskOutcomeDisplay,
  verificationVerdictLabel,
} from "./task-outcome";
import type {
  TaskCase,
  TaskCaseExecution,
  TaskDetail,
  TaskEvent,
  TaskScheduling,
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
      "READY",
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
          <div className="dp-task-empty">
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
  const [trajectory, setTrajectory] = useState<RunTrajectoryRecord[]>([]);
  const [view, setView] = useState<"logs" | "specs">("specs");
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
            {displayLabel(displayed.currentStage)} · 已结束{" "}
            {displayed.counts.terminal ??
              displayed.counts.passed +
                displayed.counts.failed +
                displayed.counts.inconclusive}
            /{displayed.counts.total} · 执行 {displayed.counts.running} · 等待{" "}
            {displayed.counts.waiting}
            {displayed.counts.recovering
              ? ` · 恢复 ${displayed.counts.recovering}`
              : ""}
            {displayed.counts.timedOut
              ? ` · 超时 ${displayed.counts.timedOut}`
              : ""}{" "}
            · {new Date(displayed.createdAt).toLocaleString("zh-CN")}
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
  view: "logs" | "specs";
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
  const profileNeedsInput = detail.profileBinding?.status === "WAITING_INPUT";
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
      !profileNeedsInput
    )
      return;
    void consoleApi<Array<{ displayName: string; id: string; status: string }>>(
      "/browser-profiles",
    ).then(setProfiles);
  }, [detail.waitingReason, profileNeedsInput]);

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
            <div className="dp-task-form">
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

        {profileNeedsInput && detail.profileBinding?.requestedProfile ? (
          <Card className="dp-task-input-card">
            <div className="dp-section-head">
              <span>
                <PlayCircle />
                <b>完成网页登录</b>
              </span>
              <Badge tone="warning">等待浏览器身份所有人</Badge>
            </div>
            <div className="dp-task-form">
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
        ) : profileNeedsInput ? (
          <Card className="dp-task-input-card">
            <div className="dp-section-head">
              <span>
                <PlayCircle />
                <b>选择浏览器登录身份</b>
              </span>
              <Badge tone="warning">等待浏览器身份</Badge>
            </div>
            <div className="dp-task-form">
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
                    allCases={detail.cases}
                    busy={busy}
                    canRerun={
                      detail.cancelRequestedAt === null &&
                      new Date(detail.deadlineAt).getTime() - Date.now() >=
                        30_000
                    }
                    key={testCase.id}
                    onRerun={() => void onMutate(`/cases/${testCase.id}/rerun`)}
                    onSavePolicy={(executionId, policy) =>
                      onMutate(`/cases/${executionId}/policy`, policy)
                    }
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
            <b>
              {detail.kind === "ISSUE_SPEC"
                ? "Spec 分析日志"
                : "浏览器执行日志"}
            </b>
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
        <p className="dp-task-empty-copy">
          {detail.kind === "ISSUE_SPEC"
            ? "此处显示 Spec 分析事件，事件数量不等于检查次数。"
            : ""}
          浏览器操作与截图请查看下方各用例的执行日志；导出全部日志包含任务和所有用例。
        </p>
        {detail.runs.map((run, index) => (
          <RunLinkCard
            key={run.runId}
            name={`浏览器执行 ${index + 1}`}
            run={run}
          />
        ))}
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
    </>
  );
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
  allCases,
  busy,
  canRerun,
  onRerun,
  onSavePolicy,
  testCase,
}: {
  allCases: TaskCase[];
  busy: boolean;
  canRerun: boolean;
  onRerun: () => void;
  onSavePolicy: (
    executionId: string,
    policy: ExecutionConcurrencyPolicy,
  ) => Promise<unknown>;
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
            ? executionSchedulingLabel(active ?? pending!)
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
          <div key={item.id}>
            <CaseExecutionLink execution={item} />
            {!item.run &&
            ["PENDING", "FAILED"].includes(item.dispatch.status) &&
            item.dispatch.attempts < 3 &&
            canRerun ? (
              <CasePolicyEditor
                busy={busy}
                execution={item}
                otherCases={allCases.filter((peer) => peer.id !== testCase.id)}
                onSave={(policy) => onSavePolicy(item.id, policy)}
              />
            ) : null}
          </div>
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
          {execution.run.infrastructureRecoveryCount
            ? ` · 失租恢复 ${execution.run.infrastructureRecoveryCount}`
            : ""}
        </small>
      ) : (
        <small>
          {displayLabel(execution.executionPolicy?.accessMode ?? "UNKNOWN")}
        </small>
      )}
      <Badge tone={tone(outcome?.toneStatus ?? status)}>
        {executionSchedulingLabel(execution)}
      </Badge>
      {execution.run ? <ExternalLink /> : null}
    </>
  );
  if (execution.run) {
    return (
      <div className="dp-spec-runtime-pending">
        <Link
          className="dp-spec-runtime-row"
          href={`/console/executions/${execution.run.runId}`}
        >
          {content}
        </Link>
        <SchedulingExplanation scheduling={execution.scheduling} />
        <small>
          {concurrencyPolicyExplanation(execution.executionPolicy?.accessMode)}
        </small>
      </div>
    );
  }
  const failure = errorMessage(execution.dispatch.lastError);
  return (
    <div className="dp-spec-runtime-pending">
      <div className="dp-spec-runtime-row">{content}</div>
      <SchedulingExplanation scheduling={execution.scheduling} />
      <details>
        <summary>派发详情</summary>
        <small>派发尝试 {execution.dispatch.attempts}</small>
      </details>
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

function SchedulingExplanation({
  scheduling,
}: {
  scheduling: TaskScheduling | undefined;
}) {
  const waitText = schedulingWaitText(scheduling);
  if (!scheduling || !waitText) return null;
  return (
    <small className="dp-spec-dispatch-error">
      {waitText}
      {scheduling.queue?.position
        ? ` · 当前队列第 ${scheduling.queue.position} 位`
        : ""}
      {scheduling.blockedBy?.runId ? (
        <>
          {" "}
          ·{" "}
          <Link href={`/console/executions/${scheduling.blockedBy.runId}`}>
            查看占用执行
          </Link>
        </>
      ) : scheduling.blockedBy?.taskId ? (
        ` · 占用任务 ${scheduling.blockedBy.taskId.slice(0, 8)}`
      ) : (
        ""
      )}
      {scheduling.blockedBy?.recoveryId ? (
        <>
          {" "}
          ·{" "}
          <Link
            href={`/console/access/recoveries/${scheduling.blockedBy.recoveryId}`}
          >
            查看会话恢复
          </Link>
        </>
      ) : null}
      {scheduling.nextRetryAt &&
      scheduling.blockedBy?.recoveryPhase !== "NEEDS_OPERATOR"
        ? ` · 下次重试 ${new Date(scheduling.nextRetryAt).toLocaleTimeString("zh-CN")}`
        : ""}
    </small>
  );
}

function CasePolicyEditor({
  execution,
  otherCases,
  busy,
  onSave,
}: {
  execution: TaskCaseExecution;
  otherCases: TaskCase[];
  busy: boolean;
  onSave: (policy: ExecutionConcurrencyPolicy) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<ExecutionConcurrencyPolicy["accessMode"]>(
    execution.executionPolicy?.accessMode ?? "UNKNOWN",
  );
  const [scopes, setScopes] = useState(
    (execution.executionPolicy?.resourceScopes ?? []).join(", "),
  );
  const [dependencies, setDependencies] = useState(
    execution.executionPolicy?.dependsOnCaseIds ?? [],
  );
  return (
    <details className="dp-spec-runtime-policy">
      <summary>
        执行策略 ·{" "}
        {displayLabel(execution.executionPolicy?.accessMode ?? "UNKNOWN")}
      </summary>
      <div className="dp-task-form">
        <Field
          label="业务数据访问"
          description="只有已核对不会修改共享业务数据的 Case 才能共享读并发；未知 Case 按独占执行。"
        >
          <Select
            value={mode}
            onChange={(event) =>
              setMode(
                event.target.value as ExecutionConcurrencyPolicy["accessMode"],
              )
            }
          >
            <option value="UNKNOWN">尚未核对</option>
            <option value="READ_ONLY">已核对只读</option>
            <option value="MUTATING">会修改业务数据</option>
          </Select>
        </Field>
        <Field
          label="业务资源范围"
          description="留空保护整个业务环境；可填写配置中的资源路径，多个以逗号分隔。"
        >
          <Input
            value={scopes}
            onChange={(event) => setScopes(event.target.value)}
            placeholder="例如 whitelist/model-mapping"
          />
        </Field>
        {otherCases.length ? (
          <fieldset>
            <legend>前置 Case（须在同一部署成功完成）</legend>
            {otherCases.map((peer) => (
              <label key={peer.id} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  checked={dependencies.includes(peer.id)}
                  onChange={(event) =>
                    setDependencies((current) =>
                      event.target.checked
                        ? [...current, peer.id]
                        : current.filter((id) => id !== peer.id),
                    )
                  }
                />{" "}
                {peer.position + 1}. {peer.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void onSave({
              accessMode: mode,
              resourceScopes: scopes
                .split(",")
                .map((scope) => scope.trim())
                .filter(Boolean),
              dependsOnCaseIds: dependencies,
            })
          }
        >
          保存执行策略
        </Button>
      </div>
    </details>
  );
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
              ? "解析用户、授权域名和浏览器登录身份"
              : "派发 Case 并聚合执行结果"}
        </b>
        <span>
          尝试 {stage.currentAttemptNumber}/{stage.maxAttempts}
          {stage.waitingReason ? ` · ${displayLabel(stage.waitingReason)}` : ""}
        </span>
      </div>
      <Badge tone={tone(stage.status)}>
        {displayLabel(
          stage.status === "RUNNING" && stage.waitingReason
            ? stage.waitingReason
            : stage.status,
        )}
      </Badge>
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
          {run.infrastructureRecoveryCount
            ? ` · 失租恢复 ${run.infrastructureRecoveryCount}`
            : ""}
        </small>
        <Link href={`/console/executions/${run.runId}`}>
          查看执行详情 <ExternalLink />
        </Link>
      </div>
    </Card>
  );
}
