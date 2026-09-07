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

export function recoveryGuidance(state: string, errorCode: string | null) {
  if (state === "OBSERVED")
    return "原执行仍持有有效许可，当前无需关闭。请从关联执行查看进度。";
  if (state === "VERIFIED")
    return "浏览器关闭已确认。是否解除业务数据保护，仍取决于下方的业务结果状态。";
  if (state === "WAITING_RUNTIME")
    return "等待执行节点重新连接。检查节点服务和网络；重新连接后系统会再次检查关闭状态。";
  if (state === "NEEDS_OPERATOR") {
    if (
      errorCode === "CLOSURE_UNVERIFIED" ||
      errorCode === "LAUNCH_IDENTITY_UNAVAILABLE"
    )
      return "无法确认旧会话的浏览器和网络进程已完全终止，自动重试已暂停。请核验原宿主；条件变化后可重试。缺少可核验的历史身份时，进入节点排空流程处理。";
    if (errorCode === "UNSUPPORTED_CLOSURE_EVIDENCE")
      return "节点尚不具备所需的关闭证明能力。请检查 Runtime 版本和宿主身份，升级并连接后重新检查；历史会话仍可能需要排空核验。";
    return "自动关闭需要管理员处理。请检查节点和诊断信息，条件变化后重试，或查看节点排空范围。";
  }
  return "系统正在处理会话关闭。此页面自动更新状态，请等待关闭结果；重新检查不会降低关闭证明要求。";
}

export function recoveryNeedsWriteReview(item: {
  closureState: string;
  writeOutcomeState: string;
  resolvedAt: string | null;
}) {
  return (
    item.closureState === "VERIFIED" &&
    !item.resolvedAt &&
    ["UNKNOWN", "UNASSESSED"].includes(item.writeOutcomeState)
  );
}
