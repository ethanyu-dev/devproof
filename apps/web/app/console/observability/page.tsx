"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";

import { PageHeader } from "@/components/page-header";
import {
  EmptyState,
  ErrorState,
  FormMessage,
} from "@/components/settings-layout";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { consoleApi } from "@/lib/api";
import { displayLabel, displayMessage } from "@/lib/display-text";

interface StatusCount {
  _count: number;
  status: string;
}

interface WorkerOverview {
  healthy: boolean;
  lastDurationMs: number | null;
  lastError: string | null;
  lastFailureAt: string | null;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  name: string;
  running: boolean;
}

interface Overview {
  commandStatuses: StatusCount[];
  health: {
    checks: Record<
      string,
      { durationMs: number; error?: string; status: string }
    >;
    status: string;
    workers: WorkerOverview[];
  };
  outboxStatuses: StatusCount[];
  runtimes: StatusCount[];
  taskStageStatuses: StatusCount[];
  taskStatuses: StatusCount[];
  verificationStatuses: StatusCount[];
}

interface Invocation {
  clientName: string | null;
  credential: { name: string; tokenHint: string };
  durationMs: number | null;
  errorCode: string | null;
  id: string;
  startedAt: string;
  status: string;
  toolName: string;
  traceId: string;
  transport: string;
}

interface AuditEvent {
  action: string;
  actor: { email: string | null; name: string | null };
  createdAt: string;
  entityId: string | null;
  entityType: string;
  id: string;
  metadata: unknown;
}

function statusTone(status: string) {
  if (
    [
      "COMPLETED",
      "DELIVERED",
      "HEALTHY",
      "ONLINE",
      "PASSED",
      "READY",
      "SUCCEEDED",
      "UP",
    ].includes(status)
  )
    return "success" as const;
  if (
    [
      "BROWSER_UNAVAILABLE",
      "DOWN",
      "FAILED",
      "INTEGRATION_ERROR",
      "LOST",
      "NOT_READY",
      "OFFLINE",
      "REVOKED",
      "RUNTIME_LOST",
      "TIMED_OUT",
    ].includes(status)
  )
    return "danger" as const;
  return "warning" as const;
}

type StatusTone = ReturnType<typeof statusTone>;

const overviewStatusGroups = [
  "taskStatuses",
  "taskStageStatuses",
  "verificationStatuses",
  "commandStatuses",
  "outboxStatuses",
  "runtimes",
] as const;

const successRateChartConfig = {
  rate: { color: "var(--ek-success)", label: "完成 / 正常占比" },
} satisfies ChartConfig;

const verificationChartConfig = {
  value: { label: "数量" },
} satisfies ChartConfig;

function verificationChartColor(status: string) {
  if (status === "CANCELLED") return "var(--ek-fg-2)";
  if (status === "SKIPPED") return "var(--ek-border-2)";
  const tone = statusTone(status);
  return `var(--ek-${tone})`;
}

function formatCompactTime(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleString("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
  });
}

function workerPresentation(worker: WorkerOverview): {
  label: string;
  meta: string;
  tone: "danger" | "success" | "warning";
} {
  if (worker.running) {
    const startedAt = formatCompactTime(worker.lastStartedAt);
    return {
      label: "运行中",
      meta: startedAt ? `开始于 ${startedAt}` : "正在执行",
      tone: "warning",
    };
  }
  if (worker.lastError) {
    const failedAt = formatCompactTime(worker.lastFailureAt);
    return {
      label: "执行失败",
      meta: failedAt ? `失败于 ${failedAt}` : "最近一次执行失败",
      tone: "danger",
    };
  }
  if (!worker.lastSuccessAt) {
    return { label: "正在启动", meta: "等待首次成功", tone: "warning" };
  }

  const succeededAt = formatCompactTime(worker.lastSuccessAt)!;
  const duration =
    worker.lastDurationMs === null ? "" : ` · ${worker.lastDurationMs} ms`;
  if (!worker.healthy) {
    return {
      label: "长时间未更新",
      meta: `上次成功于 ${succeededAt}${duration}`,
      tone: "danger",
    };
  }
  return {
    label: "健康",
    meta: `上次成功于 ${succeededAt}${duration}`,
    tone: "success",
  };
}

const skeletonRows = Array.from({ length: 4 }, (_, index) => index);
const overviewSkeletonItems = Array.from({ length: 6 }, (_, index) => index);
const logPreviewLimit = 12;

