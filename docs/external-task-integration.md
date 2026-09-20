# 外部服务接入 DevProof

普通后端服务、CI/CD 推荐使用 HTTP；具备 MCP 客户端能力的 Agent 可使用 `/mcp`。两者共用 Task 服务、Token 权限和输入校验。HTTP 的机器可读契约在 `GET /v2/openapi.json`，由实际 Zod 输入校验器生成。

## 部署与兼容性

1. 执行 `pnpm prisma:deploy`，应用 `20260920120000_external_task_integration` 迁移；先迁移再启动新版 API。
2. 回调默认允许任意 HTTP(S) 地址，包括本地、内网和自定义端口，无需配置域名白名单。如需收紧，可设置 `TASK_WEBHOOK_ALLOWED_ORIGINS=https://ci.example.com,http://automation.internal:8090`；非空时按**精确 origin**（协议、域名、端口）限制，留空则不限制目的地。URL 仍不能包含用户名、密码或片段，发送时不跟随重定向。
3. 启用现有 `BACKGROUND_WORKERS_ENABLED`，回调 worker 随 API 启动并使用 `BACKGROUND_WORKER_POLL_MS` 轮询。
4. 重启 API，重新构建并部署 Web，MCP 客户端刷新工具列表。

迁移只增加字段、索引和表，不删除原数据。`GET /v2/tasks` 无查询参数时仍返回最多 100 条的旧数组；新客户端应始终传 `page=1`。`list_tasks` 不传 `query` 时也保留原行为。

## 凭证与权限

控制台 → 接入配置 → 访问 Token 中生成 Token。每个外部服务建议使用独立 Token。请求头：

```http
Authorization: Bearer <DEVPROOF_TOOL_TOKEN>
Content-Type: application/json
```

- `run:read`：查询任务、事件、报告、授权身份和回调投递记录。
- `run:write`：创建任务、补充输入、重试及管理自己的回调订阅。
- `run:cancel`：取消任务。
- 创建回调订阅同时要求 `run:read` 和 `run:write`。

Token 的团队限制任务访问；回调订阅进一步限制为创建该订阅的 Token。过期、撤销的 Token 不能调用 API，关联回调也会停止投递。浏览器执行节点和 Agent Runtime 使用自己的运行凭证。

## 创建、关联、查询

```http
POST /v2/tasks
```

```json
{
  "kind": "SPEC_TASK",
  "idempotencyKey": "ci-build-123-attempt-1",
  "externalReference": { "source": "ci", "externalId": "build-123" },
  "title": "预览环境冒烟测试",
  "goal": "检查首页加载、主要导航和控制台错误。",
  "deployments": [
    {
      "key": "preview",
      "name": "PR 预览",
      "targetUrl": "https://preview.example.com"
    }
  ],
  "profilePolicy": { "strategy": "EPHEMERAL" }
}
```

返回 `202` 和任务详情（包括 `id`）。这是异步受理，不代表执行通过。`SPEC_TASK` 的 `goal`、`issueRef`、`pullRequestUrls` 至少提供一个；支持最多 20 个环境、25 个 PR。`DIRECT_RUN` 跳过 Spec 分析，其 `run` 验收条件等完整参数见 OpenAPI。

`externalReference` 仅供业务关联，独立于 Issue/PR 来源。相同业务单可以关联多轮任务；它不是唯一键。创建重试须复用原 `idempotencyKey` 和相同参数；同键不同参数返回 `409`。

```http
GET /v2/tasks/{id}
GET /v2/tasks?page=1&pageSize=20&source=ci&externalId=build-123
GET /v2/tasks?page=1&status=ACTIVE&kind=SPEC_TASK&query=首页
GET /v2/tasks/{id}/events?after=123
GET /v2/tasks/{id}/acceptance-report
```

分页返回 `{items,page,pageSize,total,totalPages}`，`pageSize` 为 1–100。还支持 ISO 8601 的 `createdAfter`。列表、详情均返回 `externalReference`（没有时为 `null`）。事件返回数组，`sequence` 是十进制字符串，避免 64 位整数精度损失；用最后一个已处理 sequence 作为下次 `after`。查询和回调结合使用，回调收到后再查详情。事件游标适合常规轮询；高并发下需定期用详情核对最终状态，回调 worker 的去重扫描不依赖游标。

