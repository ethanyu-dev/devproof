export function recoveryClosureLabel(state: string) {
  return (
    (
      {
        OBSERVED: "原执行仍合法运行",
        REQUESTED: "等待关闭",
        CLOSING: "正在关闭浏览器",
        VERIFIED: "浏览器关闭已确认",
        RETRY_WAIT: "等待重试关闭",
        WAITING_RUNTIME: "等待节点连接",
        NEEDS_OPERATOR: "需要管理员核验",
      } as Record<string, string>
    )[state] ?? "关闭状态待确认"
  );
}
export function recoveryWriteLabel(state: string) {
  return (
    (
      {
        UNASSESSED: "写入范围待核对",
        UNKNOWN: "业务写入结果待核实",
        NOT_APPLICABLE: "无业务写入保护",
        NO_WRITE_VERIFIED: "已证实没有写入",
        CONFIRMED: "业务结果已确认",
        RESOLVED: "业务结果已人工核实",
      } as Record<string, string>
    )[state] ?? "业务结果状态待确认"
  );
}