function SkeletonRow({ compact = false }: { compact?: boolean }) {
  return (
    <div className="dp-observe-skeleton-row">
      {!compact ? <i className="dp-observe-skeleton-badge" /> : null}
      <i className="dp-observe-skeleton-title" />
      <i className="dp-observe-skeleton-meta" />
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div aria-hidden="true" className="dp-observe-grid dp-observe-skeleton">
      {["系统健康", "运行状态"].map((section) => (
        <Card className="dp-observe-overview-card" key={section}>
          <div className="dp-observe-card-head">
            <span>
              <b>{section}</b>
              <i className="dp-observe-skeleton-subtitle" />
            </span>
            <i className="dp-observe-skeleton-count" />
          </div>
          <div className="dp-observe-overview-skeleton-grid">
            {overviewSkeletonItems.map((item) => (
              <SkeletonRow compact key={item} />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="dp-observe-skeleton dp-observe-table-skeleton"
    >
      {skeletonRows.map((row) => (
        <SkeletonRow key={row} />
      ))}
    </div>
  );
}

function HealthOverview({ overview }: { overview: Overview }) {
  const checkItems = Object.entries(overview.health.checks).map(
    ([name, check]) => ({
      label: displayLabel(check.status),
      meta: `${check.durationMs} ms${check.error ? ` · ${displayMessage(check.error)}` : ""}`,
      name: displayLabel(name),
      tone: statusTone(check.status),
    }),
  );
  const workerItems = overview.health.workers.map((worker) => {
    const presentation = workerPresentation(worker);
    return {
      label: presentation.label,
      meta: `${presentation.meta}${worker.lastError ? ` · ${displayMessage(worker.lastError)}` : ""}`,
      name: displayLabel(worker.name),
      tone: presentation.tone,
    };
  });
  const itemCount = checkItems.length + workerItems.length;
  const issueCount = [...checkItems, ...workerItems].filter(
    (item) => item.tone === "danger",
  ).length;
  const overallTone = statusTone(overview.health.status);

  const renderItems = (
    items: Array<{
      label: string;
      meta: string;
      name: string;
      tone: StatusTone;
    }>,
  ) =>
    items.map((item) => (
      <div className="dp-observe-health-item" key={item.name}>
        <span>
          <i
            aria-label={item.label}
            className={`dp-observe-status-dot is-${item.tone}`}
            role="img"
          />
          <b>{item.name}</b>
        </span>
        <small title={item.meta}>{item.meta}</small>
      </div>
    ));

  return (
    <Card className="dp-observe-overview-card">
      <div className="dp-observe-card-head">
        <span>
          <b>系统健康</b>
          <small>
            {issueCount > 0
              ? `${issueCount} 项需要处理`
              : `${itemCount} 项检查均正常`}
          </small>
        </span>
        <span className={`dp-observe-overall-state is-${overallTone}`}>
          <i />
          {displayLabel(overview.health.status)}
        </span>
      </div>
      <div className="dp-observe-health-group is-checks">
        <h3>基础依赖</h3>
        <div className="dp-observe-health-grid">{renderItems(checkItems)}</div>
      </div>
      <div className="dp-observe-health-group is-workers">
        <h3>后台任务</h3>
        <div className="dp-observe-health-grid">{renderItems(workerItems)}</div>
      </div>
    </Card>
  );
}

function StatusOverview({ overview }: { overview: Overview }) {
  const successRates = overviewStatusGroups.map((group) => {
    const items = overview[group];
    const total = items.reduce((sum, item) => sum + item._count, 0);
    const successful = items
      .filter((item) => statusTone(item.status) === "success")
      .reduce((sum, item) => sum + item._count, 0);
    const rate = total === 0 ? 0 : Math.round((successful / total) * 100);
    const fill =
      rate >= 80
        ? "var(--ek-success)"
        : rate >= 50
          ? "var(--ek-warning)"
          : "var(--ek-danger)";

    return {
      fill,
      group,
      label: displayLabel(group),
      rate,
      successful,
      total,
    };
  });
  const verificationResults = overview.verificationStatuses.map((item) => ({
    fill: verificationChartColor(item.status),
    label: displayLabel(item.status),
    status: item.status,
    value: item._count,
  }));
  const verificationTotal = verificationResults.reduce(
    (sum, item) => sum + item.value,
    0,
  );

  return (
    <Card className="dp-observe-overview-card">
      <div className="dp-observe-card-head">
        <span>
          <b>运行状态</b>
          <small>当前任务与执行资源分布</small>
        </span>
      </div>
      <div className="dp-observe-chart-grid">
        <section>
          <header>
            <b>各模块完成 / 正常占比</b>
            <small>完成或正常状态 / 全部记录</small>
          </header>
          <ChartContainer
            className="dp-observe-rate-chart"
            config={successRateChartConfig}
          >
            <BarChart
              accessibilityLayer
              data={successRates}
              layout="vertical"
              margin={{ left: 4, right: 40 }}
            >
              <CartesianGrid horizontal={false} />
              <XAxis dataKey="rate" domain={[0, 100]} hide type="number" />
              <YAxis
                axisLine={false}
                dataKey="label"
                tickLine={false}
                type="category"
                width={72}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    valueFormatter={(value, item) => {
                      const successful = Number(item.payload?.successful ?? 0);
                      const total = Number(item.payload?.total ?? 0);
                      return `${String(value ?? 0)}% · ${successful}/${total}`;
                    }}
                  />
                }
                cursor={false}
              />
              <Bar barSize={24} dataKey="rate" radius={[0, 4, 4, 0]}>
                {successRates.map((item) => (
                  <Cell fill={item.fill} key={item.group} />
                ))}
                <LabelList
                  className="dp-observe-rate-label"
                  dataKey="rate"
                  formatter={(value) => `${String(value ?? 0)}%`}
                  offset={6}
                  position="right"
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        </section>

        <section className="is-verification-chart">
          <header>
            <b>验证结果</b>
            <small>当前验证任务构成</small>
          </header>
          <div className="dp-observe-pie-wrap">
            <ChartContainer
              className="dp-observe-pie-chart"
              config={verificationChartConfig}
            >
              <PieChart accessibilityLayer>
                <ChartTooltip
                  content={<ChartTooltipContent />}
                  cursor={false}
                />
                <Pie
                  data={verificationResults}
                  dataKey="value"
                  innerRadius={48}
                  nameKey="label"
                  outerRadius={70}
                  paddingAngle={2}
                  stroke="none"
                >
                  {verificationResults.map((item) => (
                    <Cell fill={item.fill} key={item.status} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <span className="dp-observe-pie-total">
              <b>{verificationTotal}</b>
              <small>验证</small>
            </span>
          </div>
          <div className="dp-observe-chart-legend">
            {verificationResults.map((item) => (
              <span key={item.status}>
                <i style={{ background: item.fill }} />
                {item.label}
                <b>{item.value}</b>
              </span>
            ))}
          </div>
        </section>
      </div>
    </Card>
  );
}

export default function ObservabilityPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [invocations, setInvocations] = useState<Invocation[] | null>(null);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [showAllAudit, setShowAllAudit] = useState(false);
  const [showAllInvocations, setShowAllInvocations] = useState(false);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;

    loadingRef.current = true;
    setIsRefreshing(true);
    setError(null);
    try {
      const [nextOverview, nextInvocations, nextAudit] = await Promise.all([
        consoleApi<Overview>("/observability/overview"),
        consoleApi<Invocation[]>("/observability/tool-invocations"),
        consoleApi<AuditEvent[]>("/observability/audit-events"),
      ]);
      setOverview(nextOverview);
      setInvocations(nextInvocations);
      setAudit(nextAudit);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      loadingRef.current = false;
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const initialLoadFailed = Boolean(
    error && !isRefreshing && !overview && !invocations && !audit,
  );

  return (
    <>
      <PageHeader
        actions={
          <Button
            aria-label={isRefreshing ? "正在刷新监控数据" : "刷新监控数据"}
            className={
              "dp-observability-refresh" + (isRefreshing ? " is-loading" : "")
            }
            disabled={isRefreshing}
            onClick={() => void load()}
            variant="secondary"
          >
            <RefreshCw />
            {isRefreshing ? "刷新中" : "刷新"}
          </Button>
        }
        description="检查控制面依赖、后台任务、工具调用与团队操作记录。"
        title="系统监控"
      />
      {error && !initialLoadFailed ? (
        <FormMessage message={error} tone="error" />
      ) : null}
      <div aria-busy={isRefreshing} className="dp-observability-panel">
        <span className="dp-observability-loading-label">
          {isRefreshing ? "正在加载监控数据" : "监控数据已更新"}
        </span>
        {initialLoadFailed ? (
          <Card>
            <ErrorState message={error!} onRetry={() => void load()} />
          </Card>
        ) : (
          <>
            {!overview ? (
              isRefreshing ? (
                <OverviewSkeleton />
              ) : null
            ) : (
              <div className="dp-observe-grid dp-observe-loaded">
                <HealthOverview overview={overview} />
                <StatusOverview overview={overview} />
              </div>
            )}
            <Card className="dp-observe-section">
              <div className="dp-observe-card-head">
                <span>
                  <b>工具调用</b>
                  <small>最近的 MCP / HTTP 工具调用</small>
                </span>
                {invocations ? (
                  <span className="dp-count">{invocations.length}</span>
                ) : isRefreshing ? (
                  <i aria-hidden="true" className="dp-observe-skeleton-count" />
                ) : (
                  <span className="dp-count">—</span>
                )}
              </div>
              {!invocations ? (
                isRefreshing ? (
                  <TableSkeleton />
                ) : null
              ) : invocations.length === 0 ? (
                <EmptyState
                  description="外部 Agent 发起工具调用后会显示在这里。"
                  title="暂无工具调用"
                />
              ) : (
                <div className="dp-observe-table dp-observe-loaded">
                  {invocations
                    .slice(0, showAllInvocations ? undefined : logPreviewLimit)
                    .map((item) => (
                      <details key={item.id}>
                        <summary>
                          <span
                            className={`dp-observe-log-status is-${statusTone(item.status)}`}
                          >
                            <i />
                            {displayLabel(item.status)}
                          </span>
                          <b>{item.toolName}</b>
                          <span className="dp-observe-log-source">
                            {item.transport} · {item.credential.name}
                          </span>
                          <span className="dp-observe-log-tail">
                            {item.durationMs ?? "—"} ms ·{" "}
                            {formatCompactTime(item.startedAt)}
                          </span>
                        </summary>
                        <pre>{JSON.stringify(item, null, 2)}</pre>
                      </details>
                    ))}
                  {invocations.length > logPreviewLimit ? (
                    <button
                      className="dp-observe-more"
                      onClick={() =>
                        setShowAllInvocations((current) => !current)
                      }
                      type="button"
                    >
                      {showAllInvocations
                        ? "收起"
                        : `显示其余 ${invocations.length - logPreviewLimit} 条`}
                    </button>
                  ) : null}
                </div>
              )}
            </Card>
            <Card className="dp-observe-section">
              <div className="dp-observe-card-head">
                <span>
                  <b>操作记录</b>
                  <small>配置与任务操作</small>
                </span>
                {audit ? (
                  <span className="dp-count">{audit.length}</span>
                ) : isRefreshing ? (
                  <i aria-hidden="true" className="dp-observe-skeleton-count" />
                ) : (
                  <span className="dp-count">—</span>
                )}
              </div>
              {!audit ? (
                isRefreshing ? (
                  <TableSkeleton />
                ) : null
              ) : audit.length === 0 ? (
                <EmptyState
                  description="团队配置和任务操作会自动记录在这里。"
                  title="暂无操作记录"
                />
              ) : (
                <div className="dp-observe-table dp-observe-loaded">
                  {audit
                    .slice(0, showAllAudit ? undefined : logPreviewLimit)
                    .map((item) => (
                      <details key={item.id}>
                        <summary className="is-audit">
                          <i className="dp-observe-event-dot" />
                          <b>{displayLabel(item.action)}</b>
                          <span className="dp-observe-log-source">
                            {item.actor.name ?? item.actor.email ?? "成员"} ·{" "}
                            {displayLabel(item.entityType)}
                          </span>
                          <span className="dp-observe-log-tail">
                            {formatCompactTime(item.createdAt)}
                          </span>
                        </summary>
                        <pre>{JSON.stringify(item, null, 2)}</pre>
                      </details>
                    ))}
                  {audit.length > logPreviewLimit ? (
                    <button
                      className="dp-observe-more"
                      onClick={() => setShowAllAudit((current) => !current)}
                      type="button"
                    >
                      {showAllAudit
                        ? "收起"
                        : `显示其余 ${audit.length - logPreviewLimit} 条`}
                    </button>
                  ) : null}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </>
  );
}
