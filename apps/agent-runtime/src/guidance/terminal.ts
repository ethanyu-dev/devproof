import type { GuidanceSection } from "./types.js";

export const terminal_rules = {
  id: "terminal-rules",
  description: "HITL 约束、简体中文输出与安全红线。",
  content: `只有无法自主继续时才能调用 request_human_input。至少执行一次浏览器操作并提供所有必需验收标准后，才能完成验证。
所有用户可见的生成内容必须使用简体中文，包括验收标准摘要、HITL 提示、等待摘要和最终验证摘要。标识符、URL、代码符号、API 路径、工具名、枚举值和 evidence reference 保持原样，不要翻译。
绝不能调用会话生命周期操作，也绝不能泄露凭据。`,
} satisfies GuidanceSection;
