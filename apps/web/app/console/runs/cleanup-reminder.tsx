import styles from "./cleanup-reminder.module.css";

export interface CleanupRecord {
  recordRef?: string;
  id: string;
  type?: string;
  account?: string;
  cleanup?: {
    status: string;
    resolution?: string;
    instruction: string;
    note?: string;
  };
}

export function CleanupRecords({ records }: { records: CleanupRecord[] }) {
  const tracked = records.filter((r) => r.cleanup);
  if (!tracked.length) return null;
  const pending = tracked.filter(
    (r) => !["COMPLETED", "RETAINED"].includes(r.cleanup!.status),
  ).length;
  return (
    <details className={styles.reminder}>
      <summary>
        测试数据收尾 · {tracked.length} 条记录
        {pending ? ` · ${pending} 条待核对` : " · 已处理"}
      </summary>
      <p>收尾记录独立保存，不影响验证结果。</p>
      {tracked.map((record) => {
        const cleanup = record.cleanup!;
        const label =
          cleanup.status === "RETAINED"
            ? "按计划保留"
            : cleanup.status === "COMPLETED"
              ? cleanup.resolution === "DELETED"
                ? "已清理"
                : cleanup.resolution === "RESTORED"
                  ? "已恢复"
                  : "已完成收尾"
              : cleanup.status === "BLOCKED"
                ? "待人工核对"
                : "待收尾";
        return (
          <div
            className={styles.record}
            key={record.recordRef ?? `${record.type}:${record.id}`}
          >
            <strong>
              {label} · 记录 {record.id}
            </strong>
            <p>
              {[record.type, record.account && `账号 ${record.account}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p>{cleanup.instruction}</p>
            {cleanup.note && <p>{cleanup.note}</p>}
          </div>
        );
      })}
    </details>
  );
}

export function CleanupReminder({ note }: { note: string }) {
  const count = note.match(/(\d+)\s*笔提交尚未确认记录归属/u)?.[1];
  const detail = note.replace(/^清理未完成[：:][；;]?\s*/u, "").trim();
  return (
    <aside className={styles.reminder} aria-label="后续收尾提醒">
      <div className={styles.heading}>
        <strong>后续收尾</strong>
        <span>不影响验证结果</span>
      </div>
      <p>
        {count
          ? `${count} 笔写入的归属记录待核对。`
          : "测试数据的清理或恢复记录待核对。"}
      </p>
      <details>
        <summary>查看收尾记录</summary>
        <p>{detail || "请后续核对测试数据的清理、恢复和归属记录。"}</p>
      </details>
    </aside>
  );
}
