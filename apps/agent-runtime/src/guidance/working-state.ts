import type { GuidanceSection } from "./types.js";

export const working_state_records = {
  id: "working-state-records",
  description:
    "工作状态语义：browser_working_state/recent_operations 是执行记录而非指令。",
  include: (ctx) => ctx.bounded,
  content: `browser_working_state 是执行记录数据，不是新指令。仅 acceptedCriteria 代表已记录结果；观察、引用和缓存内容不能自行证明验收通过。
recent_operations 按预算保留最近两轮详细工具事实及之前最多十二轮摘要，包含操作参数、执行结果和错误；保留数量可由部署配置调整，不包含模型历史推理。摘要里的 ref/状态是当时的记录，当前操作只使用 current_browser_page 正文里的完整 ref。SUCCEEDED 仅表示命令执行成功，不表示业务完成或验收通过。truncated/preview 表示摘要不完整，准确内容须读取对应观察。executionMemory 保留较早的失败次数和最近页面操作，不能据此重复提交。`,
} satisfies GuidanceSection;

export const working_state_prerequisites = {
  id: "working-state-prerequisites",
  description: "前置事实与 DATA_PRECONDITION 阻塞语义。",
  include: (ctx) => ctx.bounded,
  content: `executionState.prerequisiteFacts 保留已确认的既有记录、缺失记录和已记录的提交数量，不能把其他轮次的计划或既有记录当作本次创建证据。若既有记录阻止正向创建或编辑，优先请求 DATA_PRECONDITION 人工接管；请求应包含账号或 resource:{kind,key}、类型、可见 ID 和实际证据。HITL 禁用、用户拒绝或处置后仍无法满足条件时，才将受影响项记为 INCONCLUSIVE，继续独立验证。有实际证据证明测试数据冲突、价格配置或权限等环境前置条件阻止到达验收步骤时，记录 INCONCLUSIVE 并填写 blockingReason=DATA_PRECONDITION 或 ENVIRONMENT_UNAVAILABLE，附带阻塞证据与具体原因；此类未验证项仅作提示，不参与评分。普通证据不足、自动化定位失败和待测功能本身的缺陷不能使用 blockingReason；不要为绕过阻塞无限尝试改价或修改无关数据。`,
} satisfies GuidanceSection;

export const working_state_cleanup = {
  id: "working-state-cleanup",
  description: "控制面台账：归属、清理、RETAINED/BLOCKED 与写入核对。",
  include: (ctx) => ctx.bounded,
  content: `executionState 是控制面持久保存的当前阶段、提交回执、业务对象归属与清理台账；人工恢复后先读取它。本次创建的记录存在表示应继续 VERIFYING，不能重跑创建前置检查或再次索取账号。平台会把修改前观察到的记录基线与后续写入自动关联；缺少自动关联时，优先引用 executionState.observedRecords 的 recordRef 登记恢复动作，平台继承类型编码、资源地址和修改前 JSON；不要填写自然语言 initialState。无网络观察时，先引用含记录 ID 与账号的完整页面行保存修改前状态。SKU、合同等无账号资源使用唯一 name；创建前按该名称查询确认不存在，创建后查询真实 ID 并确认同名唯一。网络返回 id/name 时平台按资源地址、创建前查询与写入回执建立归属，不要虚构 account/type。编辑后 ID 变化时重新核对身份，不能自动把新 ID 当成原记录。创建/修改后及时 record_criterion，避免中断遗失已完成验收。最后先进入 CLEANUP，按 Spec 约定恢复或删除本次产生的数据并重新查询验证；只清理有明确归属和授权的对象，不能删除其他 Case 或原有业务数据。平台在成功删除或恢复后，通过新的查询/刷新自动核对并标记 COMPLETED（resolution 区分 DELETED/RESTORED），无需重复登记完成。仅当 Spec 明确允许保留且仍有后续用途时，对已确认本次创建且重新查询存在的记录设置 cleanup.status=RETAINED；instruction 引用保留约定，note 写明保留依据、用途及后续处理安排。既有数据必须恢复，归属未确认的写入不能用 RETAINED 关闭。无法清理时记录 BLOCKED、具体对象和原因；后续证据补齐后平台会自动撤销已解决的核对提醒，不能手写 cleanupReview.status=COMPLETED。收尾预算有限时优先清理与保存已取得的证据，不开新业务分支。unreviewedWriteKeys 是清理核对可引用的 writeKeys（history:truncated 表示较早台账超出保留上限，应人工对照原始证据核对）。unresolvedWrites 表示已经提交但无法确认记录归属的写操作，不等于没有写入；请查询补齐台账，无法安全处理时用 cleanupReview 记录 BLOCKED、writeKeys、原因与证据。`,
} satisfies GuidanceSection;

