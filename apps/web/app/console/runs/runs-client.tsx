"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RunTrajectoryPage,
  RunTrajectoryRecord,
} from "@devproof/contracts";
import {
  Activity,
  ArrowLeft,
  CircleCheckBig,
  Download,
  ExternalLink,
  Film,
  ImageIcon,
  Monitor,
  MonitorPlay,
  RefreshCw,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { Badge, Button, Card } from "@devproof/ui";

import { PageHeader } from "@/components/page-header";
import {
  EmptyState,
  ErrorState,
  FormMessage,
  LoadingState,
} from "@/components/settings-layout";
import { consoleApi } from "@/lib/api";
import { displayLabel } from "@/lib/display-text";
import { RunHitlBrowser } from "../verifications/verification-hitl-browser";
import { RunLiveBrowser } from "./run-live-browser";
import { RunTrajectory } from "./run-trajectory";

interface RunSummary {
  createdAt: string;
  currentAttemptNumber: number;
  executionDisposition: string | null;
  goal: string;
  id: string;
  lifecycle: string;
  maxAttempts: number;
  verdict: string | null;
}

interface RunDetail extends RunSummary {
  attempts: Array<{
    error: unknown;
    id: string;
    number: number;
    status: string;
  }>;
  browserExecutions: Array<{
    attemptId: string;
    id: string;
    runtimeSessionId: string | null;
    runtimeSession: {
      commands: Array<{
        commandType: string;
        createdAt: string;
        error: unknown;
        id: string;
        status: string;
      }>;
      events: Array<{
        id: string;
        kind: string;
        occurredAt: string;
      }>;
      id: string;
      profileMode: string;
      runtime: { id: string; name: string; status: string };
      status: string;
    } | null;
    status: string;
  }>;
  criteriaSnapshot: unknown;
  criterionResults: Array<{
    criterionId: string;
    evidenceRefs: string[];
    status: string;
    summary: string;
  }>;
  evidences: Array<{
    downloadUrl: string | null;
    externalId: string;
    id: string;
    kind: string;
    label: string;
    metadata: unknown;
    runtimeArtifact: {
      byteSize: number;
      contentType: string;
      sha256: string;
    } | null;
  }>;
  interventions: Array<{
    attemptId: string;
    expiresAt: string | null;
    id: string;
    kind: string;
    prompt: string;
    response: unknown;
    notifications: Array<{
      channel: string;
      deliveredAt: string | null;
      id: string;
      lastError: string | null;
      status: string;
    }>;
    status: string;
  }>;
  tasks: Array<{
    attemptId: string;
    error: unknown;
    id: string;
    provider: string;
    status: string;
  }>;
}

function tone(
  status: string | null,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "PASSED" || status === "SUCCEEDED" || status === "EXECUTED") {
    return "success";
  }
  if (
    status &&
    [
      "FAILED",
      "CANCELLED",
      "TIMED_OUT",
      "AGENT_ERROR",
      "PROVIDER_ERROR",
      "BROWSER_UNAVAILABLE",
      "RUNTIME_LOST",
    ].includes(status)
  ) {
    return "danger";
  }
  if (
    status &&
    ["QUEUED", "PREPARING", "RUNNING", "WAITING_HUMAN", "PENDING"].includes(
      status,
    )
  ) {
    return "warning";
  }
  return "neutral";
}

