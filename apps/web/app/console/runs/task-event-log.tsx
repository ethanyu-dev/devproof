import { displayLabel } from "@/lib/display-text";
import { ChevronRight } from "lucide-react";
import { isRecord, prettyValue } from "./task-display";
import { agentEventTitle } from "./spec-generation-trajectory";
import type { TaskEvent } from "./task-types";
import styles from "./task-logs.module.css";

export function TaskEventLog({ events }: { events: TaskEvent[] }) {
  if (!events.length)
    return (
      <p className={styles.empty}>暂无任务事件，任务运行后会在这里更新。</p>
    );
  return (
    <div
      className={styles.eventsViewport}
      role="region"
      aria-label="任务事件列表"
      tabIndex={0}
    >
      <div className={styles.eventColumns} aria-hidden="true">
        <span />
        <span>时间</span>
        <span>事件</span>
        <span>来源</span>
      </div>
      <ol className={styles.events} aria-label="任务事件记录">
        {[...events].reverse().map((event) => (
          <li key={event.sequence}>
            <details>
              <summary>
                <ChevronRight className={styles.chevron} />
                <time dateTime={event.occurredAt}>
                  {new Date(event.occurredAt).toLocaleString("zh-CN", {
                    hour12: false,
                  })}
                </time>
                <strong>
                  {event.kind.startsWith("agent.")
                    ? agentEventTitle(
                        event.kind,
                        isRecord(event.payload) ? event.payload : {},
                      )
                    : displayLabel(event.kind)}
                </strong>
                <span>
                  {event.actor === "SPEC_ANALYSIS_WORKER"
                    ? "Spec 分析"
                    : displayLabel(event.actor)}
                </span>
              </summary>
              <pre>{prettyValue(event.payload)}</pre>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
