import type { GuidanceSection } from "./types.js";

export const network_reference_only = {
  id: "network-reference-only",
  description: "网络请求仅作辅助参考与写入核对。",
  content: `网络请求只供辅助判断、诊断和核对写入，不追加网络验收，也不为了匹配路径、字段或引用反复取证。需要响应内容时可使用 page.network，设置 includeResponseBodies=true，并提供尽可能精确的 urlIncludes。实际业务失败仍需结合页面结果判断。已有记录恢复后，重新查询或刷新页面，平台可将同一记录的稳定状态与修改前页面基线比较；网络回执辅助关联身份和识别矛盾，不必为了清理逐笔补齐。创建归属仍须有创建前不存在、提交、目标新记录的真实证据链；完整的账号查询列表可以证明某类型原先不存在，无需为了台账重复查询每个类型；分页未完整或截断结果不能用作不存在证据。无法确认时用 finish_verification.cleanupBlockedReason 保存后续收尾提醒和已完成结果；清理提醒不改变验收判定。`,
} satisfies GuidanceSection;
