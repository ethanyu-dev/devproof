import styles from "./cleanup-reminder.module.css";

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
