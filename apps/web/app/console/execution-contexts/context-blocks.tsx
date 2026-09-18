"use client";

import { useMemo, useState } from "react";
import {
  ChevronDown,
  FileText,
  Gauge,
  Eye,
  History,
  Monitor,
  Target,
  Wrench,
} from "lucide-react";
import {
  STEP_CONTEXT_SECTIONS,
  type StepContextContent,
  type StepContextSection,
} from "@devproof/contracts";
import { ValueView } from "./context-value";
import { bytesLabel } from "./context-display";
import styles from "./step-context.module.css";

const blockIcons = {
  fixedTask: FileText,
  executionState: Gauge,
  savedObservations: Eye,
  recentOperations: History,
  currentPage: Monitor,
  currentGoal: Target,
  tools: Wrench,
} satisfies Record<StepContextSection, typeof FileText>;

export function ContextBlocks({
  sections,
  completeness,
}: Pick<StepContextContent, "sections" | "completeness">) {
  return (
    <section aria-label="本轮上下文" className={styles.contextBlocks}>
      <div className={styles.blocksHeading}>
        <h3>
          本轮上下文 <span>7 个内容块</span>
        </h3>
        <p>
          {completeness === "FULL" ? "本轮实际模型输入" : "历史留存预览"} ·
          点击卡片展开，可同时展开多块
        </p>
      </div>
      <div className={styles.contextGrid}>
        {STEP_CONTEXT_SECTIONS.map(([key, label], index) => (
          <ContextBlock
            key={key}
            section={key}
            label={label}
            index={index}
            value={sections[key]}
          />
        ))}
      </div>
    </section>
  );
}

function ContextBlock({
  section,
  label,
  index,
  value,
}: {
  section: StepContextSection;
  label: string;
  index: number;
  value: unknown;
}) {
  const [open, setOpen] = useState(false);
  const Icon = blockIcons[section];
  const summary = useMemo(() => {
    const raw = JSON.stringify(value);
    return {
      size: bytesLabel(new TextEncoder().encode(raw ?? "").byteLength),
      shape:
        value == null
          ? "未提供"
          : Array.isArray(value)
            ? `${value.length} 项`
            : typeof value === "object"
              ? `${Object.keys(value).length} 个字段`
              : "文本",
      preview: previewText(value),
    };
  }, [value]);
  return (
    <details
      className={styles.contextBlock}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label={`${open ? "收起" : "展开"}${label}`}>
        <div className={styles.blockTitle}>
          <span className={styles.blockIcon}>
            <Icon size={17} />
          </span>
          <h4>{label}</h4>
          <span className={styles.blockNumber}>0{index + 1}</span>
          <ChevronDown size={16} className={styles.blockChevron} />
        </div>
        <p className={styles.blockPreview}>{summary.preview}</p>
        <div className={styles.blockFooter}>
          <span>
            {summary.shape} · {summary.size}
          </span>
          <span>{open ? "收起详情" : "展开查看详情"}</span>
        </div>
      </summary>
      {open && (
        <div className={styles.blockContent}>
          <ContextContentView value={value} label={label} />
        </div>
      )}
    </details>
  );
}

/** Only the collapsed preview is shortened. Expanded views use the complete value. */
function previewText(value: unknown): string {
  const lines: string[] = [];
  let remaining = 320;
  let visited = 0;
  function visit(item: unknown, key: string, depth: number) {
    if (remaining <= 0 || ++visited > 80 || depth > 8 || item == null) return;
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      const text = String(item);
      if (!text.trim()) return;
      const snippet = text.startsWith("data:image/")
        ? "[页面截图]"
        : text.slice(0, remaining).replace(/\s+/gu, " ");
      const line = key ? `${key}: ${snippet}` : snippet;
      lines.push(line);
      remaining -= line.length;
    } else if (Array.isArray(item)) {
      for (const child of item) {
        visit(child, key, depth + 1);
        if (remaining <= 0 || visited > 80) break;
      }
    } else if (typeof item === "object") {
      for (const [name, child] of Object.entries(item)) {
        visit(child, name, depth + 1);
        if (remaining <= 0 || visited > 80) break;
      }
    }
  }
  visit(value, "", 0);
  return (
    lines.join("\n") ||
    (value == null ? "本轮未提供此项。" : "暂无内容，展开可查看原始结构。")
  );
}

/** The raw view keeps every field and original string; no preview truncation. */
export function ContextContentView({
  value,
  label,
}: {
  value: unknown;
  label: string;
}) {
  const [structured, setStructured] = useState(false);
  const raw = useMemo(
    () =>
      typeof value === "string"
        ? value
        : (JSON.stringify(value, null, 2) ?? "null"),
    [value],
  );
  return (
    <div>
      <div className={styles.contentToolbar}>
        <div
          role="group"
          aria-label={`${label}查看方式`}
          className={styles.viewSwitch}
        >
          <button
            type="button"
            aria-pressed={!structured}
            onClick={() => setStructured(false)}
          >
            完整原文
          </button>
          <button
            type="button"
            aria-pressed={structured}
            onClick={() => setStructured(true)}
          >
            结构化查看
          </button>
        </div>
        <span>{raw.length.toLocaleString()} 字符 · 全部内容</span>
      </div>
      <div
        className={styles.contentViewport}
        role="region"
        aria-label={`${label}详情`}
        tabIndex={0}
      >
        {structured ? (
          <ValueView value={value} />
        ) : (
          <pre className={styles.fullText}>{raw}</pre>
        )}
      </div>
    </div>
  );
}
