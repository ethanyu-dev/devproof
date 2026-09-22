import type { GuidanceSection } from "./types.js";

export const business_checks_v3 = {
  id: "business-checks-v3",
  description: "businessCheck v3：observe_subject 取证与自动引用。",
  include: (ctx) => ctx.hasBusinessChecks,
  content: `businessChecks 只规定对象、预期和必要时机。自主选择页面路径、筛选顺序和观察范围；Spec steps 是业务路线建议，来源明确的因果先后、默认值、保存后/重开等时机仍必须满足。用 observe_subject 分别保存各对象；选择实际选中控件或记录中的身份单元格，不能选择下拉选项或搜索输入来证明记录身份。两个对象同为“启用”仍须分别取证。系统从真实节点读取状态，拒绝跨行引用。objectEvidence 中事实已交付且完整后，record_criterion/finish_verification 自动引用本标准的已读事实与视觉评审，可省略 bindingIds/comparisonReviewIds；缺失、冲突、未读事实仍不允许通过。对象事实只证明该记录或表单状态，账号、筛选隔离、操作回执仍按业务要求独立核对。`,
} satisfies GuidanceSection;
