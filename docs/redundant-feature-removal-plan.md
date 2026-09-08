# 冗余功能与代码移除计划

日期：2026-09-07。状态：代码改造及本地验证已完成；线上自动分析已关闭、第三池 Runtime 已删除，生产收缩迁移待完成备份和数据库访问核验。

目标：移除 Playground 和任务完成后的自动优化分析，让当前产品集中于任务创建、规格分析、浏览器执行、人工介入、证据和结果。随后清理已确认没有入口的旧实现。

## 1. 范围与最终状态

| 项目                             | 处理决定     | 完成标准                                                              |
| -------------------------------- | ------------ | --------------------------------------------------------------------- |
| Playground                       | 本轮完整移除 | 页面、创建 API、readiness、导航、专用契约和样式删除；登录落到任务列表 |
| 自动优化分析                     | 本轮完整移除 | 终态不再生成分析 Job、捕获分析输入、调用分析模型或创建改进事项        |
| `POST_RUN_ANALYSIS` Runtime      | 本轮退役     | 注册、签发、模型配置、Worker 分支、本地进程及实际部署均移除           |
| 无入口的 Run / Verification 列表 | 本轮已清理   | 删除列表分支，保留当前 Case 执行详情和历史记录读取                    |
| 独立 Specification 写入与派发    | 本轮已清理   | 删除无入口写逻辑及未注册 Worker，保留历史 GET 和 410 迁移提示         |
| 旧 Verification 执行和接管       | 本轮已清理   | 历史页面只读；删除未注册控制器、Worker 及无调用的执行方法             |
| Test Data / 独立 TestRun         | 后续决策项   | 先核对外部调用和历史数据；当前不直接删除仍公开的 API                  |

保留 `SPEC_ANALYSIS`、`BROWSER_EXECUTION` 两个 Agent Runtime 池，以及实际承载浏览器的 Browser Runtime。`apps/agent-runtime`、其 Dockerfile 和 `railway.agent-runtime.json` 是共用部署资产，继续服务这两个池。

任务创建继续使用现有 HTTP/MCP 和集成入口。保留 `ISSUE_SPEC`、`DIRECT_RUN`、Task/Run 状态机、Profile、重试、人工介入、完成通知、人工导出日志和现有可观测性。本轮不再新增一个替代 Playground 的界面。

## 2. 已确认的依赖与拆分要求

| 依赖                          | 代码依据                                                                                                     | 实施要求                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 登录成功跳转到 Playground     | `apps/api/src/auth/auth.controller.ts`                                                                       | 改为 `/console/runs`，同步认证测试                                                                               |
| Task 页面复用 Playground 样式 | `apps/web/app/console/runs/tasks-client.tsx`、`console.css`                                                  | 把共享表单和空状态样式改为通用命名，再删除专用样式                                                               |
| 人工导出日志依赖分析目录      | `task-executions/task-execution.service.ts` 的 `exportLogs` → `post-run-analysis/task-log-bundle.service.ts` | 把日志构建与脱敏迁到 `task-executions/task-log-bundle.service.ts`；保留 `GET /console/api/tasks/:id/logs/export` |
| 分析代次同时控制完成通知      | `task-execution.service.ts`、`verification/notification-outbox-worker.service.ts`                            | 将 `postRunAnalysisGeneration` 改为通用 `executionGeneration`，保留数值、重跑递增、通知去重和旧通知抑制语义      |
| 分析产物依赖对象删除队列      | `observability/retention-worker.service.ts`、`PostRunAnalysisJob`                                            | 删除表前交接全部分析专用对象键；继续保留通用对象删除队列及主执行证据的引用保护                                   |
| 模型列表和 Runtime 凭证共用表 | `AgentModelConfiguration`、`AgentRuntimeCredential`                                                          | 仅处理 `pool = POST_RUN_ANALYSIS` 的记录，不删除另外两个池的模型或凭证                                           |
| 当前接管 UI 仍在旧目录        | `runs/runs-client.tsx` 导入 `verifications/verification-hitl-browser.tsx` 的 `RunHitlBrowser`                | 先迁出共享实现，不能整目录删除旧 Verification UI                                                                 |

日志拆分后，人工导出只构建需要返回的脱敏日志包，不再额外构建供自动分析使用的 synopsis、manifest、字节范围索引和 evidence archive。保留规格分析的 `analysisSources`，它属于任务输入来源。

## 3. 实施批次

### A. 抽离共享能力

