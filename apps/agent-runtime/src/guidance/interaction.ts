import type { GuidanceSection } from "./types.js";

export const interaction_select_dropdown = {
  id: "interaction-select-dropdown",
  description: "原生/自定义下拉与 Canvas 输入操作。",
  content: `原生 <select> 才能使用 page.select；自定义下拉先点击展开，再观察 DOM + 图片，点击当前可见选项，最后检查显示值和业务反馈。看到隐藏、重复候选时不能 first/nth 猜测。Canvas/自绘输入先视觉点击聚焦，再启用 input 工具组用不带 target 的 page.type 输入文本，必要时 page.press；操作后验证结果。`,
} satisfies GuidanceSection;

export const interaction_scroll = {
  id: "interaction-scroll",
  description: "滚动容器选择与 scrollFeedback 状态语义。",
  content: `page.scroll 的 target 必须是滚动容器本身，不是列表中的选项行。overflow:hidden 也可能是可程序化滚动容器，按快照中的 scrollY/scrollX 判断。每次滚动约容器可见高度的 75%，保留重叠内容；滚动后先检查新快照的选项是否变化。scrollFeedback.status=MOVED 只证明位移，AT_BOUNDARY 表示本方向边界，NO_MOVEMENT 表示没有效果，UNVERIFIED 或缺少该字段时效果尚未确认；settled 只表示局部短暂稳定，不保证异步业务加载完成。`,
} satisfies GuidanceSection;

export const interaction_scroll_errors = {
  id: "interaction-scroll-errors",
  description: "SCROLL 错误恢复与搜索兜底。",
  content: `SCROLL_TARGET_NOT_SCROLLABLE 要求从新快照改用真实容器 ref；SCROLL_NO_PROGRESS 表示当前方案已经无效，不能只更换 ref、距离或重复读取缓存。改用其他容器、反向滚动或已确认支持的搜索输入框；输入短关键词并确认过滤完成，再选择实际显示的目标。搜索改变条件后重新计算覆盖范围。观察索引可省略较旧条目（observationIndexOmitted），已有 observationId 仍可按缓存可用性读取；未列出不表示已读取或已删除。`,
} satisfies GuidanceSection;

export const interaction_dropdown_search = {
  id: "interaction-dropdown-search",
  description: "下拉搜索策略与键盘组合。",
  content: `下拉搜索要从实际页面文案出发：完整业务名称或内部枚举搜不到时，尝试较短关键词，再检查可见选项。连续清空并重复同一搜索而无进展时更换观察方式，不要循环。选项名称相似不能证明其内部枚举映射；要读取实际 DOM 值或对应网络证据。键盘组合使用 Control+A，不能使用 CTRL+A。`,
} satisfies GuidanceSection;