function compactRunTitle(run: RunSummary | null, limit = 108) {
  if (!run) return "任务详情";
  const goal = run.goal.replace(/\s+/gu, " ").trim();
  const summary = goal.split(/(?:Preconditions|Steps|Expected):/iu)[0]?.trim();
  const title = summary || goal;
  return title.length > limit ? `${title.slice(0, limit).trimEnd()}…` : title;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function businessReferenceUrl(evidence: RunDetail["evidences"][number]) {
  if (evidence.kind !== "BUSINESS_REFERENCE" || !isRecord(evidence.metadata)) {
    return null;
  }
  const value = evidence.metadata.url;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function evidenceMetadata(evidence: RunDetail["evidences"][number]) {
  return isRecord(evidence.metadata) ? evidence.metadata : {};
}

function isVideoEvidence(evidence: RunDetail["evidences"][number]) {
  return (
    evidence.kind === "VIDEO" ||
    evidence.runtimeArtifact?.contentType.startsWith("video/") === true
  );
}

function isStepScreenshot(evidence: RunDetail["evidences"][number]) {
  return (
    evidence.kind === "SCREENSHOT" &&
    evidenceMetadata(evidence).captureKind === "STEP"
  );
}

function stepIndex(evidence: RunDetail["evidences"][number]) {
  const value = evidenceMetadata(evidence).stepIndex;
  return typeof value === "number" ? value : Number.MAX_SAFE_INTEGER;
}

function stepCommand(evidence: RunDetail["evidences"][number]) {
  const value = evidenceMetadata(evidence).commandType;
  return typeof value === "string" ? value : "browser.step";
}

function formatByteSize(byteSize: number) {
  if (byteSize < 1_024) return `${byteSize} B`;
  if (byteSize < 1_048_576) return `${(byteSize / 1_024).toFixed(1)} KB`;
  return `${(byteSize / 1_048_576).toFixed(1)} MB`;
}

interface FailureSummary {
  code: string;
  detail: string;
  message: string;
  occurrences: number;
  raw: string;
  signature: string;
}

function summarizeTaskFailures(tasks: RunDetail["tasks"]): FailureSummary[] {
  const failures = new Map<string, FailureSummary>();
  for (const task of tasks) {
    if (!task.error) continue;
    const error = isRecord(task.error) ? task.error : {};
    const detail =
      typeof error.message === "string"
        ? error.message
        : typeof task.error === "string"
          ? task.error
          : "Runtime Task 执行失败。";
    const invalidToolSchema =
      /invalid schema for function|is not a valid format/iu.test(detail);
    const code =
      typeof error.code === "string" ? error.code : "RUNTIME_TASK_FAILED";
    const signature = `${code}:${detail}`;
    const existing = failures.get(signature);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    failures.set(signature, {
      code,
      detail,
      message: invalidToolSchema
        ? "Agent Runtime 的 browser_command 工具 Schema 不兼容，模型请求在执行浏览器命令前就被拒绝了；这不是 Browser Runtime 不可用。"
        : detail,
      occurrences: 1,
      raw: JSON.stringify(task.error, null, 2),
      signature,
    });
  }
  return [...failures.values()];
}

function hasInvalidToolSchemaFailure(failures: FailureSummary[]) {
  return failures.some((failure) =>
    /invalid schema for function|is not a valid format/iu.test(failure.detail),
  );
}

function runOutcome(
  detail: RunDetail,
  executionDisposition: string | null,
  failures: FailureSummary[],
  criteria: DisplayCriterion[],
) {
  if (detail.lifecycle === "RUNNING") {
    return {
      description: "浏览器正在执行验收步骤，页面会自动刷新最新进度。",
      label: "执行中",
      title: "正在验证",
      tone: "warning" as const,
    };
  }
  if (detail.lifecycle === "WAITING_HUMAN") {
    return {
      description: "自动化需要登录、验证码或其他人工操作，完成后会继续执行。",
      label: "需要处理",
      title: "等待人工继续",
      tone: "warning" as const,
    };
  }
  if (detail.lifecycle === "CANCELLED") {
    return {
      description: "任务已取消，现有证据和操作记录仍可查看。",
      label: "已取消",
      title: "验证没有完成",
      tone: "neutral" as const,
    };
  }
  if (detail.lifecycle === "TIMED_OUT") {
    return {
      description:
        failures[0]?.message ?? "任务超过执行时限，请检查运行记录后重试。",
      label: "已超时",
      title: "验证超时",
      tone: "danger" as const,
    };
  }
  if (detail.verdict === "PASSED") {
    return {
      description: "所有必需验收标准均已通过，完整操作过程已留存。",
      label: "已通过",
      title: "验证通过",
      tone: "success" as const,
    };
  }
  if (detail.verdict === "FAILED") {
    const failedCriterion = criteria.find(
      (criterion) => criterion.status === "FAILED",
    );
    return {
      description:
        failedCriterion?.summary ||
        failedCriterion?.description ||
        failures[0]?.message ||
        "至少一项必需验收标准未通过。",
      label: "未通过",
      title: "验证未通过",
      tone: "danger" as const,
    };
  }
  if (
    executionDisposition &&
    [
      "AGENT_ERROR",
      "PROVIDER_ERROR",
      "BROWSER_UNAVAILABLE",
      "RUNTIME_LOST",
    ].includes(executionDisposition)
  ) {
    return {
      description:
        failures[0]?.message ?? "执行环境异常，尚未得到可信的验收结论。",
      label: "执行异常",
      title: "暂时无法得出结论",
      tone: "danger" as const,
    };
  }
  return {
    description: "任务已结束，请结合验收标准和证据确认结果。",
    label: displayLabel(
      detail.verdict ?? executionDisposition ?? detail.lifecycle,
    ),
    title: "验证已完成",
    tone: "neutral" as const,
  };
}

export function RunsClient({ initialId }: { initialId?: string }) {
  return initialId ? <RunDetailClient id={initialId} /> : <RunListClient />;
}

function RunListClient() {
  const [rows, setRows] = useState<RunSummary[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setMessage(null);
    setLoading(true);
    try {
      setRows(await consoleApi<RunSummary[]>("/runs"));
    } catch (error) {
      setMessage((error as Error).message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  return (
    <>
      <PageHeader
        actions={
          <Button
            disabled={loading}
            onClick={() => void load().catch(() => undefined)}
            variant="secondary"
          >
            <RefreshCw />
            {loading ? "刷新中…" : "刷新"}
          </Button>
        }
        title="任务执行"
      />
      <Card className="dp-verification-list dp-verification-list-view">
        <div className="dp-section-head">
          <span>
            <Activity />
            <b>任务记录</b>
          </span>
          <span className="dp-count">{rows?.length ?? 0}</span>
        </div>
        {rows === null ? (
          message ? (
            <ErrorState
              message={message}
              onRetry={() => void load().catch(() => undefined)}
            />
          ) : (
            <LoadingState />
          )
        ) : rows.length === 0 ? (
          <EmptyState
            description="创建任务后，执行记录会显示在这里。"
            title="暂无任务记录"
          />
        ) : (
          <>
            {message ? <FormMessage message={message} tone="error" /> : null}
            <div className="dp-list-items">
              {rows.map((run) => (
                <Link
                  className="dp-list-item"
                  href={`/console/runs/${run.id}`}
                  key={run.id}
                >
                  <div>
                    <strong title={run.goal}>
                      {compactRunTitle(run, 120)}
                    </strong>
                    <Badge tone={tone(run.verdict ?? run.lifecycle)}>
                      {displayLabel(run.verdict ?? run.lifecycle)}
                    </Badge>
                  </div>
                  <small>
                    {displayLabel(run.lifecycle)} ·{" "}
                    {displayLabel(run.executionDisposition)} · 尝试{" "}
                    {run.currentAttemptNumber}/{run.maxAttempts} ·{" "}
                    {new Date(run.createdAt).toLocaleString("zh-CN")}
                  </small>
                </Link>
              ))}
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function RunDetailClient({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [trajectory, setTrajectory] = useState<RunTrajectoryPage | null>(null);
  const [olderRecords, setOlderRecords] = useState<RunTrajectoryRecord[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderHasMore, setOlderHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [runtimeView, setRuntimeView] = useState<"browser" | "trajectory">(
    "browser",
  );
  const [livePreviewOpen, setLivePreviewOpen] = useState(false);
  const previewAutoOpenedRunId = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const load = useCallback(
    async (mode: "background" | "foreground") => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      if (mode === "foreground") {
        setRefreshing(true);
        setMessage(null);
      }
      try {
        const [nextDetail, nextTrajectory] = await Promise.all([
          consoleApi<RunDetail>(`/runs/${id}`),
          consoleApi<RunTrajectoryPage>(`/runs/${id}/trajectory?limit=500`),
        ]);
        setDetail(nextDetail);
        setTrajectory((current) => ({
          ...nextTrajectory,
          records: mergeTrajectoryRecords(
            current?.records ?? [],
            nextTrajectory.records,
          ),
        }));
        setMessage(null);
      } catch (error) {
        if (mode === "foreground") {
          setMessage((error as Error).message);
        }
        throw error;
      } finally {
        loadingRef.current = false;
        if (mode === "foreground") {
          setRefreshing(false);
        }
      }
    },
    [id],
  );

  useEffect(() => {
    void load("foreground").catch(() => undefined);
  }, [load]);
  useEffect(() => {
    if (
      !detail ||
      ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(detail.lifecycle)
    )
      return;
    let active = true;
    let timer: number | undefined;

    const schedule = (delay = 2_000) => {
      window.clearTimeout(timer);
      if (active && document.visibilityState === "visible") {
        timer = window.setTimeout(() => {
          void load("background")
            .catch(() => undefined)
            .finally(() => schedule());
        }, delay);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") schedule(0);
      else window.clearTimeout(timer);
    };

    schedule();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [detail?.lifecycle, load]);
  useEffect(() => {
    if (!detail || detail.id !== id) return;
    if (detail.lifecycle === "RUNNING") {
      if (previewAutoOpenedRunId.current !== id) {
        previewAutoOpenedRunId.current = id;
        setLivePreviewOpen(true);
      }
      return;
    }
    setLivePreviewOpen(false);
  }, [detail, id]);

  async function cancel() {
    if (
      !window.confirm("确认取消这个任务？浏览器与 Runtime 资源会由控制面回收。")
    ) {
      return;
    }
    setCancelling(true);
    setMessage(null);
    try {
      await consoleApi(`/runs/${id}/cancel`, { method: "POST" });
      await load("foreground");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  async function loadOlderTrajectory() {
    const before = olderCursor ?? trajectory?.nextBefore;
    if (!before || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await consoleApi<RunTrajectoryPage>(
        `/runs/${id}/trajectory?limit=500&before=${encodeURIComponent(before)}`,
      );
      setOlderRecords((current) =>
        mergeTrajectoryRecords(page.records, current),
      );
      setOlderCursor(page.nextBefore);
      setOlderHasMore(page.hasMore);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingOlder(false);
    }
  }

  const terminal = detail
    ? ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(detail.lifecycle)
    : false;
  const taskFailures = detail ? summarizeTaskFailures(detail.tasks) : [];
  const criteria = detail ? displayCriteria(detail) : [];
  const pendingIntervention =
    detail?.interventions.find(
      (intervention) =>
        intervention.status === "PENDING" && intervention.expiresAt,
    ) ?? null;
  const trajectoryPage = useMemo<RunTrajectoryPage>(
    () => ({
      hasMore: olderRecords.length
        ? olderHasMore
        : (trajectory?.hasMore ?? false),
      nextBefore: olderRecords.length
        ? olderCursor
        : (trajectory?.nextBefore ?? null),
      records: mergeTrajectoryRecords(olderRecords, trajectory?.records ?? []),
    }),
    [olderCursor, olderHasMore, olderRecords, trajectory],
  );
  const displayedExecutionDisposition = detail
    ? hasInvalidToolSchemaFailure(taskFailures)
      ? "AGENT_ERROR"
      : detail.executionDisposition
    : null;
  const runtimeIsRunning = detail?.lifecycle === "RUNNING";
  const outcome = detail
    ? runOutcome(detail, displayedExecutionDisposition, taskFailures, criteria)
    : null;
  const videos = detail?.evidences.filter(isVideoEvidence) ?? [];
  const stepScreenshots = (detail?.evidences.filter(isStepScreenshot) ?? [])
    .filter((evidence) => evidence.downloadUrl)
    .sort((left, right) => stepIndex(left) - stepIndex(right));
  const passedCriteria = criteria.filter(
    (criterion) => criterion.status === "PASSED",
  ).length;

  return (
    <>
      <PageHeader
        actions={
          <>
            {!terminal && detail ? (
              <Button
                disabled={cancelling}
                onClick={() => void cancel()}
                variant="danger"
              >
                <XCircle />
                {cancelling ? "取消中…" : "取消任务"}
              </Button>
            ) : null}
            {runtimeIsRunning ? (
              <Button
                aria-pressed={livePreviewOpen}
                onClick={() => setLivePreviewOpen(true)}
                variant="secondary"
              >
                <MonitorPlay />
                查看实时运行状态
              </Button>
            ) : null}
            <Button
              disabled={refreshing}
              onClick={() => void load("foreground").catch(() => undefined)}
              variant="secondary"
            >
              <RefreshCw />
              {refreshing ? "刷新中…" : "刷新"}
            </Button>
          </>
        }
        title="任务详情"
      />
      <Link className="dp-back-link" href="/console/runs">
        <ArrowLeft /> 返回任务列表
      </Link>
      {!detail ? (
        message ? (
          <ErrorState
            message={message}
            onRetry={() => void load("foreground").catch(() => undefined)}
          />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          {message ? <FormMessage message={message} tone="error" /> : null}
          <div className="dp-run-layout">
            {outcome ? (
              <Card
                className={`dp-verification-detail dp-run-card dp-run-outcome-card is-${outcome.tone}`}
              >
                <div className="dp-run-outcome-main">
                  <span className="dp-run-outcome-icon" aria-hidden="true">
                    {outcome.tone === "success" ? (
                      <CircleCheckBig />
                    ) : outcome.tone === "danger" ? (
                      <TriangleAlert />
                    ) : (
                      <Activity />
                    )}
                  </span>
                  <div>
                    <Badge tone={outcome.tone}>{outcome.label}</Badge>
                    <h2>{outcome.title}</h2>
                    <p>{outcome.description}</p>
                  </div>
                </div>
                <div className="dp-run-outcome-metrics" aria-label="结果摘要">
                  <span>
                    <b>
                      {passedCriteria}/{criteria.length}
                    </b>
                    <small>验收通过</small>
                  </span>
                  <span>
                    <b>
                      {detail.currentAttemptNumber}/{detail.maxAttempts}
                    </b>
                    <small>执行尝试</small>
                  </span>
                  <span>
                    <b>{stepScreenshots.length}</b>
                    <small>操作步骤</small>
                  </span>
                  <span>
                    <b>{videos.length}</b>
                    <small>完整视频</small>
                  </span>
                </div>
              </Card>
            ) : null}

            {videos.length > 0 || stepScreenshots.length > 0 ? (
              <Card className="dp-verification-detail dp-run-card dp-run-media-card">
                <div className="dp-section-head">
                  <span>
                    <Film />
                    <b>操作回放</b>
                  </span>
                  <small>
                    {videos.length > 0
                      ? "由每一步操作后的真实截图自动生成"
                      : "视频生成中，步骤截图已可查看"}
                  </small>
                </div>
                {videos.map((video) => (
                  <div className="dp-run-video" key={video.id}>
                    {video.downloadUrl ? (
                      <video
                        controls
                        playsInline
                        poster={
                          stepScreenshots.at(-1)?.downloadUrl ?? undefined
                        }
                        preload="metadata"
                        src={video.downloadUrl}
                      >
                        当前浏览器不支持 WebM 视频，请使用下方链接下载查看。
                      </video>
                    ) : null}
                    <div>
                      <span>
                        <b>{video.label || "完整操作视频"}</b>
                        <small>
                          {evidenceMetadata(video).frameCount
                            ? `${String(evidenceMetadata(video).frameCount)} 帧 · `
                            : ""}
                          {video.runtimeArtifact
                            ? formatByteSize(video.runtimeArtifact.byteSize)
                            : "已上传对象存储"}
                        </small>
                      </span>
                      {video.downloadUrl ? (
                        <a href={video.downloadUrl} download>
                          <Download /> 下载视频
                        </a>
                      ) : null}
                    </div>
                  </div>
                ))}
                {stepScreenshots.length > 0 ? (
                  <details className="dp-run-step-details">
                    <summary>
                      <ImageIcon /> 查看全部 {stepScreenshots.length} 个操作步骤
                    </summary>
                    <div className="dp-run-step-grid">
                      {stepScreenshots.map((screenshot, index) => (
                        <a
                          href={screenshot.downloadUrl ?? undefined}
                          key={screenshot.id}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <img
                            alt={`步骤 ${index + 1}：${stepCommand(screenshot)}`}
                            loading="lazy"
                            src={screenshot.downloadUrl ?? undefined}
                          />
                          <span>
                            <b>步骤 {index + 1}</b>
                            <small>{stepCommand(screenshot)}</small>
                          </span>
                        </a>
                      ))}
                    </div>
                  </details>
                ) : null}
              </Card>
            ) : terminal ? (
              <Card className="dp-verification-detail dp-run-card dp-run-media-empty">
                <Film />
                <span>
                  <b>本次执行没有生成操作视频</b>
                  <small>
                    需要 Browser Runtime protocol v1.10 或更新版本；升级后请重启
                    Runtime。
                  </small>
                </span>
              </Card>
            ) : null}

            <div className="dp-run-overview-row">
              <Card className="dp-verification-detail dp-run-card dp-run-goal-card">
                <div className="dp-section-head">
                  <span>
                    <b>任务目标</b>
                  </span>
                </div>
                <p className="dp-run-goal-copy">{detail.goal}</p>
              </Card>
              <Card className="dp-verification-detail dp-run-card dp-run-criteria-card">
                <div className="dp-section-head">
                  <span>
                    <b>验收标准</b>
                  </span>
                  <span className="dp-count">{criteria.length}</span>
                </div>
                {criteria.length === 0 ? (
                  <p className="dp-run-card-copy">未声明验收标准。</p>
                ) : (
                  criteria.map((criterion) => (
                    <div className="dp-run-criterion" key={criterion.id}>
                      <div className="dp-run-criterion-head">
                        <b>{criterion.id}</b>
                        {criterion.status ? (
                          <Badge tone={tone(criterion.status)}>
                            {displayLabel(criterion.status)}
                          </Badge>
                        ) : criterion.required ? (
                          <small>必需</small>
                        ) : null}
                      </div>
                      <p>{criterion.description}</p>
                      {criterion.summary ? (
                        <small>{criterion.summary}</small>
                      ) : null}
                    </div>
                  ))
                )}
              </Card>
            </div>

            <details className="dp-run-technical-details">
              <summary>
                <span>
                  <Activity />
                  <b>查看尝试、全部证据与 Runtime 详情</b>
                </span>
                <small>
                  {detail.attempts.length} 次尝试 · {detail.evidences.length}{" "}
                  条证据 · {trajectoryPage.records.length} 条轨迹
                </small>
              </summary>
              <div className="dp-run-technical-body">
                <div className="dp-run-result-row">
                  <Card className="dp-verification-detail dp-run-card dp-run-result-card">
                    <div className="dp-section-head">
                      <span>
                        <b>执行结果</b>
                      </span>
                      <Badge
                        tone={tone(
                          detail.verdict ??
                            displayedExecutionDisposition ??
                            detail.lifecycle,
                        )}
                      >
                        {displayLabel(
                          detail.verdict ??
                            displayedExecutionDisposition ??
                            detail.lifecycle,
                        )}
                      </Badge>
                    </div>
                    <div className="dp-run-result-summary">
                      <strong>
                        {displayLabel(
                          detail.verdict ??
                            displayedExecutionDisposition ??
                            detail.lifecycle,
                        )}
                      </strong>
                      <span>
                        {displayLabel(displayedExecutionDisposition)} · 尝试{" "}
                        {detail.currentAttemptNumber}/{detail.maxAttempts} ·{" "}
                        {detail.evidences.length} 条证据
                      </span>
                    </div>
                    <div className="dp-run-attempt-list">
                      {detail.attempts.map((attempt) => {
                        const task = detail.tasks.find(
                          (item) => item.attemptId === attempt.id,
                        );
                        return (
                          <div key={attempt.id}>
                            <strong>#{attempt.number}</strong>
                            <span>{task?.provider ?? "Runtime"}</span>
                            <Badge tone={tone(task?.status ?? attempt.status)}>
                              {displayLabel(task?.status ?? attempt.status)}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>
                    {taskFailures.map((failure) => (
                      <div className="dp-run-failure" key={failure.signature}>
                        <div>
                          <Badge tone="danger">{failure.code}</Badge>
                          {failure.occurrences > 1 ? (
                            <small>
                              {failure.occurrences} 次尝试发生相同错误
                            </small>
                          ) : null}
                        </div>
                        <p>{failure.message}</p>
                        <details>
                          <summary>查看技术详情</summary>
                          <pre>{failure.raw}</pre>
                        </details>
                      </div>
                    ))}
                  </Card>
                  <Card className="dp-verification-detail dp-run-card dp-run-evidence-card">
                    <div className="dp-section-head">
                      <span>
                        <b>执行证据</b>
                      </span>
                      <span className="dp-count">
                        {detail.evidences.length}
                      </span>
                    </div>
                    {detail.evidences.length === 0 ? (
                      <p className="dp-run-card-copy">
                        尚未产生 Screenshot、DOM、Network 或 Console 证据。
                      </p>
                    ) : (
                      detail.evidences.map((evidence) => (
                        <div className="dp-run-evidence" key={evidence.id}>
                          <p>
                            <b>{displayLabel(evidence.kind)}</b>
                            {evidence.label ? ` · ${evidence.label}` : ""}
                          </p>
                          <small>
                            {evidence.externalId}
                            {evidence.runtimeArtifact
                              ? ` · ${evidence.runtimeArtifact.contentType} · ${evidence.runtimeArtifact.byteSize} bytes`
                              : ""}
                          </small>
                          {evidence.downloadUrl ? (
                            <a
                              href={evidence.downloadUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              <Download /> 查看证据
                            </a>
                          ) : businessReferenceUrl(evidence) ? (
                            <a
                              href={businessReferenceUrl(evidence) ?? undefined}
                              rel="noreferrer"
                              target="_blank"
                            >
                              <ExternalLink /> 查看业务来源
                            </a>
                          ) : null}
                        </div>
                      ))
                    )}
                  </Card>
                </div>

                <Card className="dp-verification-detail dp-run-card dp-run-runtime-workspace">
                  <div
                    aria-label="Runtime 详情视图"
                    className="dp-run-runtime-tabs"
                    role="tablist"
                  >
                    <button
                      aria-controls="run-browser-runtime-panel"
                      aria-selected={runtimeView === "browser"}
                      onClick={() => setRuntimeView("browser")}
                      role="tab"
                      type="button"
                    >
                      <Monitor />
                      Browser Runtime
                      <span>{detail.browserExecutions.length}</span>
                    </button>
                    <button
                      aria-controls="run-trajectory-panel"
                      aria-selected={runtimeView === "trajectory"}
                      onClick={() => setRuntimeView("trajectory")}
                      role="tab"
                      type="button"
                    >
                      <Activity />
                      Runtime 轨迹
                      <span>{trajectoryPage.records.length}</span>
                    </button>
                  </div>
                  {runtimeView === "browser" ? (
                    <div
                      className="dp-run-runtime-panel dp-run-browser-panel"
                      id="run-browser-runtime-panel"
                      role="tabpanel"
                    >
                      {detail.browserExecutions.length === 0 ? (
                        <p className="dp-run-card-copy">
                          尚未创建 Browser Runtime 执行。
                        </p>
                      ) : (
                        detail.browserExecutions.map((execution) => (
                          <section
                            className="dp-run-browser-execution"
                            key={execution.id}
                          >
                            <header>
                              <span>
                                <b>
                                  {execution.runtimeSession?.runtime.name ??
                                    "等待分配 Runtime"}
                                </b>
                                <small>
                                  {execution.runtimeSession
                                    ? `${displayLabel(execution.runtimeSession.profileMode)} · Session ${displayLabel(execution.runtimeSession.status)}`
                                    : "尚未分配 Browser Runtime Session"}
                                </small>
                              </span>
                              <Badge tone={tone(execution.status)}>
                                {displayLabel(execution.status)}
                              </Badge>
                            </header>
                            {execution.runtimeSession?.commands.length ? (
                              <div className="dp-run-runtime-list">
                                {execution.runtimeSession.commands.map(
                                  (command) => (
                                    <div key={command.id}>
                                      <span>{command.commandType}</span>
                                      <Badge tone={tone(command.status)}>
                                        {displayLabel(command.status)}
                                      </Badge>
                                      <small>
                                        {new Date(
                                          command.createdAt,
                                        ).toLocaleString("zh-CN")}
                                      </small>
                                    </div>
                                  ),
                                )}
                              </div>
                            ) : (
                              <p className="dp-run-card-copy">
                                尚无浏览器命令。
                              </p>
                            )}
                          </section>
                        ))
                      )}
                    </div>
                  ) : (
                    <div
                      className="dp-run-runtime-panel dp-run-trajectory-panel"
                      id="run-trajectory-panel"
                      role="tabpanel"
                    >
                      <RunTrajectory
                        loadingOlder={loadingOlder}
                        onLoadOlder={loadOlderTrajectory}
                        page={trajectoryPage}
                      />
                    </div>
                  )}
                </Card>
              </div>
            </details>
          </div>

          {pendingIntervention ? (
            <RunHitlBrowser
              intervention={{
                expiresAt: pendingIntervention.expiresAt!,
                id: pendingIntervention.id,
                prompt: pendingIntervention.prompt,
              }}
              onComplete={() => load("foreground")}
              runId={id}
            />
          ) : null}
          {runtimeIsRunning && livePreviewOpen ? (
            <RunLiveBrowser
              onClose={() => setLivePreviewOpen(false)}
              runId={id}
            />
          ) : null}
        </>
      )}
    </>
  );
}

interface DisplayCriterion {
  description: string;
  id: string;
  required: boolean;
  status: string | null;
  summary: string | null;
}

function displayCriteria(detail: RunDetail): DisplayCriterion[] {
  const definitions = Array.isArray(detail.criteriaSnapshot)
    ? detail.criteriaSnapshot.flatMap((value): DisplayCriterion[] => {
        if (!isRecord(value) || typeof value.id !== "string") return [];
        const result = detail.criterionResults.find(
          (candidate) => candidate.criterionId === value.id,
        );
        return [
          {
            description:
              typeof value.description === "string"
                ? value.description
                : value.id,
            id: value.id,
            required: value.required !== false,
            status: result?.status ?? null,
            summary: result?.summary ?? null,
          },
        ];
      })
    : [];
  if (definitions.length > 0) return definitions;
  return detail.criterionResults.map((result) => ({
    description: result.summary,
    id: result.criterionId,
    required: true,
    status: result.status,
    summary: null,
  }));
}

function mergeTrajectoryRecords(
  ...groups: RunTrajectoryRecord[][]
): RunTrajectoryRecord[] {
  const records = new Map<string, RunTrajectoryRecord>();
  for (const record of groups.flat()) records.set(record.id, record);
  return [...records.values()].sort((left, right) => {
    const leftSequence = BigInt(left.sequence);
    const rightSequence = BigInt(right.sequence);
    return leftSequence < rightSequence
      ? -1
      : leftSequence > rightSequence
        ? 1
        : 0;
  });
}