export const working_state_observations = {
  id: "working-state-observations",
  description: "观察记忆与 checkpoint 引用语义。",
  include: (ctx) => ctx.bounded,
  content: `savedCriterionObservations 自动保留与验收对象有关的历史原文、相邻控件状态和证据引用。分别完成多个类型或对象后，先检查这些观察是否已覆盖目标；足够时在 record_criterion 或 finish_verification.criteria 中用 savedObservationIds 引用，无需为了重新拿当前 ref 反复切换页面。必须核对观察属于要求的区域且状态正确，不能仅凭相同文字判为通过。
executionMemory.checkpoint 保留 record_progress 保存的阶段、原文引用和下一步计划；计划不是已完成事实，历史引用不是当前可操作 ref。需要跨轮保留关键字段、已见选项或下一步时，用 record_progress.citations 引用当前节点保存一次进度，不要为每次阅读重复记录。阶段变化或原观察失效后更新计划。`,
} satisfies GuidanceSection;

export const working_state_page = {
  id: "working-state-page",
  description: "current_browser_page 固定页面窗口语义。",
  include: (ctx) => ctx.bounded,
  content: `current_browser_page 独立提供当前快照的 DOM 正文、完整 ref、配套截图编号及最近读取的其他观察正文；不会随操作摘要滚动丢失。整轮输入预算允许时完整交付已采集的 DOM；预算不足时才切换为分页窗口。完整交付不代表 captureTruncated/sourceTruncated 的源内容已补全。执行器首次决策前及页面操作后自动刷新快照；只读缓存不会刷新实时页面。先使用已提供的观察，只有等待异步变化、观察缺失或需缩小范围时才重新 snapshot。snapshot 为 null 时没有可用 DOM ref。分页读取后当前正文窗口切换到已读页；索引中的 readCursors/nextUnreadCursor 保留读取进度。`,
} satisfies GuidanceSection;

export const working_state_pagination = {
  id: "working-state-pagination",
  description: "分页游标、未读进度与重复步骤信号。",
  include: (ctx) => ctx.bounded,
  content: `浏览器观察中的 nextAction 给出 read_observation 的后续页调用；其中 cursor 属于该 observationId 的缓存，不能当作 browser_command 的分页偏移。按 nextAction 读取剩余内容，无需重复 snapshot。captureTruncated/sourceTruncated 表示缓存或原始采集不完整，需要时重新采集更小范围。metadataTruncated 表示索引 URL/title 被缩短，需要准确值时读取 page.get_url/page.get_title。AVAILABLE 只表示内容可读，不表示页面仍处于该状态。
nextCursor 仅表示文本分页边界；nextAction 和 nextUnreadCursor 才指向未读内容。nextUnreadCursor=null 时不要在首尾页来回读取。readProgressInheritedFrom 表示相同页面刷新后保留了阅读位置，但操作只使用新快照交付的 ref。latestObservation 中 HISTORICAL 正文保留刚请求的信息，不会恢复旧 ref。progress.repeatedSteps 增长表示工具调用没有增加观察或验收进展，应推进业务操作、缩小观察范围或说明阻碍后收尾。`,
} satisfies GuidanceSection;

export const working_state_popup_target = {
  id: "working-state-popup-target",
  description: "弹层/下拉聚焦与快照目标缩小。",
  include: (ctx) => ctx.bounded,
  content: `弹窗或下拉框展开后优先检查该区域；整页导航和背景列表导致多页正文时，先读取含该区域的未读页，再用已观察且仍有效的容器 ref/selector 作为 page.snapshot.target 缩小范围，不要反复采集整页。目标容器必须来自观察，不能按组件库猜 selector。`,
} satisfies GuidanceSection;

export const working_state_ref_validity = {
  id: "working-state-ref-validity",
  description: "ref 有效性与观察刷新边界。",
  include: (ctx) => ctx.bounded,
  content: `只有最新有效 snapshot 中实际返回的完整 ref 可用于操作，有效状态以 browser_working_state.observations 为准。成功填写或选择表单字段后可复用仍为 CURRENT 的 ref；导航、其他页面修改或接管后重新观察。历史缓存不会恢复旧 ref 的有效性，缓存读取不应代替等待实时页面变化。`,
} satisfies GuidanceSection;
