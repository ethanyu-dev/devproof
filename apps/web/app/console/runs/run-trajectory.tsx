"use client";

import type { CSSProperties, ReactNode } from "react";
import { Fragment, useMemo, useState } from "react";
import type {
  RunTrajectoryPage,
  RunTrajectoryRecord,
} from "@devproof/contracts";
import { Search } from "lucide-react";

import css from "./run-trajectory.module.css";

const LANES: Array<{ id: RunTrajectoryRecord["lane"]; label: string }> = [
  { id: "INPUT", label: "Input" },
  { id: "ANALYSIS", label: "Analysis" },
  { id: "MODEL", label: "Model" },
  { id: "TOOLS", label: "Tools" },
];

interface RunTrajectoryProps {
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void>;
  page: RunTrajectoryPage;
}

export function RunTrajectory({
  loadingOlder,
  onLoadOlder,
  page,
}: RunTrajectoryProps) {
  const [actualDuration, setActualDuration] = useState(false);
  const [collapsedSegments, setCollapsedSegments] = useState<
    ReadonlySet<string>
  >(new Set());
  const [callsCollapsed, setCallsCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const segmentIds = useMemo(
    () =>
      Array.from(
        new Set(
          page.records.flatMap((record) =>
            record.segmentId ? [record.segmentId] : [],
          ),
        ),
      ),
    [page.records],
  );
  const allSegmentsCollapsed =
    segmentIds.length > 0 &&
    segmentIds.every((segmentId) => collapsedSegments.has(segmentId));
  const searched = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return page.records.filter((record) => {
      if (callsCollapsed && record.lane === "TOOLS") return false;
      if (!normalized) return true;
      return searchText(record).includes(normalized);
    });
  }, [callsCollapsed, page.records, query]);
  const visible = searched;
  const selected =
    page.records.find((record) => record.id === selectedId) ?? null;

  function toggleAllSegments() {
    setCollapsedSegments(
      allSegmentsCollapsed ? new Set() : new Set(segmentIds),
    );
  }

  function toggleSegment(segmentId: string) {
    setCollapsedSegments((current) => {
      const next = new Set(current);
      if (next.has(segmentId)) next.delete(segmentId);
      else next.add(segmentId);
      return next;
    });
  }

  return (
    <section className={css.root} aria-label="Agent Runtime 执行轨迹">
      <div className={css.toolbar} role="toolbar" aria-label="轨迹工具栏">
        <div className={css.actions}>
          <button
            aria-pressed={actualDuration}
            onClick={() => setActualDuration((value) => !value)}
            title={actualDuration ? "使用等宽事件" : "使用真实耗时"}
            type="button"
          >
            <ClockIcon /> Duration
          </button>
          <button
            aria-pressed={allSegmentsCollapsed}
            onClick={toggleAllSegments}
            title={allSegmentsCollapsed ? "展开全部执行段" : "折叠全部执行段"}
            type="button"
          >
            <span aria-hidden="true">{allSegmentsCollapsed ? "⊞" : "⊟"}</span>
            Turns
          </button>
          <button
            aria-pressed={callsCollapsed}
            onClick={() => setCallsCollapsed((value) => !value)}
            title={callsCollapsed ? "显示工具调用" : "隐藏工具调用"}
            type="button"
          >
            <span aria-hidden="true">{callsCollapsed ? "⊞" : "⊟"}</span>
            Calls
          </button>
        </div>
        <label className={css.search}>
          <Search aria-hidden="true" />
          <input
            aria-label="搜索轨迹"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索"
            type="search"
            value={query}
          />
        </label>
      </div>

      <TrajectoryOverview
        actualDuration={actualDuration}
        onSelect={(record) => {
          setSelectedId(record.id);
          document
            .getElementById(`trajectory-${record.id}`)
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
        }}
        records={searched}
      />

      <div
        className={css.content}
        data-inspecting={selected ? true : undefined}
      >
        <div className={css.ledger}>
          {page.hasMore ? (
            <button
              className={css.loadOlder}
              disabled={loadingOlder}
              onClick={() => void onLoadOlder()}
              type="button"
            >
              {loadingOlder ? "正在加载更早记录…" : "加载更早记录"}
            </button>
          ) : null}
          {visible.length === 0 ? (
            <p className={css.empty}>没有匹配的轨迹记录。</p>
          ) : null}
          {visible.map((record, index) => {
            const previous = visible[index - 1];
            const startsSegment =
              record.segmentId !== null &&
              previous?.segmentId !== record.segmentId;
            return (
              <Fragment key={record.id}>
                {startsSegment ? (
                  <button
                    className={css.turnHeader}
                    onClick={() => toggleSegment(record.segmentId!)}
                    type="button"
                  >
                    <span>
                      尝试 {record.attemptNumber ?? "?"} · Agent Runtime 执行段
                    </span>
                    <small>{shortSegment(record.segmentId!)}</small>
                  </button>
                ) : null}
                {!record.segmentId ||
                !collapsedSegments.has(record.segmentId) ? (
                  <button
                    className={css.record}
                    data-kind={record.kind}
                    data-selected={selectedId === record.id || undefined}
                    data-status={record.status}
                    id={`trajectory-${record.id}`}
                    onClick={() =>
                      setSelectedId((current) =>
                        current === record.id ? null : record.id,
                      )
                    }
                    type="button"
                  >
                    <span className={css.dot} aria-hidden="true" />
                    <span className={css.tag}>{record.kind}</span>
                    <span className={css.summary}>
                      <b>{record.title}</b>
                      <span>{recordSummary(record)}</span>
                    </span>
                    <span className={css.duration}>
                      {formatDuration(record.durationMs)}
                    </span>
                  </button>
                ) : null}
              </Fragment>
            );
          })}
        </div>

        {selected ? <TrajectoryInspector record={selected} /> : null}
      </div>
    </section>
  );
}

