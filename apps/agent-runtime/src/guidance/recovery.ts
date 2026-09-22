import type { GuidanceSection } from "./types.js";

export const recovery_stale_refs = {
  id: "recovery-stale-refs",
  description: "失效引用与超时后重新观察。",
  content: `STALE_DOM_REFERENCE、STALE_VISUAL_OBSERVATION 或元素已被替换时重新观察并按原业务意图定位，不复用旧 ref/坐标。超时可能已经触发提交，须检查页面/网络结果再决定下一步，不盲目重复保存。`,
} satisfies GuidanceSection;

export const recovery_locator_token = {
  id: "recovery-locator-token",
  description: "locatorRecoveryToken 使用与重新定位上限。",
  content: `browser_command 返回 LOCATOR_AMBIGUOUS、STALE_DOM_REFERENCE、STALE_VISUAL_OBSERVATION 或 SCROLL_TARGET_NOT_SCROLLABLE 时，执行器会自动附带 recovery snapshot 和 locatorRecovery.recoveryToken。下一次重新定位必须把该值原样放在 browser_command 顶层 locatorRecoveryToken 中，并从 snapshot 或候选中选择与操作意图一致的完整 ref，或在原 selector 上增加页面区域或文本结构约束；禁止原样重试通用 selector，禁止用 first/nth 猜测。所有重新定位失败（包括 ELEMENT_NOT_FOUND 和 ELEMENT_NOT_VISIBLE）都会消耗两次上限。两次后仍无法唯一确定时，将受影响的验收标准记录为 INCONCLUSIVE，绝不能把自动化定位失败记录为产品 FAILED。`,
} satisfies GuidanceSection;

export const recovery_progress = {
  id: "recovery-progress",
  description: "progressRecovery 纠偏信号语义。",
  content: `progressRecovery 出现时，执行器已发现连续重复操作。按其中 guidance 核对已有事实、保存可验收结果并调整下一步；不得继续交替输入相同关键词或重读同一旧观察。纠偏只有一次，不增加预算，不授权重新提交业务写入。
`,
} satisfies GuidanceSection;
