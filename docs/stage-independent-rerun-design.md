# 阶段独立重跑:Spec 分析 / Case 执行 / 验收评述

日期:2026-09-22。状态:已实现并回归验证(批次 A–D)。部署顺序:先 API(含迁移)与 Web,再 Agent Runtime;分析 DIFF 重跑按 `dispatchMode` 参数灰度。

目标:任务三个阶段各自可以独立重跑——Spec 分析(成功态也可重跑,默认差异调度)、Case 执行(单选或批量多选)、验收评述(整体重新生成,不保留历史)。Console UI 与公开 HTTP/MCP API 两个接入面同时支持,减少后续测试的重复成本。

## 1. 现状盘点

| 能力              | 端点(console / 公开)                       | 现状限制                                                                                                                                                                |
| ----------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 整体重跑          | `POST /tasks/:id/rerun`                    | 创建新任务走完整流水线(`task-execution.service.ts: rerun`)                                                                                                              |
| 阶段重试          | `POST /tasks/:id/stages/:stage/retry`      | `retryStage`:**SPEC_ANALYSIS 仅 FAILED 可重试**,SUCCEEDED 拒绝("Create a new task to refresh");SPEC_EXECUTION 仅 stage FAILED 且只重试失败 Case;PROFILE_RESOLUTION 拒绝 |
| Case 原位重跑     | `POST /tasks/:id/cases/:caseId/rerun`      | `rerunCase`:单 Case,原任务新增 executionOrdinal,依赖 Case 须同轮,terminal Run 才可,WRITE_OUTCOME_UNKNOWN 先核对                                                         |
| Case 重跑为新任务 | `POST /tasks/:id/cases/:caseId/rerun-task` | `rerunCaseAsTask` → `insertCaseRerunTask`(已有 `options.suite` 多 Case 雏形,未暴露):跳过分析直接执行,scope=CASE                                                         |
| 验收评述          | 无手动端点                                 | 任务终态 `enqueueForTask` 自动入队;`TaskAcceptanceReview` 按 `(taskExecutionId, revision)` 唯一,attempts<2 自动重试;无重新生成入口                                      |

MCP 已暴露 `retry_task_stage` / `rerun_task` / `rerun_task_case`(`apps/api/src/verification/mcp.service.ts`)。

结论:Case 单跑能力已存在;真正缺口是 (a) 分析成功态独立重跑与差异调度,(b) Case 批量多选重跑,(c) 评述独立重跑。

## 2. 契约与持久化

### 2.1 Spec 分析重跑(差异调度)

端点扩展(两套 controller):`POST /tasks/:id/stages/SPEC_ANALYSIS/retry`。

- `packages/contracts` 的 `taskStageRetryInputSchema` 增加 `dispatchMode: z.enum(["DIFF", "FULL"]).default("DIFF")`。
- `retryStage("SPEC_ANALYSIS")` 放宽:stage SUCCEEDED 也可重试;仍拒绝 PROFILE_RESOLUTION、LEGACY_RUN、已取消任务;**v1 要求任务处于终态**(COMPLETED/CANCELLED/TIMED_OUT),执行中任务不允许重开分析,避免快照与在途执行混排。
- 重试沿用现有 attempt 机制(新建 `TaskStageAttempt`,stage 回 PENDING,任务回 `SPEC_ANALYSIS`,deadline 刷新复用 `refreshedTaskDeadline`)。`dispatchMode` 写入 attempt 的 inputSnapshot,`persistGeneratedSpec` 落库时读取。

**差异调度(在 `persistGeneratedSpec` 落库路径扩展)**:

1. 新 Spec 快照**全量**落库(不可变原则不变;报告 revision 自然变化;latest snapshot 语义完整)。
2. 取上一快照 Cases,按 `definitionHash` 与新 spec 逐 Case 匹配(同名不同 hash 视为变化;新增/删除 Case 自然属于变化)。
3. 执行行创建策略:
   - 变化/新增 Case:正常 `taskDeploymentMatrix` 执行行(`dispatchStatus=PENDING`)。
   - 未变化 Case:每个启用部署创建执行行,标记 `dispatchStatus=CARRIED_OVER` + `carriedFromExecutionId` 指向上一轮同部署的终端执行行。
   - 上一轮不存在的新部署:即使 Case 未变化也照常派发。
   - 无上一快照(首次分析)或 `dispatchMode=FULL`:全量 PENDING,现有行为。
