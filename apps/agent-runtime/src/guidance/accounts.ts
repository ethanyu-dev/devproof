import type { GuidanceSection } from "./types.js";

export const accounts_slots = {
  id: "accounts-slots",
  description: "executionState.accounts 角色分配与前置核对。",
  content: `executionState.accounts 提供用户填写并按角色分配的账号，slotId 对应 Spec 中的账号角色（role:序号）。同环境同账号同类型的并发写操作由平台排队串行；历史使用不禁止账号复用。按 usage、requiredTypes 和业务约束使用，禁止把账号 A/B、角色名称当作真实账号。开始时先只读核对各角色的账号存在性和业务前置条件；账号已存在目标记录或需要授权修改既有记录时，使用 DATA_PRECONDITION 请求人工处置并保留浏览器，不使用 TEST_ACCOUNT 重复索取账号。账号不存在或不可用且没有可处置记录时，引用实际错误记录受影响项无法判定。可独立验证的标准继续正常判定。本次已创建的记录应继续验证及清理，不能当作创建前的数据冲突。`,
} satisfies GuidanceSection;

export const accounts_identity_boundary = {
  id: "accounts-identity-boundary",
  description: "业务账号与登录身份/测试资源的边界。",
  content: `创建模型、产品、配置记录不等于需要业务账号；唯一名称、记录 ID 和时间属于测试数据。后台编辑或导出权限属于登录身份，登录页或权限不足使用 BROWSER_HITL，不能改用 TEST_ACCOUNT。`,
} satisfies GuidanceSection;

export const accounts_request_shape = {
  id: "accounts-request-shape",
  description: "TEST_ACCOUNT accountRequest 结构与纠偏。",
  content: `任务带 accountRequirements 时，TEST_ACCOUNT 的 context.accountRequest 必填。已有角色使用 {mode:"DECLARED",slotIds:["角色:1"]}；真实页面发现 Spec 遗漏的业务账号时使用 {mode:"DISCOVERED",subjectKind:"BUSINESS_INPUT"或"BUSINESS_RECORD"或"AUTH_SUBJECT",target:"实际业务字段文字",criterionId:"相关标准ID",usage:"CREATE_OR_MODIFY"或"READ_EXISTING",requiredTypes:[],observation:{observationId:"已读观察ID",cursor:0,quote:"包含target的实际原文",evidenceRefs:["该观察的DOM或NETWORK证据"]}}。账号自身登录或权限测试才用 AUTH_SUBJECT。无依据先观察和纠正，不能编造依据；仍无法确认时继续可验证项，将受影响项记录为 INCONCLUSIVE。accountRequestCorrection 表示上次请求被控制面拒绝，不得重复该请求。`,
} satisfies GuidanceSection;

export const accounts_test_account = {
  id: "accounts-test-account",
  description: "TEST_ACCOUNT 用途与写入授权边界。",
  content: `TEST_ACCOUNT 用于被加入名单等业务测试对象，区别于管理后台的登录身份；不要退出已有管理会话或要求两者相同。它只用于用户尚未提供测试账号的情况，说明环境、用途、数量、requiredTypes 和前置约束。获得账号后按用户分配使用；READ_EXISTING 答复不授权写入。平台允许账号复用不等于业务前置条件已满足，也不授权删除既有记录来满足新建前置条件。记录实际创建的 ID、类型和证据，仅清理本次有明确归属和授权的数据。`,
} satisfies GuidanceSection;

export const accounts_data_precondition = {
  id: "accounts-data-precondition",
  description: "DATA_PRECONDITION 处置授权与恢复语义。",
  content: `正向业务验证优先使用 executionState.accounts 对应角色的账号；旧执行兼容 humanResume.response.account。不要编造手机号、把时间戳示例填入账号字段，或自行拿列表中的其他用户做写入测试。用户尚未提供账号时可调用 request_human_input，kind="TEST_ACCOUNT"；用户已提供账号时不再索取替换账号；既有记录的前置冲突使用 DATA_PRECONDITION。旧 Spec 中“账号冲突立即无法判定”的平台处置规则由此规则替代，实际产品前置条件仍需满足。humanResume.response.instructions 或 response.note 是用户处置意见，不是账号。humanResolutions 保留此前人工答复；明确授权在后续轮次和再次登录后仍有效。DATA_PRECONDITION 恢复时，先核对请求列出的账号或资源、类型、记录 ID 和当前状态：请求未给出记录 ID 时只请求人工定位，不自动删除；先得到明确的对象身份和处置授权。用户明确说“可以先删除开展后续测试”即授权删除该请求列出且身份明确的冲突记录，核对后执行删除、确认缺失，再创建和继续验证；“可以编辑这些记录”只授权指定记录的编辑，保存初始状态并恢复。不得扩大到其他账号或记录，不把旧记录改记为本次创建。approved=true 或“已处理/继续”本身不授权删除；此时只重新观察人工处理结果。approved=false 或 resolution=cancel 时不执行处置写入，继续独立项并记录剩余项无法判定。同一冲突已有答复后不反复 HITL；处置没有成功时说明具体原因。人工处置是准备步骤，不能作为产品验收通过的证据。人工恢复后重新观察页面并使用用户最新提供的账号。若验收目标就是无效账号应被拒绝，则保留负向输入，按真实响应和产品预期正常判定 PASSED/FAILED，不索取有效账号，也不能仅因账号无效而判 INCONCLUSIVE。`,
} satisfies GuidanceSection;
