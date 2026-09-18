import type { StepContextCall } from "@devproof/contracts";
import { bytesLabel } from "./context-display";
import styles from "./step-context.module.css";

const CONTEXT_TOKENS = 1_000_000;

export function RequestUsage({ call }: { call: StepContextCall }) {
  const tokens = call.inputTokens;
  const percent = tokens == null ? null : (tokens / CONTEXT_TOKENS) * 100;
  const label =
    percent == null
      ? "—"
      : percent > 0 && percent < 0.1
        ? "<0.1%"
        : `${Number(percent.toFixed(1))}%`;
  return (
    <span className={styles.requestUsage}>
      <span className={styles.requestSize}>
        <span>请求总大小</span>
        <strong>{bytesLabel(call.requestBytes)}</strong>
        <small>含图片 · 当前请求</small>
      </span>
      <span
        className={styles.contextUsage}
        title="按当前请求的输入 token 数计算，1M = 1,000,000 tokens"
      >
        <svg
          viewBox="0 0 56 56"
          className={styles.usageRing}
          role="img"
          aria-label={
            percent == null ? "上下文用量未返回" : `占 1M 上下文 ${label}`
          }
          data-over-budget={percent != null && percent > 100}
        >
          <circle cx="28" cy="28" r="24" className={styles.ringTrack} />
          {percent != null && percent > 0 && (
            <circle
              cx="28"
              cy="28"
              r="24"
              pathLength="100"
              strokeDasharray={`${Math.min(percent, 100)} 100`}
              transform="rotate(-90 28 28)"
              className={styles.ringFill}
            />
          )}
          <text x="28" y="28" dy="0.35em" textAnchor="middle">
            {label}
          </text>
        </svg>
        <span className={styles.tokenUsage}>
          <span>1M 上下文</span>
          <strong>
            {tokens == null
              ? call.status === "RUNNING"
                ? "用量待返回"
                : "未记录用量"
              : `${tokens.toLocaleString("en-US")} tokens`}
          </strong>
        </span>
      </span>
    </span>
  );
}