- [x] 迁移日志构建服务及有效测试，保持日志导出路径、授权范围、证据关联、脱敏和 `devproof.task-logs.v2` 主体结构（内嵌 Task 的代次字段改名为 `executionGeneration`，升级文档已说明）。
- [x] 把任务代次改成 `executionGeneration`。更新所有读写、重跑和完成通知代码；新增协调迁移将物理列改为 `execution_generation` 并保留全部数值。最终实现使用一次停机协调升级，不部署临时旧列映射版本。
- [x] 保留通知 payload 的 `generation` 和已有幂等键语义，验证旧待发送通知不会在新一轮任务完成后误发。
- [x] 迁出 Task 页面仍使用的通用样式。

验收：在自动分析功能完全缺席时，手工日志导出、重跑、取消及完成通知仍正常；无需第三个 Runtime。

### B. 移除 Playground

- [x] 删除 `apps/web/app/console/playground/`、`apps/api/src/playground/` 及专用测试。
- [x] 清理 `app.module.ts` 中的 Controller / Provider；删除 Console 导航、平台指南入口和试验场专属文案。
- [x] 修改飞书登录回调目标为 `/console/runs`。
- [x] 删除 `packages/contracts/src/index.ts` 的 `playgroundRunInputSchema`、`specificationPlaygroundInputSchema`、对应类型和专用测试；保留其引用的通用 Task / Profile / Deployment 契约。
- [x] 清理 `console.css` 中不再有消费者的专属规则；同步中英文 README 和两份架构 SVG。
- [x] 旧 `/console/playground` 和 `/console/api/playground/*` 路由删除后返回 404，不保留空壳表单或新的任务创建路径。

验收：登录后进入任务列表；导航和指南没有死链接；现有 HTTP/MCP 可以创建 Issue Task 和 Direct Task；历史来源为 `PLAYGROUND` 的任务仍能查看和重跑。历史来源标签允许保留，不重写历史输入快照。

### C. 移除自动分析业务与 Runtime 分支

- [x] 删除 `apps/api/src/post-run-analysis/` 中专用 Service、Worker、Controller、调度和进度计算，以及相关测试；共享日志代码已由 A 迁出。
- [x] 删除 `apps/api/src/agent-runtime/post-run-analysis-runtime.controller.ts`、`post-run-analysis-runtime.service.ts` 及相关测试。
- [x] 从 `TaskExecutionService` 的终态、失败、超时、取消和重跑路径移除 `enqueuePostRunAnalysis`、`supersedePostRunAnalyses`；保留 Task 终态投影、资源释放与通知事务。
- [x] 删除 Task API 的 `capabilities.postRunAnalysis`，清理前端分析 Tab、`PostRunAnalysisPanel`、轮询、重试、事件分页、分析专用类型及 `post-run-analysis-view*`。
- [x] 删除 `apps/agent-runtime/src/post-run-analysis.executor.ts` 及专用测试，移除 `worker.ts` 和 `control-plane.client.ts` 的 claim / heartbeat / tools / events / outcome / failure 分支。
- [x] 清理 `packages/agent-runtime-protocol` 的分析 lease、checkpoint、manifest、report、tool、outcome 契约；确认共用类型的剩余消费者后再删除。
- [x] Runtime pool / capability 仅发布规格分析和浏览器执行；清理 `analysisConcurrency` 和三池假设，校验注册返回结构与保留池的旧客户端兼容性。协调升级 API 与 Agent Runtime，退休凭证必须明确拒绝，不能落到默认池。
- [x] 从接入配置、模型池校验、签发 CLI、`AgentRuntimeControlService` 删除第三池入口。`agentModelPoolSchema` 引用 Runtime pool schema，需一起收敛。
- [x] 删除 `.env.example`、API / Agent Runtime 配置中的 `POST_RUN_ANALYSIS_*`、`DEVPROOF_POST_RUN_ANALYSIS_*`，以及 `scripts/dev.mjs` 的第三进程、缺失配置提示和相关兼容分支。
- [x] 删除分析专用指标、指标数据库查询和运维说明；保留运行状态、Worker 心跳、证据清理等通用监控。同步仓库内实际存在的告警 / Dashboard 引用。

验收：任务终态不会访问分析表、生成分析对象或启动第三个模型循环；前端没有分析请求；默认开发启动只考虑两个 Agent Runtime 池。移除后的分析 API 返回 404，旧池注册/签发请求被拒绝。

### D. 退役部署并完成数据收缩

运行代码删除与数据收缩分开提交。已有数据库保留完整历史迁移，通过新增迁移升级；不改写已应用的 migration 文件。

