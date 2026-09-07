# Test Data 后续退役清单

2026-09-07 仓库核查。本轮保留这些 API 和数据；外部调用及生产记录量尚未核实。

| 项目                       | 当前证据                                                                                                                           | 后续决策所需信息                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 项目、环境、用例与发布版本 | `TestDataController` 注册在 `AppModule`，使用 Console 登录鉴权；提供 `test-projects`、`test-environments`、`test-cases` 及版本操作 | 最近调用、数据量、用例维护者、是否需要保留用例库 |
| 独立 TestRun               | `POST /console/api/test-runs` 调用 `TestDataService.createRun`，保存发布版本/环境快照和初始事件；没有接入统一 Task 派发            | 活跃/终态记录数量、调用方是否仍期待该流程执行    |
| 事件、附件与检查点         | 旧数据模型及关联仍在，检查点解决 API 仍公开                                                                                        | 历史读取、保留期限、对象存储引用与删除顺序       |
| 仓库内消费者               | `apps/api/scripts/test-data-smoke.mjs` 直接验证创建和幂等；当前 Web 未发现对应调用                                                 | 网关/访问日志中的外部调用不能由仓库搜索排除      |

相关表：`test_projects`、`test_environments`、`test_cases`、`test_case_versions`、`test_runs`、`test_run_trace_events`、`test_run_artifacts`、`test_run_human_checkpoints`。它们不属于本轮删除的自动分析表。

生产数据清点使用只读查询，按 team、状态统计数量及最近创建时间；检查 `test_run_artifacts.storage_key` 与 Runtime artifact 的引用，再核对网关中上述路径的近期调用。当前环境未提供可验证的生产数据库访问，本文不把未知数量写成零。

若仍需要用例库，保留版本化定义，单独设计把已发布用例转换为 `POST /v2/tasks` 的契约。若确认没有消费者，再安排入口退役、历史只读期、对象键交接和独立删表迁移；不在这次 Playground/自动分析删除中顺带删除。
