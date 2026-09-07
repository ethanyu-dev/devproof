# 排空后恢复原 Browser Runtime

已验证排空的节点可以通过一次性恢复票据，保留原 Runtime ID、路由和 Profile 目录后重新接入。旧关闭证明、会话历史和 UNKNOWN 业务写保护保留；恢复不等于认证成功，也不代表旧业务写入已经核实。

## 状态与权限

1. `FROZEN`：停止旧服务及其浏览器/代理进程范围，核对冻结集合，提交基础设施终止证据。
2. `ATTESTED`：当前团队的有效管理员在“会话恢复”中查看节点，提交存储保留证据和恢复说明，签发 10 分钟有效的恢复票据。票据绑定原节点、排空代次、恢复代次和签发人。普通配对票据仍不能恢复排空节点。
3. `RESUMING`：原安装消费票据后轮换 Runtime 凭据，节点保持禁用。API 只接受同宿主的新 daemon、协议 1.14、关闭证明及执行许可能力，且本地会话清单为空的首次握手。该清单仅用于一致性核验；历史关闭必须有独立的持久证明。
4. `NONE`：首次握手提交后允许新准入。关联 Profile 保持 `REAUTH_REQUIRED`，认证快照已失效，用户通过现有验证流程检查保留的登录身份。完成后可重新排空，产生新的排空代次。

签发、配对和握手都重新核对当前代次及关闭证据。签发与配对各递增连接代次；签发立即废弃旧 Runtime 凭据，配对再生成新凭据。丢失配对响应时，可以重新签发恢复票据，之前的票据和凭据立即失效。票据只在页面内存中展示，不写审计、URL 或本地存储。

恢复只在全部历史 Session 具有匹配的 session fence / lease digest 关闭证明、没有身份许可、物理 slot / Profile lease 已清理、没有有效恢复许可时允许。旧 `CLOSED` 行若没有证明，也必须纳入排空证明；不会凭历史状态推断关闭。业务数据 guard 不在此流程中删除。

## 支持范围

此入口支持原宿主同一次开机、同一个 PID namespace 中停止服务后恢复。`hostInstanceId` 包含宿主 boot ID 和 PID namespace；整机重启、容器重建或换主机会改变它，当前入口将拒绝该情形。此类迁移需要独立核验方案，不能修改数据库中的宿主身份来绕过检查。

必须保留原运行用户、`DEVPROOF_RUNTIME_HOME`、`DEVPROOF_INSTANCE_KEY`、`profiles/` 和 `closure/`。配对命令会重写 `runtime.json` 并清空本地会话列表，不删除 Profile 或 journal。先停止 daemon/supervisor，并核对浏览器及代理已终止，避免旧 daemon 覆盖新凭据文件。启动前核对 Profile 未超过 30 天保留期，也没有待执行 purge；过期登录材料不保证能保留。

## 操作入口

API 前缀为 `/console/api`，使用现有 Console 认证：

```text
GET  /runtimes/:id/drain-preview
POST /runtimes/:id/drain/:drainId/resume-token
```

签发请求：

```json
{
  "snapshotDigest": "当前已验证排空的摘要",
  "note": "已停止旧服务并核对原宿主和 Profile 目录，准备恢复原安装。",
  "evidenceRefs": ["operations://恢复检查记录"],
  "profileStoragePreserved": true
}
```

返回原 `runtimeId`、`drainId`、`instanceKey`、`pairingToken` 和 `expiresAt`。在原宿主使用原服务用户、原 Runtime HOME，并显式设置返回的原 `DEVPROOF_INSTANCE_KEY`，执行现有 `devproof-browser-runtime pair --api <API地址> --token-stdin`。通过标准输入提供票据，完成配对后再启动原服务。禁止在旧 daemon 运行时配对。

先核对节点 ID 不变、连接代次增加、新 daemon 已握手、旧会话未复活，再验证原 Profile。只有认证快照兼容性探测通过后才启用 `ISOLATED_AUTH` 与四路并发；任何未知写结果仍须按独立业务核实入口处理。

## 发布和验证

应用增量迁移 `20260907110000_runtime_drain_resume` 后，部署 API 和 Web。现有 `RUNTIME_SESSION_RECOVERY_ENABLED` 与后台 worker 开关继续生效。Runtime 协议没有变化；准备发布的 `0.2.19` 包含此前 PR #37 的启动拒绝关闭修复。

验证包括真实 PostgreSQL 的冻结、证明、票据并发消费、补发、权限变化、历史证明完整性及 Profile/UNKNOWN guard 保留；网关测试覆盖首次握手与旧凭据、错误宿主、旧 daemon、缺失能力、非空库存、补发竞态及迟到连接。

回滚保留新字段和历史证明。恢复尚未完成时让节点维持禁用，不把 `RESUMING` 人工改成 `NONE`。旧 API 不支持恢复票据，不能靠普通重新配对完成此流程。
