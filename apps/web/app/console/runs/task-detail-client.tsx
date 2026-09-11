"use client";

import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Layers3,
  RefreshCw,
  RotateCcw,
  ScrollText,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import {
  ErrorState,
  FormMessage,
  LoadingState,
} from "@/components/settings-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { displayLabel } from "@/lib/display-text";
import { TaskDetailContent } from "./task-detail-content";
import styles from "./task-detail.module.css";
import { terminalLifecycles, tone } from "./task-display";
import { taskDetailHref, taskReturnHref } from "./task-navigation";
import { taskOutcomeDisplay } from "./task-outcome";
import { projectSpecGenerationTrajectory } from "./spec-generation-trajectory";
import { useTaskActions } from "./use-task-actions";
import { useTaskDetail } from "./use-task-detail";

export function TaskDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = searchParams.get("view") === "logs" ? "logs" : "specs";
  const returnTo = taskReturnHref(searchParams.get("returnTo"));
  const taskHref = taskDetailHref(id, returnTo);
  const logParams = new URLSearchParams(taskHref.split("?")[1]);
  logParams.set("view", "logs");
  const logsHref = `${taskHref.split("?")[0]}?${logParams}`;
  const {
    detail,
    error,
    loading,
    events,
    eventsError,
    eventsLoading,
    refresh,
    updateDetail,
    retryEvents,
  } = useTaskDetail(id, view === "logs");
  const { busy, message, mutate, cancel, rerun } = useTaskActions({
    id,
    onUpdated: updateDetail,
    onRerun: (task) => router.push(taskDetailHref(task.id, returnTo)),
  });
  const trajectory = useMemo(
    () => (detail ? projectSpecGenerationTrajectory(detail, events) : []),
    [detail, events],
  );
  const outcome = detail ? taskOutcomeDisplay(detail) : null;
  const active = detail !== null && !terminalLifecycles.has(detail.lifecycle);

  return (
    <div className="dp-task-detail-page">
      <Link className="dp-back-link" href={returnTo}>
        <ArrowLeft /> 返回任务列表
      </Link>
      <PageHeader
        title={detail?.title ?? "任务详情"}
        description="查看执行用例与结果，跟进任务进展并排查日志。"
        actions={
          <>
            {detail && detail.kind !== "LEGACY_RUN" && (
              <Button
                disabled={busy}
                onClick={() => void rerun()}
                variant="secondary"
              >
                <RotateCcw /> 重跑任务
              </Button>
            )}
            {active && (
              <Button
                disabled={busy}
                onClick={() => void cancel()}
                variant="ghost"
                className="text-muted-foreground hover:bg-destructive-soft hover:text-destructive"
              >
                <XCircle /> 取消任务
              </Button>
            )}
            <Button disabled={loading} onClick={refresh} variant="secondary">
              <RefreshCw />
              {loading ? "刷新中…" : "刷新"}
            </Button>
          </>
        }
      />
      {message && <FormMessage message={message.text} tone={message.tone} />}
      {error && detail && <FormMessage message={error} tone="error" />}
      {!detail ? (
        error ? (
          <ErrorState message={error} onRetry={refresh} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          <Card className="dp-task-overview">
            <div className="dp-task-overview-status">
              <div className={styles.statusSummary}>
                <Badge tone={tone(outcome!.toneStatus)}>{outcome!.label}</Badge>
                <span className={styles.statusDescription}>
                  {outcome!.description ??
                    (active
                      ? "任务进展与执行结果将自动更新。"
                      : "任务已结束，可查看执行结果、证据和日志。")}
                </span>
              </div>
              <TaskIdentifier key={detail.id} id={detail.id} />
            </div>
            <dl
              className={`dp-task-overview-meta ${detail.specification?.primaryPullRequestUrl ? styles.metadataWithPr : ""}`}
            >
              <div>
                <dt>任务类型</dt>
                <dd>{displayLabel(detail.kind)}</dd>
              </div>
              <div>
                <dt>当前阶段</dt>
                <dd>{displayLabel(detail.currentStage)}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>
                  <time dateTime={detail.createdAt}>
                    {new Date(detail.createdAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </time>
                </dd>
              </div>
              <div>
                <dt>任务来源</dt>
                <dd>
                  {displayLabel(detail.source.kind)}
                  {detail.source.ref ? ` · ${detail.source.ref}` : ""}
                </dd>
              </div>
              {detail.specification?.primaryPullRequestUrl && (
                <div>
                  <dt>关联 PR</dt>
                  <dd>
                    <a
                      className={styles.detailLink}
                      href={detail.specification.primaryPullRequestUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      查看 PR <ExternalLink />
                    </a>
                  </dd>
                </div>
              )}
            </dl>
            <div className="dp-task-detail-counts" aria-label="任务结果统计">
              <span>
                执行项 <b>{detail.counts.total}</b>
              </span>
              <span>
                验证通过 <b>{detail.counts.passed}</b>
              </span>
              <span>
                未通过 <b>{detail.counts.failed}</b>
              </span>
              <span>
                结果不确定 <b>{detail.counts.inconclusive}</b>
              </span>
              <span>
                执行中 <b>{detail.counts.running}</b>
              </span>
              <span>
                等待中 <b>{detail.counts.waiting}</b>
              </span>
              {Boolean(detail.counts.recovering) && (
                <span>
                  恢复中 <b>{detail.counts.recovering}</b>
                </span>
              )}
              {Boolean(detail.counts.timedOut) && (
                <span>
                  已超时 <b>{detail.counts.timedOut}</b>
                </span>
              )}
            </div>
          </Card>
          <nav className="dp-task-detail-tabs" aria-label="任务详情视图">
            <Link
              href={taskHref}
              replace
              scroll={false}
              aria-current={view === "specs" ? "page" : undefined}
            >
              <Layers3 />{" "}
              {detail.kind === "ISSUE_SPEC" ? "执行用例" : "执行记录"}{" "}
              <span>
                {detail.kind === "ISSUE_SPEC"
                  ? detail.cases.length
                  : detail.runs.length}
              </span>
            </Link>
            <Link
              href={logsHref}
              replace
              scroll={false}
              aria-current={view === "logs" ? "page" : undefined}
            >
              <ScrollText /> 任务日志
            </Link>
          </nav>
          <TaskDetailContent
            busy={busy}
            detail={detail}
            onMutate={mutate}
            trajectory={trajectory}
            view={view}
            events={events}
            eventsError={eventsError}
            eventsLoading={eventsLoading}
            onRetryEvents={retryEvents}
            taskHref={taskHref}
          />
        </>
      )}
    </div>
  );
}

function TaskIdentifier({ id }: { id: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  async function copyId() {
    try {
      await navigator.clipboard.writeText(id);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className={styles.taskIdentifier}>
      <span>任务编号</span>
      <code>{id}</code>
      <Button
        className={styles.copyIdButton}
        size="icon-sm"
        variant="ghost"
        aria-label="复制任务编号"
        title={copyState === "copied" ? "已复制任务编号" : "复制任务编号"}
        onClick={() => void copyId()}
      >
        {copyState === "copied" ? <Check /> : <Copy />}
      </Button>
      <span
        role="status"
        className={copyState === "failed" ? styles.copyError : "sr-only"}
      >
        {copyState === "copied"
          ? "任务编号已复制"
          : copyState === "failed"
            ? "复制失败，请选中编号手动复制"
            : ""}
      </span>
    </div>
  );
}
