**会话恢复修复：实施与上线说明**

2026-09-05。修复分支 `fix/session-closure-recovery`，事故分析基线 `d8901e6156fca742a0e89dc2b4607aa22e66d0a4`；提交 PR 前已同步 `main` 的 `d2b38ec22b35d9519e2de064217326cb786d2ebe`，并复核重叠修复。尚未部署、修改线上历史记录或重新运行原任务。

**已实现的行为**

- 每个失效阻塞会话持久记录恢复状态，与 Run 是否存在无关。健康会话仅记为 OBSERVED，不因后来的任务等待而被关闭。
- `SessionClosureService` 是唯一关闭证明写入入口。空库存、CLOSED 状态、过期租约、裸成功 ACK 都不是关闭证明。所有物理释放检查持久证明与 session epoch。
- 关闭证明与 legacy WRITE guard 在同一资源锁事务内保存，保证旧保护切换无空窗。已有 NORMAL 隔离租约由同一个 recovery 接管；未知目标保留通配符范围。
- 物理关闭和写结果分别记录。关闭只释放槽位/Profile 等物理资源；UNKNOWN 写结果继续阻止冲突业务。人工核实要求当前团队管理员、匹配证明、旧执行已停止、版本 CAS、幂等键及审计。
- Runtime 协议 1.14、Browser Runtime 0.2.18 显式协商 `closure-evidence-v1`。启动前 API 保存 launch identity，Runtime 在启动前持久登记该 identity；即使 open 回包丢失，后续仍能定位浏览器。
- Runtime 先撤销网络权限，再关闭并核验浏览器进程范围，持久保存 tombstone/证明/outbox。旧身份缺失、跨宿主、无法识别的进程保持待处理。录像在独立禁网 renderer 中有界合成，不阻碍关闭证明持久化。
- 每次认证连接有递增 generation。过时连接的事件、结果、Redis 转发/断连消息和 presence 删除不能影响新连接。
- Worker 使用数据库 claim、节点 permit、持久 close command 和 outbox；RPC 在事务外执行，重复派发复用命令，关闭后的迟到失败不会回退证明或重新隔离已核实的数据。
- 准入按 5/15/30/60 秒退避恢复阻塞，完成后定向唤醒；解决了恢复事件先于 blocker 注册导致的唤醒丢失。普通 DATA_LOCK 仍按 2 秒检查，Run 原截止时间保持不变。
- 撤销 Runtime、租约清理、Run 终态、启动失败、Agent 失联、人工接管等关闭调用方接入统一语义。只读启动失败仍保留原有一次有限重试；未知写入不能由空命令表推断为未写入。正常写任务的确认结果按相同 owner epoch 收敛，无论完成发生在关闭前还是关闭后。
- Task 用例保存稳定 dispatchOrder；依赖限定相同轮次与生成快照。UI 正确区分 QUEUED/PREPARING 与完成，并显示恢复根因及管理员处理入口。

**迁移与开关**

新增迁移 `apps/api/prisma/migrations/20260905150000_runtime_session_recovery/migration.sql`，包含恢复/证据/outbox/claim/drain 表、运行时身份和会话启动字段、资源租约来源及恢复绑定、准入恢复关联、dispatchOrder。迁移只回填固定快照中的待执行顺序，不伪造旧关闭证明。

`RUNTIME_SESSION_RECOVERY_ENABLED` 默认 **false**，是混合版本上线屏障，覆盖普通关闭、人工关闭、恢复、证明收尾、排空和业务核实等新操作。关闭屏障时这些操作返回明确冲突，不回退到无证明释放资源。后台周期还要求 `BACKGROUND_WORKERS_ENABLED=true`。

1. 先冻结新任务分配，在目标环境备份并应用增量迁移；读取历史 blocker、资源租约和原任务记录，核对实际 session/Runtime/owner 与目标范围。所有副本的 `BROWSER_EXECUTION_ENVIRONMENTS_JSON` 必须一致，不在本次上线同时改变业务环境映射。
2. 升级全部 API 和 Worker，停止旧副本并等待旧事务与回调结束。此阶段屏障保持 false，避免旧 helper 与新 guard 并存写入。
3. 升级 Browser Runtime 到 0.2.18，核对当前连接协商 protocol 1.14 与 `closure-evidence-v1`，以及宿主身份和日志持久目录。仅重连旧 Runtime 不会补齐历史进程身份。
4. 全部副本具备新语义后，在 API/Worker 一致启用屏障。检查恢复扫描、自动关闭、UNKNOWN guard 和 outbox 唤醒，再恢复新任务分配。
5. 对事故中的具体旧阻塞行逐条选路径；缺失历史进程身份的使用下述排空核验。原任务若已经终态，保留其结果，按正常流程显式发起新验证。

自动证明目前仅接受新协议。初始设计中的 1.13 兼容证明适配器未启用：尚无经过本轮验证、满足完整进程身份与持久审计条件的旧构建白名单。旧客户端可正常建立受限连接，但其裸关闭 ACK 不释放资源；应升级并主动核验，无法核验时排空。这是明确的上线要求。

**实际 API 与管理员操作**

