"use client";

import type { RunTrajectoryRecord } from "@devproof/contracts";
import { Download, FileSearch, List } from "lucide-react";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ErrorState,
  FormMessage,
  LoadingState,
} from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { RunTrajectory } from "./run-trajectory";
import { TaskEventLog } from "./task-event-log";
import type { TaskEvent } from "./task-types";
import styles from "./task-logs.module.css";

export function TaskLogs({
  hidden,
  hasAnalysis,
  analysisSnapshot,
  trajectory,
  events,
  eventsError,
  eventsLoading,
  onRetryEvents,
  exporting,
  exportError,
  onExport,
}: {
  hidden: boolean;
  hasAnalysis: boolean;
  analysisSnapshot: ReactNode;
  trajectory: RunTrajectoryRecord[];
  events: TaskEvent[];
  eventsError: string | null;
  eventsLoading: boolean;
  onRetryEvents: () => void;
  exporting: boolean;
  exportError: string | null;
  onExport: () => void;
}) {
  const id = useId();
  const [view, setView] = useState<"events" | "analysis">("events");
  const activeView = hasAnalysis ? view : "events";
  const tabs = [
    { value: "events", label: "全部事件", count: events.length, Icon: List },
    {
      value: "analysis",
      label: "Spec 分析",
      count: trajectory.length,
      Icon: FileSearch,
    },
  ] as const;
  const visibleTabs = hasAnalysis ? tabs : tabs.slice(0, 1);
  const initialLoading = eventsLoading && events.length === 0 && !eventsError;
  const showRecords = !initialLoading && (!eventsError || events.length > 0);

  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % buttons.length;
    else if (event.key === "ArrowLeft")
      next = (current + buttons.length - 1) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
    buttons[next]?.click();
  }

  return (
    <section className={styles.panel} hidden={hidden} aria-label="任务日志">
      <div className={styles.toolbar}>
        <div
          className={styles.tabs}
          role="tablist"
          aria-label="日志视图"
          onKeyDown={navigateTabs}
        >
          {visibleTabs.map(({ value, label, count, Icon }) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`${id}-${value}-tab`}
              aria-controls={`${id}-${value}-panel`}
              aria-selected={activeView === value}
              tabIndex={activeView === value ? 0 : -1}
              onClick={() => setView(value)}
            >
              <Icon aria-hidden="true" />
              {label}
              <span className={styles.count}>
                {initialLoading ? "…" : count}
              </span>
            </button>
          ))}
        </div>
        <Button
          disabled={exporting}
          onClick={onExport}
          size="sm"
          variant="ghost"
        >
          <Download /> {exporting ? "正在导出…" : "导出全部日志"}
        </Button>
      </div>
      <div className={styles.context}>
        <p>
          {activeView === "analysis"
            ? "聚焦用例生成过程，查看分析快照、模型与工具调用。"
            : hasAnalysis
              ? "完整任务事件，包含 Spec 分析记录；浏览器操作日志请进入执行详情。"
              : "查看任务创建、执行与通知等事件；浏览器操作日志请进入执行详情。"}
        </p>
        <span>{activeView === "events" ? "最新在前" : "按分析时间正序"}</span>
      </div>
      {exportError && (
        <div className={styles.feedback}>
          <FormMessage message={exportError} tone="error" />
        </div>
      )}
      {eventsError && (
        <div className={styles.feedback}>
          <ErrorState
            message={`日志加载失败：${eventsError}`}
            onRetry={onRetryEvents}
          />
        </div>
      )}
      {initialLoading && (
        <div className={styles.feedback}>
          <LoadingState />
        </div>
      )}
      <div
        role="tabpanel"
        id={`${id}-events-panel`}
        aria-labelledby={`${id}-events-tab`}
        tabIndex={0}
        hidden={activeView !== "events"}
        className={styles.eventPanel}
      >
        {showRecords && <TaskEventLog events={events} />}
      </div>
      {hasAnalysis && (
        <div
          role="tabpanel"
          id={`${id}-analysis-panel`}
          aria-labelledby={`${id}-analysis-tab`}
          tabIndex={0}
          hidden={activeView !== "analysis"}
          className={styles.analysisPanel}
        >
          {analysisSnapshot}
          {showRecords && activeView === "analysis" && (
            <RunTrajectory
              loadingOlder={false}
              onLoadOlder={async () => undefined}
              page={{ hasMore: false, nextBefore: null, records: trajectory }}
            />
          )}
        </div>
      )}
    </section>
  );
}
