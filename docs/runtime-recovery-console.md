# 浏览器节点配置与会话恢复交互

节点配置页只展示恢复摘要，不再把所有恢复记录插在安装、配对和策略配置之前。恢复列表位于 `/console/access/recoveries`，每页 10 条；详情位于 `/console/access/recoveries/:id`。列表筛选、分页和返回位置保存在 URL 中，旧 `/console/access#recovery-ID` 入口会跳转到详情。

节点行和会话详情都能进入 `/console/access/runtimes/:id/recovery`，所以即使待处理列表为空，也能处理已排空节点的重新接入。

## 查询接口

- `GET /console/api/runtime-recoveries` 增加 `view=pending|all`、`runtimeId`、`writeState`，继续支持 `state`、`limit`、`cursor`。未指定 view 时保留原来的全部记录语义。
- 返回值增加 `total`，列表项增加 `runtimeName` 和 `sourceRunGoal`。筛选、统计和名称查询均按当前团队限制。
- `GET /console/api/runtime-recoveries/summary` 返回 `pending`、`needsOperator`、`awaitingWrite`。待处理为 `resolvedAt=null` 且关闭状态不是 `OBSERVED`；关闭已确认但写入未知的记录仍在其中。

先升级 API，再升级 Web；无需迁移数据库或更新 Runtime 协议。

## 操作和刷新

关闭与业务结果使用不同状态标签。关闭未确认时展示关闭进度或管理员处理指引；只在关闭已确认且业务结果仍未知时展示核实表单。`CLOSURE_UNVERIFIED` 明确提示自动重试已暂停，并提供核验、条件变化后重试和节点排空入口。

列表、详情及节点恢复页面每 15 秒刷新可见页面，提交操作期间暂停轮询；手动刷新更新当前页面相关数据。旧请求被取消，迟到结果不会覆盖新的筛选。刷新失败保留上次数据并显示错误，不把失败显示成空记录。

业务核实草稿绑定开始编辑时的版本；状态变化或提交版本冲突后保留草稿，需重新核对状态后继续。排空与存储确认绑定当前预览范围，范围变化会要求重新勾选。一次性票据只存于页面内存，正常状态刷新保留票据，重新签发前先隐藏旧票据，过期或离开页面后清除。

关闭证明、管理员校验、版本校验、幂等和业务保护沿用现有后端实现。此变更不处理或删除历史异常数据。

## 验证

```sh
pnpm prisma:generate
pnpm build:packages
pnpm --filter @devproof/api test
pnpm --filter @devproof/web test
pnpm --filter @devproof/contracts test
pnpm --filter @devproof/api typecheck
pnpm --filter @devproof/web typecheck
pnpm --filter @devproof/web build
node scripts/test-runtime-recovery-ui.mjs
```

浏览器回归复用 Browser Runtime 已有的 Playwright 依赖，需要已安装其 Chromium。脚本启动临时本机 Web 服务，拦截全部业务接口并使用模拟数据，结束后关闭服务和浏览器。覆盖 0/2/61 条记录、分页、详情与旧链接、刷新失败、轮询与版本变化时草稿保留、版本冲突、冻结与排空核验、恢复票据刷新/重签失败/过期，以及移动端表格溢出。可设置 `RECOVERY_UI_SCREENSHOTS` 指定截图输出目录。