所有路径前缀为 `/console/api`，使用现有 Console 会话认证。列表与详情按当前团队过滤；恢复写操作重新检查当前管理员角色。

| 操作         | 路由                                                       |
| ------------ | ---------------------------------------------------------- |
| 分页列表     | GET `/runtime-recoveries?state=&cursor=&limit=`            |
| 恢复详情     | GET `/runtime-recoveries/:id`                              |
| 请求恢复会话 | POST `/runtime-sessions/:id/recovery`                      |
| 重试         | POST `/runtime-recoveries/:id/retry`，提交 expectedVersion |
| 核实写结果   | POST `/runtime-recoveries/:id/resolve-write-outcome`       |
| 查看排空范围 | GET `/runtimes/:id/drain-preview`                          |
| 冻结排空集合 | POST `/runtimes/:id/drain`                                 |
| 提交排空证明 | POST `/runtimes/:id/drain/:drainId/attest`                 |

写结果请求包含 expectedVersion、UUID idempotencyKey、outcome（NO_WRITE / VERIFIED / COMPENSATED）、note 和至少一个 evidenceRefs。重复幂等键必须对应相同内容；过时版本返回冲突，刷新后重新核对。旧 session note-only 核实路由保留适配，但同样经过证明、管理员和终态检查。

排空先预览并提交 snapshotDigest，冻结具体 session epoch 集合及 Runtime generation；节点保持禁用。管理员停止旧 daemon/supervisor 和专用容器、cgroup 或宿主中的浏览器/代理范围，核验网络与进程已终止并留存证据。待节点 OFFLINE（已撤销节点可为 REVOKED），提交同一 digest、UUID idempotencyKey、note、evidenceRefs 及 infrastructureTerminated=true。代际或集合变化则拒绝证明，必须重新核对。成功排空仍保留 UNKNOWN 写保护，需单独核实业务结果；节点保持禁用，不因排空完成自动恢复服务；同一已冻结实例也不能通过重新配对绕过排空状态。

当前自动关闭连续失败 6 次进入 NEEDS_OPERATOR；纯离线等待按 120 秒重试或重连事件唤醒，并接入现有 Worker 健康监控。设计中的持续 10 分钟专项升级告警及完整恢复指标面板尚未实现；灰度期需通过恢复列表、详情和 Worker 日志核对积压、人工待处理项与唤醒情况。

历史清理也必须验证完整关闭/恢复记录，并确认没有资源租约。会话、命令和恢复审计元数据保留；只清理已过保留期且没有 TestRun、VerificationRun 或 RunEvidence 引用的产物。元数据长期归档需另行制定，不能通过级联删除解除保护。

**验证与回滚边界**

真实 PostgreSQL 测试使用可销毁本地 Docker 数据库，执行全部迁移和真实行锁、并发 claim、迟到证明、重复核实、资源释放故障注入与有限重试；没有使用线上数据库。Runtime 测试包含真实 Chromium、同宿主 daemon 重启、open ACK 丢失、进程退出和关闭后离线录像。

最终测试结果记录见本文件末尾。同步主分支后补充验证：产物上传期间重连/撤销不会发布过时结果，过期产物清理保留证明、恢复记录及仍受引用/隔离保护的内容，大体积录像裁剪仍保留完整关闭证明。初次沙箱执行 Chromium/回环网络受环境权限限制，获准后重新执行真实测试。并行构建和数据库测试期间，既有诊断缓存测试曾超过默认 5 秒；单独复核 3/3 通过（226ms），随后独立重跑完整回归。

回滚时停止新恢复动作并冻结新分配，保留严格证明校验、guard、恢复终态及增量 schema。不要回滚至会凭空库存/裸 ACK 释放资源的旧 API/Worker；存在新协议会话时先排空再处理 Runtime 版本。关闭开关会暂停关闭与核实，不能作为长期正常运行配置。

**最终验证结果（2026-09-05）**

| 验证                                                      | 结果                                           |
| --------------------------------------------------------- | ---------------------------------------------- |
| `pnpm test`                                               | 920 项通过，退出码 0                           |
| API 单测（包含在上项）                                    | 80 文件 / 602 项通过                           |
| Browser Runtime（包含在上项）                             | 21 文件 / 100 项通过，含真实 Chromium          |
| Agent Runtime / Web（包含在上项）                         | 96 / 25 项通过                                 |
| 四个共享包（包含在上项）                                  | 96 项通过                                      |
| 本地进程树清理（包含在上项）                              | 1 项通过                                       |
| `node apps/api/scripts/test-execution-concurrency.mjs`    | PostgreSQL 5 suites / 62 项通过；57 个迁移成功 |
| `node apps/api/scripts/test-runtime-presence.mjs`         | 真实 Redis 9 项通过；仅临时 Unix socket        |
| 全部 8 个 workspace 包类型检查                            | 通过                                           |
| 共享包、API、Agent Runtime、Browser Runtime、Web 生产构建 | 通过                                           |
| 改动文件格式与 `git diff --check`                         | 通过                                           |

测试日志保存在本地验证记录中，不随仓库发布；可通过上表命令重新验证。全部临时数据库、Redis 实例及测试目录已清理。上述测试均未连接生产环境。
