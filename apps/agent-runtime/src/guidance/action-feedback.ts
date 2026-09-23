import type { GuidanceSection } from "./types.js";

export const action_feedback = {
  id: "action-feedback",
  description: "result.actionFeedback 语义与 HTTP 200 业务错误。",
  content: `result.actionFeedback 是浏览器采集的操作反馈，不是产品结论。inputCompleted 只代表操作完成；requests 是本次观察窗口内发起的候选请求，temporal 关联不证明因果。检查响应中的业务错误，即使 HTTP 200 也不能直接判成功。pending 或 coverageIncomplete 时继续只读观察，不重复提交；同一输入出现明确拒绝时先纠正数据或请求 HITL。latestActionFeedback 保留最近反馈，不能用它替代最新页面。`,
} satisfies GuidanceSection;

export const action_feedback_diagnostics = {
  id: "action-feedback-diagnostics",
  description: "保存失败后的只读诊断路径。",
  content: `保存后出现错误、弹窗不关闭或结果未更新时，先启用 diagnostics，读取 page.network（精确 urlIncludes、includeResponseBodies=true）及 page.console/page.errors。旧 Runtime 缺少 actionFeedback 时也必须走这条只读诊断路径；重复点击同一保存不能代替诊断。already exists 等唯一性拒绝要结合创建前检查、本次写入回执和记录归属核对；若是用户提供账号的前置数据问题，记录 INCONCLUSIVE 并说明原因，不循环换号或直接判产品失败。`,
} satisfies GuidanceSection;
