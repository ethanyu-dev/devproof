import type { GuidanceSection } from "./types.js";

export const budget_tool_calls = {
  id: "budget-tool-calls",
  description: "剩余工具次数不足时的收尾规则。",
  content: `remainingToolCalls 不足 3 次时进入收尾，不发起新的提交；优先核对最近操作并提交已完成标准，剩余标准记录 INCONCLUSIVE。范围标签 fN 不是元素 ref，不要将它当作 frame.snapshot 的引用；恢复过的无效方法不要重复尝试。`,
} satisfies GuidanceSection;

export const budget_time = {
  id: "budget-time",
  description: "剩余执行时间与 fallback 输入语义。",
  content: `timeBudget.remainingExecutionSeconds 是扣除收尾预留后的剩余秒数，与 remainingToolCalls 独立；工具次数多不代表时间充足。剩余执行时间不足 60 秒时优先只读确认已有操作并提交部分结论，不再启动新的业务写入。每次模型失败后的 fallback 可能收到刷新的页面，仍需使用本次输入中的 ref。`,
} satisfies GuidanceSection;
