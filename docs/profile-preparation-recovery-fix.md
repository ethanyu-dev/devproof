# Profile 准备与启动拒绝恢复

## 修复的行为

原 READY Profile 在准备登录时，如果被旧 Session、节点容量或持久目录租约挡住，会先被写为 REAUTH_REQUIRED。现在准备申请中的状态认领、Session、slot 和 Profile lease 在同一个 Serializable 事务提交；准入被拒绝时原 Profile 和认证元数据保持不变。

事务沿用全局资源 → Profile → Runtime 锁顺序，在锁内重新检查所有者、团队、Profile 版本及节点绑定。浏览器 RPC 仍在事务外执行。请求只有在自己的分配事务提交后，才允许对对应版本执行失败收尾；open 超时、导航失败或接管失败不能恢复 READY。过期 READY、LOST 的重新认证和 UNINITIALIZED 的已有控制会话复用继续支持。

Runtime 原先在登记 launch journal 之前检查 Profile 占用。一个新请求如果在此处收到 PROFILE_IN_USE，既没有启动浏览器，也没有持久的终结记录，之后 close 会一直返回 CLOSURE_UNVERIFIED。现在先登记本次有效启动意图，再执行 Profile 占用检查；被拒绝的新请求经过已有关闭收尾，留下与 session epoch 匹配的持久终结记录。只释放本请求实际取得的 Profile / snapshot reservation，保留其他请求的占用。同 epoch 重放和重启后的迟到 open 继续由 tombstone 拒绝。

## 历史记录与上线边界

此修复不改变协议、数据库 schema 或关闭证明种类；需要分别部署 API 和新的 Browser Runtime 构建。

只有实际收到的新启动请求能够走上述启动意图登记流程。close 找不到旧会话身份或 journal 时，仍不能根据空进程列表、NULL openedAt、错误文本或任务终态补造关闭证明。已有会话、恢复审计和资源保护不会被迁移或删除；历史积压仍按 [会话恢复与排空流程](session-closure-recovery-implementation.md) 处理。

关闭证明只说明物理会话已经终结。UNKNOWN 业务写结果仍保持隔离保护，认证快照也不代表后台数据相互独立；不得为了启用并发自动把用例标成只读或解除通配符 WRITE 保护。

## 验证

- `apps/api/src/browser-profiles/profile-preparation.integration.ts` 在独立 PostgreSQL 中验证旧 LOST、无容量和唯一约束失败时的完整回滚，以及维护与业务执行分别先取得锁的竞争，并覆盖普通 Session 创建入口。数据库事务与查询是真实的；Browser RPC、节点在线状态及审计输出使用测试替身，barrier 只控制真实 advisory lock 的交错顺序。
- Profile 与 Runtime session 单测验证前置失败不改认证状态、分配后失败保持待重新认证、版本/所有者变更、控制会话复用和内部 claim 的用途限制。
- `apps/browser-runtime/src/closure-evidence.spec.ts` 验证真实 Chromium 的 Profile 占用拒绝、关闭及重启后的重放拒绝，另验证两个在途请求不会互相释放 reservation，以及 close 与 journal 登记的交错。
- 原始基线运行新增回归时，三个数据库失败场景均把 READY 错误改成 REAUTH_REQUIRED；真实 Chromium 的占用拒绝后关闭返回 CLOSURE_UNVERIFIED。修复测试不是仅校验实现细节。

运行命令：

```sh
pnpm --filter @devproof/api test
pnpm --filter @devproof/api test:concurrency
pnpm --filter @devproof/browser-runtime exec vitest run src --no-file-parallelism
pnpm --filter @devproof/api typecheck
pnpm --filter @devproof/browser-runtime typecheck
```

并发数据库脚本只创建绑定到本机回环地址的临时 PostgreSQL 容器，执行全部迁移并在结束后清理。所有验证都应使用测试环境，不需要重新启动线上业务任务。
