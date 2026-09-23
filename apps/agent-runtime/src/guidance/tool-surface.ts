import type { GuidanceSection } from "./types.js";

export const tool_surface_grouped = {
  id: "tool-surface-grouped",
  description:
    "分组工具面：核心操作先露出，其他模块按需 enable_browser_tools。",
  include: (ctx) => ctx.groupedTools,
  content: `browser_command 默认只公布核心操作。其他操作先通过 enable_browser_tools 启用相应模块；模块目录见该工具定义，完整参数在下一轮公布。启用模块不会执行操作，也不表示 Runtime 一定支持该操作。page.open 是别名，统一使用 page.navigate。`,
} satisfies GuidanceSection;
