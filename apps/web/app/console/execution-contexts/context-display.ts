export function attemptHref(runId: string, attempt: number) {
  return `/console/execution-contexts/${encodeURIComponent(runId)}/${attempt}`;
}
export function statusLabel(status: string) {
  return (
    (
      {
        PENDING: "等待执行",
        RUNNING: "执行中",
        WAITING_HUMAN: "等待人工",
        SUCCEEDED: "已完成",
        FAILED: "失败",
        CANCELLED: "已取消",
        TIMED_OUT: "超时",
        INTERRUPTED: "已中断",
      } as Record<string, string>
    )[status] ?? status
  );
}
export function bytesLabel(bytes: number | null | undefined) {
  return bytes == null
    ? "—"
    : bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function timestamp(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
