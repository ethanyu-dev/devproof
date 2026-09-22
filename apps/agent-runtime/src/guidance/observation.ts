import type { GuidanceSection } from "./types.js";

export const observation_navigation_wait = {
  id: "observation-navigation-wait",
  description: "导航等待与 networkidle 约束。",
  content: `客户端导航后要等待明确的 selector 或文本。除非确定应用最终会完全空闲，否则避免使用 networkidle。`,
} satisfies GuidanceSection;

export const observation_async_completion = {
  id: "observation-async-completion",
  description: "异步完成判定：AFTER_ACTION 截图与加载结束证据。",
  content: `搜索、筛选、保存等操作成功，只代表输入事件已执行；自动附带的 AFTER_ACTION 截图可能仍是加载遮罩下的旧表格。不能用它作为 PASSED/FAILED 的验收证据。先在 DOM + 图片中检查转圈、遮罩及结果更新，使用已观察到的 selector 等待 hidden，或用 page.snapshot/page.screenshot 重新观察直到加载结束，再引用新证据。domcontentloaded 不能证明 SPA 查询完成；page.wait 的 kind=text 等待文本出现，不能用它等待 Loading 消失。加载一直不结束或无法确定结果时应 INCONCLUSIVE；不要反复点击搜索/保存。`,
} satisfies GuidanceSection;

export const observation_snapshot = {
  id: "observation-snapshot",
  description: "page.snapshot 语义：真实 DOM、不预设组件库结构。",
  content: `page.snapshot 提供实际 DOM 节点、文本、原生标签、值和 ref，同时附带视口截图。网站不需要实现 ARIA 或特定组件语法，不依赖 accessibility role。观察整个页面及弹层，不要按框架名字预设 DOM 结构。`,
} satisfies GuidanceSection;

export const observation_viewport_image = {
  id: "observation-viewport-image",
  description: "视口图片与视觉观察证据语义。",
  content: `current_browser_viewport 中的 image_url 才是你实际看到的图片；截图编号或文件名不代表看过图。DOM 不足（自定义控件、Canvas、封闭 Shadow DOM）时，结合截图判断，用 page.click 的 point 和该图 observationId 作为 visualObservationId 操作；不能猜坐标。滚动、导航、窗口变化或旧图失效后重新观察。图片缺失时先 page.screenshot，不能假装视觉成功。`,
} satisfies GuidanceSection;

export const observation_coverage = {
  id: "observation-coverage",
  description: "DOM 覆盖边界与“不存在”断言规则。",
  content: `DOM 快照仅覆盖当前视口与未被滚动容器裁剪的内容；captureTruncated/sourceTruncated/nextCursor 也表示证据尚不完整。断言选项“不存在”之前，必须在已确认支持搜索的控件中使用合理短关键词并确认搜索完成，或从列表顶部逐段滚动到末尾、观察每一段。使用带 scrollY/scrollX 的容器 ref 作为 page.scroll.target，避免滚动背景页面；atEnd=false 表示还有未见内容，到末尾一次也不代表已检查中间全部内容。无 DOM 时根据图片中的滚动条判断，在下拉内部点击聚焦后滚动，并重新截图确认选项确实变化。虚拟列表、搜索无效或范围无法穷尽时记录 INCONCLUSIVE，不能凭当前几项判 FAILED。`,
} satisfies GuidanceSection;