function TrajectoryOverview({
  actualDuration,
  onSelect,
  records,
}: {
  actualDuration: boolean;
  onSelect: (record: RunTrajectoryRecord) => void;
  records: RunTrajectoryRecord[];
}) {
  const timing = useMemo(() => timelineTiming(records), [records]);
  return (
    <div className={css.overview} aria-label="轨迹时间轴">
      {LANES.map((lane) => (
        <div className={css.lane} key={lane.id}>
          <span className={css.laneLabel}>{lane.label}</span>
          <div className={css.track}>
            {records.flatMap((record, index) => {
              if (record.lane !== lane.id) return [];
              const style = timelineStyle(
                record,
                index,
                records.length,
                timing,
                actualDuration,
              );
              return [
                <button
                  aria-label={`${record.kind}: ${record.title}`}
                  data-lane={record.lane}
                  data-status={record.status}
                  key={record.id}
                  onClick={() => onSelect(record)}
                  style={style}
                  title={`${record.title} · ${formatDuration(record.durationMs)}`}
                  type="button"
                />,
              ];
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function TrajectoryInspector({ record }: { record: RunTrajectoryRecord }) {
  return (
    <aside className={css.inspector} aria-label="轨迹记录详情">
      <header>
        <div>
          <span className={css.tag}>{record.kind}</span>
          <b>{record.title}</b>
        </div>
        <small>#{record.sequence}</small>
      </header>
      <dl>
        <div>
          <dt>Status</dt>
          <dd>{record.status}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(record.durationMs)}</dd>
        </div>
        <div>
          <dt>Attempt / Step</dt>
          <dd>
            {record.attemptNumber ?? "—"} / {record.step ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{new Date(record.startedAt).toLocaleString("zh-CN")}</dd>
        </div>
      </dl>
      <div className={css.inspectorGrid}>
        <InspectorValue label="Input" value={record.input} />
        <InspectorValue label="Output" value={record.output} />
      </div>
      {record.error ? (
        <InspectorValue label="Error" value={record.error} />
      ) : null}
      {Object.keys(record.metadata).length ? (
        <InspectorValue label="Metadata" value={record.metadata} />
      ) : null}
    </aside>
  );
}

function InspectorValue({ label, value }: { label: string; value: unknown }) {
  return (
    <section className={css.inspectorValue}>
      <h4>{label}</h4>
      <pre>{prettyValue(value)}</pre>
    </section>
  );
}

function ClockIcon(): ReactNode {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="5.25" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  );
}

function timelineTiming(records: RunTrajectoryRecord[]) {
  const starts = records.map((record) => Date.parse(record.startedAt));
  const ends = records.map((record, index) =>
    record.completedAt
      ? Date.parse(record.completedAt)
      : starts[index]! + Math.max(record.durationMs ?? 0, 1),
  );
  return {
    end: ends.length > 0 ? Math.max(...ends) : 1,
    start: starts.length > 0 ? Math.min(...starts) : 0,
  };
}

function timelineStyle(
  record: RunTrajectoryRecord,
  index: number,
  count: number,
  timing: { start: number; end: number },
  actualDuration: boolean,
): CSSProperties {
  if (!actualDuration) {
    return {
      left: `${(index / Math.max(1, count)) * 100}%`,
      width: `max(3px, ${(0.72 / Math.max(1, count)) * 100}%)`,
    };
  }
  const domain = Math.max(1, timing.end - timing.start);
  const start = Date.parse(record.startedAt);
  return {
    left: `${((start - timing.start) / domain) * 100}%`,
    width: `max(3px, ${(Math.max(record.durationMs ?? 0, 1) / domain) * 100}%)`,
  };
}

function searchText(record: RunTrajectoryRecord) {
  return [
    record.kind,
    record.title,
    record.actor,
    record.status,
    compactValue(record.input),
    compactValue(record.output),
    compactValue(record.metadata),
    record.error ?? "",
  ]
    .join(" ")
    .toLocaleLowerCase();
}

function recordSummary(record: RunTrajectoryRecord) {
  const input = compactValue(record.input);
  const output = compactValue(record.output);
  if (input && output) return `${input} → ${output}`;
  return input || output || record.error || record.status;
}

function compactValue(value: unknown) {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(value) ?? String(value));
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > 360 ? `${compact.slice(0, 359)}…` : compact;
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

function formatDuration(milliseconds: number | null) {
  return milliseconds === null
    ? "—"
    : `${Math.round(milliseconds).toLocaleString("en-US")} ms`;
}

function shortSegment(segmentId: string) {
  const [taskId, fencingToken] = segmentId.split(":");
  return `${taskId?.slice(0, 8) ?? segmentId} · lease ${fencingToken ?? "?"}`;
}