4. 事件:`task.spec.diff_dispatched` 记录 `{ carriedCount, dispatchedCount, dispatchMode, snapshotId }`。

**Schema 迁移(expand 型,不破坏历史)**:

```prisma
enum TaskCaseDispatchStatus {
  PENDING
  DISPATCHING
  LINKED
  CARRIED_OVER   // 新增
  FAILED
  CANCELLED
}

model TaskCaseExecution {
  // 新增自关联:沿用上一轮同部署的执行结果
  carriedFromExecutionId String? @map("carried_from_execution_id") @db.Uuid
  carriedFrom           TaskCaseExecution? @relation("CaseExecutionCarry", fields: [carriedFromExecutionId], references: [id], onDelete: SetNull)
  carriedTo             TaskCaseExecution[] @relation("CaseExecutionCarry")
}
```

**投影与报告**:

- 完成投影(`projectTaskExecution`):`allPlannedCasesLinked` 把 `CARRIED_OVER` 视为已链接且终态;carried 执行行不产生 run,不进 `terminalRuns`,不影响 `completedWithinDeadline` 的 run 判定。
- `buildTaskAcceptanceReport`:carried 执行行的 Case 级 verdict/生命周期/证据解析自 `carriedFromExecution` 的最新 run;criteria 结果与 evidence refs 沿用上一轮,标注「沿用上次结果(规格未变化)」。评估分沿用该 Case 上次数据(计入分母)。
- 派发 worker 的 pending 查询不包含新枚举值,天然跳过;`dispatchPendingForTask` 无需改。

**与现有重跑交互**:

- `rerunCase` / `caseRerunBlockReason` 允许对 carried 执行行原位重跑:视为「终态 + 存在历史 run」,重跑创建 executionOrdinal+1 正常派发行;carried 行保留为历史。
- `retryStage("SPEC_EXECUTION")` 的失败 Case 集合排除 carried 行(它们不是失败)。
- carried 前提校验:上一执行行必须终端且无 `WRITE_OUTCOME_UNKNOWN`(沿用 `caseRerunBlockReason` 的同款检查);否则该 Case 按 PENDING 派发。

**PROFILE_RESOLUTION**:v1 沿用现有流转(分析完成后该阶段重新 PENDING 并解析身份);「复用既有 profile 绑定、跳过重解析」作为后续优化,不在本期。

### 2.2 Case 多选重跑

新端点(两套 controller + MCP):

- `POST /tasks/:id/cases/rerun` body `{ caseIds: string[], idempotencyKey, reuseTestAccounts? }`:原位批量重跑。复用 `rerunCase` 的事务逻辑重构为 `caseIds` 数组;校验所有选中 Case 的 `dependsOnCaseIds` 均包含在选中集合内(否则冲突报错并列出前置),terminal/写入确认检查对每个 Case 生效。
- `POST /tasks/:id/cases/rerun-task` body `{ caseIds: string[], idempotencyKey }`:新任务重跑,走 `insertCaseRerunTask(..., { suite: true })`(标题/来源/审计/scope=CASE 已实现)。
- 现有单 Case 端点保持不变(单选是 caseIds=[x] 的退化)。
- MCP:新增 `rerun_task_cases`(run:write)与 `rerun_task_cases_as_task`,schema 引用新契约。

UI(`task-detail-content.tsx` Case 列表):多选 checkbox + 操作条「重跑选中用例(本任务)」「重跑选中用例(新任务)」;选择带前置依赖的 Case 时前端提示需要连同前置勾选。

### 2.3 验收评述整体重跑

新端点(两套 controller + MCP):`POST /tasks/:id/acceptance-review/rerun` body `{ reason? }`。

