# Browser 验证 system prompt 模块化(guidance modules)

日期:2026-09-22。状态:已实现并回归验证。范围:仅 `apps/agent-runtime` 的浏览器验证执行 system prompt(原 `browser-verification.executor.ts` 内嵌的 25.5KB 单字符串);Spec 分析阶段 prompt 不在此轮范围。

## 背景

浏览器验证 Agent 的 system prompt 是一段 25,560 字节的整块字符串,混杂了身份、工作状态语义、观察/滚动/定位恢复、证据提交、账号与数据处置、预算收尾等约束。整段拼接不可 review、diff 不可审,而且每次模型请求都全量携带——与 `docs/agent-context-budget-design.md` 的按预算分层裁剪思路冲突(最该裁剪的 system 部分反而永远全量)。

## 方案:模块化 + 条件注入(第一阶段)

把 prompt 拆成 `apps/agent-runtime/src/guidance/` 下的独立模块,每个模块回答一个具体运行问题:

```text
guidance/
  types.ts                GuidanceSection / BrowserGuidanceContext 类型
  index.ts                装配器:browserSystemPrompt、includedGuidanceSections
  core.ts                 身份与边界、验收范围、真实页面、收尾红线
  tool-surface.ts         分组工具面(条件:groupedTools)
  working-state.ts        工作状态/前置事实/清理台账/观察记忆/页面窗口
                          /分页游标/弹层聚焦/ref 有效性(条件:bounded)
  submission.ts           finish_verification 提交与 PASSED citations 规则
  observation.ts          导航等待、异步完成、快照、视口图片、DOM 覆盖边界
  interaction.ts          下拉/滚动/滚动错误/下拉搜索
  recovery.ts             失效引用、locatorRecoveryToken、progressRecovery
  network-evidence.ts     网络请求仅作参考
  accounts.ts             账号槽位、身份边界、accountRequest、TEST_ACCOUNT、
                          DATA_PRECONDITION 处置授权
  business-checks-v3.ts   条件:任务含 observationContract.version=3
  legacy-contract-v2.ts   条件:任务含 observationContract.version=2
  action-feedback.ts      actionFeedback 语义与保存失败诊断路径
  budget.ts               剩余工具次数/剩余时间的收尾规则
  terminal.ts             HITL 约束、简体中文输出、安全红线
```

每个模块携带元数据:

```ts
interface GuidanceSection {
  id: string; // 稳定标识,用于检索、注入开关与观测
  description: string; // 一句话说明本模块约束什么,供人阅读
  include?(ctx): boolean; // 缺省恒注入;条件模块按任务快照/模式决定
  content: string; // 注入正文
}
```

`BrowserGuidanceContext` 由执行器从任务快照与运行模式计算:

- `bounded`:`DEVPROOF_AGENT_CONTEXT_MODE !== "LEGACY"`;
- `groupedTools`:工具目录分组模式;
- `hasBusinessChecks`:存在 `observationContract.version === 3` 的验收标准;
- `hasObservationContractV2`:存在 `observationContract.version === 2` 的验收标准。

装配顺序与历史整段 prompt 逐行对应;模块间以换行拼接,模块末尾显式 `\n` 表示保留空行分段。

## 行为变化(有意为之)

- v3(businessCheck)与 v2(observationContract)两段契约说明改为**按任务实际标准注入**:不含对应契约标准的任务不再携带这两段(约 1.5KB/请求)。工具面(`observe_subject`)本就按相同条件暴露,说明与工具保持一致。
- 其余组合(bounded × groupedTools)与历史输出**字节一致**:迁移时用临时对比测试验证了 4 种模式组合,通过后移除旧函数。

## 观测

`agent.segment.started` 事件新增可选 `promptSections`(协议 `packages/agent-runtime-protocol`,向后兼容:旧 API 按 zod 默认剥离未知字段),记录本次注入的模块 id。人可以按 id 检索对应约束,不必通读整段 prompt。后续可按 `promptSections` 统计各模块的注入频率与 token 占比。

## 回归覆盖

`guidance/browser-guidance.spec.ts` 覆盖:模块 id 唯一且格式合法、描述/正文非空、正文无模板字面量风险字符、无行级杂散空白、装配顺序与目录一致、legacy/平铺工具/无 v3/无 v2 四种裁剪、核心红线在任何模式下保留、actionFeedback 前的空行分段。`browser-verification.executor.spec.ts` 141 项与协议包测试全部通过。

## 第二阶段:状态驱动的按需注入(待做)

第一阶段仅按静态任务属性裁剪。以下模块可进一步按**运行状态**注入,配合错误码触发,减少 happy path 携带量:

| 模块                          | 触发条件(执行器状态)                                                         |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `recovery-locator-token`      | `locatorRecoveryState !== null`(恢复 token 已下发)                           |
| `recovery-progress`           | `progressRecovery !== undefined`(纠偏已触发)                                 |
| `accounts-data-precondition`  | 本轮存在 DATA_PRECONDITION 请求/答复                                         |
| `action-feedback-diagnostics` | 最近保存后出现错误或启用 diagnostics                                         |
| `budget-*`                    | 仅在剩余工具次数/时间接近收尾阈值时注入(需评估:模型需要提前知道阈值才能规划) |

约束:注入条件必须由执行器状态机判定,不能让模型自报需求;`LEGACY` 模式保留全量兜底。触发类模块的替代方案是仿 `enable_browser_tools` 的按需拉取工具(`consult_guidance(topic)`),代价是错误路径多一次往返,放在第二阶段评估。

## 部署与回滚

纯 Agent Runtime 内部重构,无数据库迁移、无 Runtime 协议变更。协议包 `promptSections` 为可选字段,新 Agent + 旧 API 组合下该字段被剥离,不影响事件写入。回滚即还原 `browser-verification.executor.ts` 旧版与协议包 schema。
