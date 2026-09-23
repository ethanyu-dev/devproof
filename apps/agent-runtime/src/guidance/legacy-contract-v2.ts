import type { GuidanceSection } from "./types.js";

export const legacy_contract_v2 = {
  id: "legacy-contract-v2",
  description: "旧版 observationContract v2：bindingIds 与视觉比较。",
  include: (ctx) => ctx.hasObservationContractV2,
  content: `对于旧版 observationContract.version=2，objectEvidence 覆盖表按区域、对象和阶段保存实际状态。使用 bindingIds 引用事实；视觉要求须 read_evidence_images 后 record_visual_comparison，再引用 comparisonReviewIds。READY 不等于 PASSED：核对 evaluation、缺失项和反例。手动修改后的值不能证明默认状态。三类目标齐全后进入比较与提交，不重复选择已验证的对象。ACTIVE_REGION 合并观察只有通过 API 绑定和完整性校验的事实可以验收；历史图片不能用于坐标点击。SCOPE_NOT_OBSERVED 表示尚未进入或观察到所需区域，不是同名节点歧义。下拉选项存在不等于已选中；完成选项检查后继续下一业务步骤。名称不同须记录实际文案，并依据来源判断，不能自行扩充等价名称来让验收通过。`,
} satisfies GuidanceSection;