`lifecycle` 是调度状态：`QUEUED`、`RUNNING`、`WAITING_INPUT`、`WAITING_HUMAN`、`COMPLETED`、`CANCELLED`、`TIMED_OUT`。判断测试是否通过还要看 `verdict`；`COMPLETED` 不等于通过。

## 补充输入与重跑

| HTTP 操作                                                             | MCP 工具                              |
| --------------------------------------------------------------------- | ------------------------------------- |
| `POST /v2/tasks`                                                      | `create_task`，参数放在 `request` 中  |
| `GET /v2/tasks`                                                       | `list_tasks`，分页筛选放在 `query` 中 |
| `GET /v2/tasks/{id}`                                                  | `get_task`                            |
| `GET /v2/tasks/{id}/events`                                           | `list_task_events`                    |
| `GET /v2/tasks/{id}/acceptance-report`                                | `get_task_acceptance_report`          |
| `POST /v2/tasks/{id}/analysis-input`                                  | `provide_task_analysis_input`         |
| `POST /v2/tasks/{id}/deployment-target`                               | `set_task_deployment_target`          |
| `POST /v2/tasks/{id}/deployments`                                     | `set_task_deployments`                |
| `POST /v2/tasks/{id}/test-accounts`                                   | `provide_task_test_accounts`          |
| `POST /v2/tasks/{id}/stages/{stage}/retry`                            | `retry_task_stage`                    |
| `POST /v2/tasks/{id}/rerun`                                           | `rerun_task`                          |
| `POST /v2/tasks/{id}/cases/{caseId}/rerun`                            | `rerun_task_case`                     |
| `POST /v2/tasks/{id}/cases/{caseId}/deployments/{deploymentId}/rerun` | `rerun_task_case`，传 `deploymentId`  |
| `POST /v2/tasks/{id}/cancel`                                          | `cancel_task`                         |
| `GET /v2/tasks/authorized-profiles`                                   | `list_authorized_profiles`            |

`get_run`、`resolve_run_intervention`、`read_run_evidence` 继续保留。回调订阅管理通过 HTTP 完成，不在模型工具中暴露签名密钥。

补充分析信息必须带 `expectedAttemptId`，防止覆盖另一次分析。测试账号补充必须带 `submissionId`、`expectedRevision` 和 `assignments`，具体账号结构见 OpenAPI。单用例重跑应带 `idempotencyKey`；整个任务重跑沿用原有行为，每次成功调用产生一轮新任务，遇到不确定的网络错误时先查询，不能直接无限重试。

## 服务 Token 使用登录身份

身份所有者在控制台的 Token 卡片展开“授权使用我的浏览器身份”，勾选要授予该服务的身份。这个操作是显式授权，不会因为 Token 由某人创建就自动获得其登录状态。

对应的控制台接口（需所有者的登录会话，不接受机器 Token 替代）：

```http
POST   /console/api/tool-credentials/{tokenId}/profiles/{profileId}
DELETE /console/api/tool-credentials/{tokenId}/profiles/{profileId}
```

服务调用 `GET /v2/tasks/authorized-profiles` 获取身份的 ID、名称、状态和站点，然后在创建任务中设置：

```json
{
  "profilePolicy": {
    "strategy": "EXPLICIT_PROFILE",
    "profileId": "<已授权身份的 UUID>",
    "onUnavailable": "WAIT_FOR_PROFILE"
  }
}
```

任务仍记录为机器发起，不冒充身份所有者。身份本身的站点匹配、入口授权、登录有效性仍须满足。`REQUESTER` 不会从机器 Token 自动推断个人身份。撤销 Token 的身份授权阻止**新建任务**，不取消已经授权受理的任务；需要停止已有任务时调用取消接口。

## 结果回调

拿到任务 ID 后注册：

```http
POST /v2/tasks/{taskId}/webhooks
```