部署顺序：

1. 清点实际部署的 Runtime 服务、其绑定池、有效凭证、活跃分析 Job、模型配置及对象存储引用。以绑定池识别目标，不仅依赖服务名称；实施时已通过生产服务凭证注册确认目标池，详见末尾记录。
2. 旧版本仍可运行时关闭分析入队，停下分析 Runtime，撤销该池凭证并确认旧 API / Worker 不再写入分析数据。未完成 Job 按退役处理，不再为其恢复模型调用。
3. 备份需要保留的分析报告与记录；汇总 `inputStorageKey`、`captureStorageKey`、`captureEvidenceStorageKey` 和 `inputManifest._structuredEvidenceStorageKey`，去重后交给持久化的对象清理清单/队列。范围只包含分析专用对象。
4. 部署仅有两个池的 API、Web、Agent Runtime。过渡期代码停止读取分析表，模型列表过滤到两个有效池，拒绝第三池旧凭证。
5. 在旧进程退出、对象键交接完毕、备份校验通过后，执行新增收缩迁移：删除 `PostRunAnalysisJob`、`PostRunAnalysisEvent`、`AnalysisFinding`、`ImprovementWorkItem` 四个模型对应表、关系和专属枚举；仅删除第三池模型配置，保留其他池设置。
6. `executionGeneration` 的物理列改名与收缩采用同一次协调迁移，并同步 Prisma 映射，完整保留原值。不能直接删除它或重置为 1。迁移期间停止仍引用旧列名的进程。
7. 数据库 `AgentRuntimePool.POST_RUN_ANALYSIS` 可仅作为已撤销凭证的历史标识保留；公开协议、签发、注册和调度均不再接受它。若后续移除数据库枚举值，先迁出对应历史凭证，再执行专用迁移，不把旧凭证改绑到保留池。
8. 删除实际部署的第三池服务和它的环境变量，保留共用镜像/部署文件；验证另外两池在线。完成对象清理后移除过渡代码，最终 Retention Worker 不再查询分析表。

验收：空库能从完整迁移链安装；已有且包含分析历史的数据库能升级；收缩后没有针对已删表的查询、遗留分析服务或无记录可追踪的分析对象。Task、Run、通知、登录身份和原始执行证据保持有效。

回退边界：数据收缩前可在重新隔离退休池的前提下回退应用；物理删表后回退旧应用必须先恢复对应 schema 和备份，不能只回滚镜像。

### E. 清理此前确认的旧实现

- [x] 删除 `RunListClient` / `VerificationListClient` 无入口分支，保留实际被路由使用的详情。
- [x] 删除独立 Spec Service 的无调用写入、生成、派发逻辑及 `SpecificationExecutionWorker`。`generateBusinessTestSpec` 仍用于 Task 确定性分析和规格比较，保留共享生成器及其有效测试。
- [x] 旧 Verification 页面改为历史只读，移除没有后端路由的预览、接管、解决检查点入口。
- [x] 清理未注册的旧 Verification 控制器 / Worker 和无调用写方法；保留历史 GET、当前 MCP Task 工具、BrowserAdmission、BrowserExecutionRunner 及其现行 Run 使用的依赖。
- [x] 对 Test Data 建立[仓库调用与数据清单](test-data-retirement-inventory.md)，生产调用及记录量仍待只读核查。若仍需要用例库，后续把发布用例接到统一 Task；若没有消费者，再安排 API 退役和数据迁移。本轮不把“仓库内无调用”视为“线上无数据”。

## 4. 验证与完成检查

计划实施时使用现有测试入口，不为每个删除文件新增机械式测试。重点维护或补齐以下行为回归：

| 场景                                 | 期望                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| 登录和页面导航                       | 登录落到任务列表；无 Playground 和分析入口；任务表单与空状态布局正常   |
| HTTP/MCP 创建两种任务                | Issue 分析、Profile 解析、Case 派发、Direct Run 均可完成               |
| Task 取消、超时、阶段重试、Case 重跑 | 生命周期和资源清理正常，不创建分析 Job                                 |
| 任务重跑与通知竞争                   | 新一轮的完成通知可以发送，旧一轮通知被抑制                             |
| 浏览器人工接管                       | 使用当前 Run intervention，心跳、释放、继续执行正常                    |
| 人工日志导出                         | 授权、脱敏、事件、证据和任务关联正常，不调用分析模型或构建分析专用附件 |
| Runtime 与模型配置                   | 两个保留池能签发、注册和领取任务；退休池不能新建、领取或隐式改绑       |
| 历史数据                             | 原 Playground 任务可读取/重跑；只读旧 Spec / Verification 仍可查看     |
| 数据迁移和对象清理                   | 空库安装、已有库升级、带非空分析历史及待删对象的迁移均通过             |

