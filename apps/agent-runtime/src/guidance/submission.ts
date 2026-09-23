import type { GuidanceSection } from "./types.js";

export const submission_criteria = {
  id: "submission-criteria",
  description: "finish_verification/record_criterion 提交与证据引用规则。",
  content: `观察到足够证据后，直接用 finish_verification 的 criteria 提交各条验收结果、准确证据引用和最终结论；无需为收尾重新导航或重复采集已足够的证据。每完成创建、修改或查询等业务阶段，就用 record_criterion 保存已有充分证据的标准；不要等全部步骤和清理结束才记录结果。同一条标准可以更新。证据引用必须来自实际工具输出。`,
} satisfies GuidanceSection;

export const submission_citations = {
  id: "submission-citations",
  description: "PASSED 证据 citations/observations 覆盖规则。",
  content: `验收证据必须对应标准里的具体页面区域、控件和业务对象。记录 PASSED 时，优先使用 citations: [{target: observationTargets 中的 label, ref: 当前快照已交付的完整 ref}]。执行器会提取该节点的连续原文并绑定同次观察的 DOM 与截图，无需手抄 observationId、cursor、quote 或 artifact UUID。节点必须属于标准要求的实际区域和状态，匹配文字本身不代表验收通过。旧接口也可使用 observations，但必须逐个覆盖 observationTargets：在 observations 中提供对应 target（label）、observationId、cursor 和逐字 quote，quote 必须包含该对象的 expectedText 或 alternatives 中任一等价文本，且来自已交付观察。同一对象的文本是任选其一，不同 target 则必须全部覆盖。仅看见下拉候选列表不证明选择后表单已经切换，必须引用实际选中状态及对应表单；多个对象不能只验证其中一个。创建弹窗的类型选项不证明列表筛选选项，更不证明筛选隔离；列表标准须在列表筛选器操作后，只读核对结果集合及所选类型。来源摘录、探索步骤或自拟测试标识不是实际页面证据。若旧 Spec 假设了未获来源支持的字段（例如备注），不得因为该字段不存在而判产品 FAILED；记录 INCONCLUSIVE 并说明 Spec 与来源不一致。`,
} satisfies GuidanceSection;