```json
{
  "url": "https://ci.example.com/devproof/events",
  "events": [
    "task.completed",
    "task.timed_out",
    "task.waiting_input",
    "task.stage.failed"
  ]
}
```

返回订阅 `id`、配置和 `signingSecret`。密钥加密存储，列表不返回密钥；用相同 Token 重试相同任务、URL、事件集合会得到同一个订阅及密钥。相同 URL 改变事件集合返回 `409`。已停用订阅不可重启，可更换回调 URL（例如改变路径）创建新订阅。

订阅会补发已存在的匹配事件，因此任务在注册回调前完成也不会漏掉。回调只发送事件标识和业务关联，不发送原始任务输入、测试账号或证据内容；收到后使用 Token 查询最新任务详情。

```json
{
  "id": "<事件 UUID>",
  "deliveryId": "<投递 UUID>",
  "type": "task.completed",
  "taskId": "<任务 UUID>",
  "sequence": "123",
  "occurredAt": "2026-09-20T00:00:00.000Z",
  "externalReference": { "source": "ci", "externalId": "build-123" }
}
```

签名请求头：

- `X-DevProof-Event-Id`：事件 ID。
- `X-DevProof-Timestamp`：本次发送的 Unix 秒数。
- `X-DevProof-Signature`：`sha256=<HMAC-SHA256 十六进制值>`。

签名消息为 `timestamp + "." + 原始 HTTP body`，密钥为 `signingSecret`。接收方应在解析 JSON 前保留原始 body，使用常量时间比较验证签名，校验时间戳（例如允许 5 分钟偏差），再按事件 ID 去重。HTTP 2xx 视为成功。

采用至少一次投递，重试时事件 ID 和投递 ID 保持不变、时间戳重新生成；不保证事件到达顺序。请求超时为 10 秒，不跟随重定向。普通失败指数退避，最多 8 次，间隔上限 1 小时；worker 异常退出后租约到期可重试。只在后端轮询开启时发送；如配置了非空 origin 白名单，发送时也会检查该名单。

```http
GET    /v2/tasks/{taskId}/webhooks
GET    /v2/tasks/{taskId}/webhooks/{id}/deliveries
POST   /v2/tasks/{taskId}/webhooks/{id}/deliveries/{deliveryId}/retry
DELETE /v2/tasks/{taskId}/webhooks/{id}
```

投递列表显示最近 100 条，包括 `PENDING`、`DELIVERED`、`FAILED`、`CANCELLED`、尝试次数和最后错误。手动重试仅接受当前 Token 的有效订阅下已经失败的投递，保留事件 ID 并重置尝试次数。停用、撤销和到期会阻止后续发送，但不能收回已经在网络中的请求。

## 错误与重试

| HTTP 状态        | 含义与处理                                                                     |
| ---------------- | ------------------------------------------------------------------------------ |
| `400`            | 参数校验失败；Zod 校验响应含 `error: VALIDATION_ERROR`、`issues`，修正后再请求 |
| `401`            | Token 缺失、过期或撤销                                                         |
| `403`            | 缺少 scope，或未取得个人身份授权                                               |
| `404`            | 当前团队中找不到资源，或订阅不属于当前 Token                                   |
| `409`            | 状态已变化、幂等键冲突或输入修订过期，先重新读取当前状态                       |
| `5xx` / 网络超时 | 创建任务可使用原幂等键重试；非幂等操作先查询状态                               |

MCP 使用协议错误或工具调用错误表达失败，不应将成功返回一段文本视为业务成功；读取结构化任务状态。

## 验证

单元测试：`pnpm --filter @devproof/api exec vitest run src/task-executions/task-external-api.spec.ts src/task-executions/task-webhook.service.spec.ts src/verification/mcp.service.spec.ts`。

真实数据库测试：在一次性数据库应用迁移后，设置 `DEVPROOF_EXTERNAL_API_TEST_DATABASE_URL` 并运行 `src/task-executions/task-external-api.db.spec.ts`；数据库名必须匹配 `devproof_external_api_test_<8位小写十六进制>`。测试覆盖授权/撤销、团队隔离、业务关联、重复创建、历史事件补发和多 worker 去重。