最终执行 `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm format:check`；涉及浏览器资源共享路径时运行现有 `pnpm --filter @devproof/api test:concurrency`。用隔离数据库验证新增迁移，不使用生产库运行测试。

用 `rg` 复查 `Playground|playground|POST_RUN_ANALYSIS|PostRunAnalysis|postRunAnalysis|post-run-analysis|AnalysisFinding|ImprovementWorkItem|analysisConcurrency`：活跃业务代码、启动脚本和当前配置不再保留功能入口。允许历史 migration、退役说明、本计划、历史来源展示与明确标注的撤销凭证标识保留名称。不要按泛化的 `analysis` 关键字删除规格分析代码。

最终文档同步范围：两份 README、`docs/README.md`、`docs/architecture.md`、两份架构 SVG、`docs/observability.md`、`docs/upgrading.md`、Agent Runtime 协议 README。`docs/post-run-analysis.md` 的现役使用说明撤下，迁移注意事项合并到升级文档。

## 5. 建议提交顺序

1. `refactor: extract task logs and execution generation` — 共享能力拆分。
2. `remove: playground entry points` — Playground 全链路移除。
3. `remove: post-run analysis and runtime pool` — API、协议、Agent、UI、配置、指标与文档收敛；过渡期不访问分析表。
4. `migration: retire post-run analysis storage` — 配套退役清单、对象键交接、新增数据迁移及迁移验证。
5. `cleanup: remove unreachable legacy execution code` — 无入口旧列表、Spec 写入及 Verification 执行代码清理。

每个提交保持构建和类型检查通过；部署按 D 的停写、备份、协调升级、数据收缩顺序执行。所有实施项完成后再将本文状态改为“已实施”，并补充实际测试与部署结果。

## 6. 实施与验证记录

- 追加移除 Console 平台指南：删除管理员导航“帮助”分组和指南内容、专用样式；`/` 与 `/console` 直接跳转任务列表，保留实际任务流程中的操作提示。追加改动的前端 25 项测试、构建内类型检查和生产构建均通过；清理 101 条指南专用 CSS 规则。
- 已移除 Playground 和自动分析的 API、Web、Worker、Executor、协议、启动配置、指标、专用样式与现役文档。登录回到任务列表；共享日志服务与当前 Run 人工介入已迁出旧目录。
- 已移除无入口列表分支、独立 Spec 写入/Worker 和旧 Verification 执行/接管实现。历史读取、当前 Browser Runner、Test Data API 保留。
- 新增 `20260907193000_retire_post_run_analysis`；历史 migration 未改写。已在隔离 PostgreSQL 验证空库完整迁移链和非空历史升级，覆盖活跃租约回滚、通知代次、两池凭证/模型保留、对象键去重及原队列租约保留。
- `pnpm test` 全套通过；随后新增的日志导出/退休凭证回归及历史读取测试也通过。`pnpm typecheck`、`pnpm build`、`pnpm format:check` 通过。Next 构建和浏览器/网络测试使用允许本机进程与端口的运行环境。
- 现有 PostgreSQL 并发套件 7 个文件、86 项通过。本机临时 PostgreSQL 初始时区为 Asia/Shanghai；对齐项目要求的 UTC 后全部通过，未修改业务租约逻辑。
- 生产项目 `devproof` / `production` 中，待退役服务为 `57665317-bcf1-4d25-ba1b-8a3140de3e5e`；用它的现有凭证断言注册，返回唯一池 `POST_RUN_ANALYSIS`。生产 API 原开关为 true，已设置 false；部署 `88b1d92e-2a99-4bae-af14-c691a6c02226` 已成功。第三池服务已按上述 ID 删除，重新读取项目清单确认已不存在；保留的 Spec/Browser Runtime 均为 SUCCESS，API `/ready` 返回 200，配置读回为 false。
- 生产数据库仅私网可达；Railway SSH 返回未注册 SSH key。因此尚未执行生产备份校验、凭证/模型数据收缩、四表删除或新代码部署。代码迁移可审阅，但不能把本地验证记为生产迁移完成。

生产剩余完成条件：可验证的数据库备份、停旧 API/Worker、部署本次代码与收缩迁移、核对两池任务和清理队列。