- 条件:任务终端(COMPLETED/CANCELLED/TIMED_OUT);当前 revision 的 `TaskAcceptanceReview` 行存在(不存在则按 `enqueueForTask` 路径新建 QUEUED)。
- 重置(不保留历史,整体重跑):`attempts=0`、`status=QUEUED`、`result=null`、`error=null`、清 leaseToken/leaseOwner/leaseExpiresAt。
- 写事件 `task.acceptance_review.rerun_queued { revision, reason }`。
- 复用现有 `claim`/`complete`;`validateAcceptanceReview` 门禁不变(AI 不得改证据评分与上线建议)。
- 无数据库迁移。

UI:报告页评述区增加「重新生成 AI 评述」按钮(RUNNING 时禁用);生成中显示现有 RUNNING 文案。

## 3. 三块联动语义

| 触发                   | 下游联动                                                                            | 通知               |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| 分析重跑(DIFF)         | 新快照 → 变化 Case 派发、未变化 Case carried → 终态自动重新评述(现有 revision 机制) | 不触发对外完成通知 |
| 分析重跑(FULL)         | 新快照 → 全量派发 → 终态自动重新评述                                                | 不触发对外完成通知 |
| Case 重跑(原位/新任务) | 任务重新终态 → 评述自动重新生成(现有 `enqueueForTask`)                              | 沿用现有语义       |
| 评述重跑               | 无(只动 review 行)                                                                  | 无                 |

## 4. 实施批次

- **A. 契约与迁移**:contracts 扩展(`dispatchMode`、批量 caseIds、评述重跑输入);prisma 迁移(CARRIED_OVER + carriedFromExecutionId);事件 schema。
- **B. 分析重跑与差异调度**:`retryStage` 放宽与终态守卫;`persistGeneratedSpec` 差异落库;投影与报告 carried 解析;`rerunCase`/`caseRerunBlockReason` 兼容 carried;`retryStage(SPEC_EXECUTION)` 排除 carried。
- **C. Case 多选重跑**:服务层批量重构 + 两个 controller + UI 多选操作条 + MCP 工具。
- **D. 评述重跑**:服务方法 + 两个 controller + UI 按钮 + MCP 工具。
- **E. 回归与文档**:README/升级说明;`docs/versioning.md` 提及新枚举与迁移的兼容窗口。

## 5. 验证与回归清单

| 场景                                        | 期望                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| 分析 SUCCEEDED 后 DIFF 重跑(部分 Case 变化) | 新快照全量;变化 Case 正常派发,未变化 Case carried;任务可完成;报告标注沿用并计入分数 |
| 分析重跑且全部 Case 未变化                  | 全部 carried,任务快速终态,报告与上次一致(revision 变化)                             |
| 分析重跑 FULL                               | 全量重新执行,行为同整体重跑但保留原任务与历史                                       |
| 执行中任务分析重跑                          | 冲突拒绝                                                                            |
| carried 行原位重跑                          | 创建新一轮正常执行行,carried 保留为历史                                             |
| 多选重跑(含依赖不完整)                      | 冲突并列出前置;依赖完整时同轮重跑                                                   |
| 多选重跑为新任务                            | suite 任务跳过分析,scope=CASE,标题/来源正确                                         |
| 评述重跑                                    | QUEUED → 重新生成;分数/上线门禁不可被改;审计事件存在                                |
| 历史任务/LEGACY_RUN                         | 均被拒绝                                                                            |
| 空库迁移、旧库升级                          | 通过;CARRIED_OVER 仅新数据使用                                                      |

最终执行 `pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm build`;涉及并发路径时运行 `pnpm --filter @devproof/api test:concurrency`。

## 6. 回滚与兼容

- 迁移为 expand 型(新枚举值 + 可空自关联),旧代码读取新数据无影响;回滚应用版本即可,数据收缩留待后续迁移。
- carried 行在旧 API 下表现为「未派发执行行」:因此**先部署 API 再部署 Agent Runtime**,并先发布 UI 的多选与评述入口后再放开分析 DIFF 重跑(灰度按 dispatchMode 参数控制,默认仍可 FULL)。
