# Observability and operations

DevProof combines structured process logs, Prometheus metrics, and durable audit events. The Console System Monitoring page is the primary team-scoped troubleshooting view.

## Correlation identifiers

Every API response includes `x-request-id` and a W3C `traceparent`. A valid inbound trace is continued, and each tool invocation receives a new span.

| Identifier         | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `requestId`        | One HTTP or MCP transport and its logs                           |
| `traceId`          | A Task/Run flow across API, workers, tools, and Runtime commands |
| `spanId`           | One server-side operation                                        |
| `toolInvocationId` | A recorded MCP or HTTP tool invocation                           |
| `runtimeCommandId` | One Browser Runtime command                                      |
| `credentialId`     | The machine credential that authorized a call                    |

Tool summaries and Run events contain bounded, redacted previews and SHA-256 fingerprints. They do not store full prompts, page bodies, cookies, bearer tokens, or credentials. Large evidence belongs in object storage and is referenced from an event.

## Health endpoints

| Service           | Liveness            | Readiness                        |
| ----------------- | ------------------- | -------------------------------- |
| API               | `GET /live`         | `GET /ready`                     |
| API compatibility | —                   | `GET /health`                    |
| Web               | —                   | `GET /health`                    |
| Agent Runtime     | Process supervision | Lease and heartbeat state in API |

API readiness checks PostgreSQL, Redis, object storage, and enabled background workers. A required dependency failure returns HTTP 503 and `NOT_READY`. A stale background worker returns HTTP 200 and `DEGRADED`, which exposes the problem without causing an unrelated restart loop.

## Prometheus and Grafana

`GET /metrics` returns Prometheus text format. Production must set an `OBSERVABILITY_METRICS_TOKEN` of at least 32 characters and scrape with `Authorization: Bearer <token>`. The endpoint returns 503 when the token is not configured.

Deployment examples are in:

- `ops/observability/prometheus-scrape.example.yml`
- `ops/observability/prometheus-alerts.yml`
- `ops/observability/grafana-dashboard.json`

Metrics cover HTTP traffic, MCP/HTTP tools, model operations, Task and Stage state, Runtime connectivity and protocol failures, worker health, notification backlog, artifact volume, post-run analysis jobs, and generated improvement work items. If `TOOL_INVOCATION_STALE_SECONDS` changes, update the `DevProofToolInvocationStuck` alert threshold too.

## Structured logs

API, Agent Runtime, and Browser Runtime emit one JSON object per line. Stable fields include `timestamp`, `level`, `service`, and `event`; contextual records may also include `requestId`, `traceId`, `spanId`, `runId`, `toolInvocationId`, `credentialId`, `runtimeId`, `commandId`, and `durationMs`.

Index by `service + event`, and keep correlation identifiers searchable. Do not turn the entire JSON record or high-cardinality IDs into metric labels.

Browser Runtime uses a bounded in-memory outbox for `runtime.event`, `command.result`, and `human.input.result` while disconnected. The outbox is limited to 500 messages or 10 MiB and replays in order. Preview frames and heartbeats are intentionally transient. Eviction produces a `runtime.message.dropped` log.

## Retention

- Task and Run events and evidence are purged according to their configured retention policy.
- Object deletion is first persisted in PostgreSQL, then retried with leases and exponential backoff.
- Closed Runtime Sessions and unreferenced Runtime Artifacts default to `RUNTIME_DATA_RETENTION_DAYS=30`.
- Unbound tool invocations default to `TOOL_INVOCATION_RETENTION_DAYS=90`.
- Control-plane audit events default to `AUDIT_RETENTION_DAYS=365`.
- Post-run bundles are immutable object-storage inputs. Terminal bundle bodies are deleted through the durable object-deletion queue and their full database Manifest is cleared after `RUNTIME_DATA_RETENTION_DAYS`, while hashes, completeness, redacted reports, findings, and improvement work items remain.
- Shared objects remain until the last durable reference is released.
- A sweeper changes tool invocations left in `STARTED` after a process interruption to `FAILED / PROCESS_INTERRUPTED`.

Normal application writes remain protected by append-only database triggers. Retention workers use a narrowly scoped database session flag for authorized deletion.

## Alert runbooks

### DevProofApiUnavailable

Check deployment state, the most recent release, and startup logs. If `/live` fails, restart or roll back the affected instance. If `/live` succeeds but scraping fails, check the metrics token, TLS, and Prometheus network path.

### DevProofDependencyDown

Read the failing dependency from `/ready`. Check database connection limits and migrations, Redis connectivity and authentication, or object-storage bucket access. Confirm the readiness metric returns to 1 after recovery.

### DevProofWorkerStale

Inspect `lastError`, `lastStartedAt`, and `lastSuccessAt` in `/ready` or Console. Resolve the dependency failure or stuck record that caused the worker to stop succeeding.

### DevProofToolFailureRatioHigh

Filter recent Tool Invocations by tool, transport, credential, error code, and trace. Use `traceId` to correlate logs and Run events, then distinguish caller validation errors from permission, Runner, or server failures.

### DevProofToolInvocationStuck

Inspect the oldest `STARTED` invocation and its Runtime command. If the work is legitimately long, adjust both the application stale threshold and alert. If its process exited, confirm the sweeper is healthy.

### DevProofAgentModelFailures

Inspect `agent.model.failed` events, duration, provider configuration, gateway status, limits, and credentials. Only redacted previews are available in events; use provider-side request IDs when deeper diagnosis is required.

For the `POST_RUN_ANALYSIS` pool, also inspect `devproof_post_run_analysis_jobs` and the job's `inputCompleteness`. `PENDING_CAPTURE` points to cleanup or capture lag, `READY` points to missing pool capacity or credentials, and `FAILED` exposes a bounded structured error and supports a manual retry from the Task detail page.

### DevProofHttpErrorRatioHigh

Break down HTTP metrics by route and status class, then use `requestId` to find the corresponding structured logs. Check whether failures are isolated to MCP, Console proxying, or Runtime Gateway endpoints.

### DevProofNotificationDeliveryDelayed

Inspect notification outbox status, attempts, and `lastError`. Check Feishu or webhook configuration, signature settings, and target reachability. Delivery is leased and idempotent, so avoid manual duplicate sends.

### DevProofRuntimeProtocolErrors

Compare API and Browser Runtime protocol support. Inspect negotiation failures, invalid or oversized frames, duplicate hello messages, and Runtime logs. Rebuild and restart Browser Runtime after upgrading it.

### DevProofRuntimeFramesRejected

Group rejections by reason. Unknown command, terminal command, lease mismatch, and size limit require different fixes. A lease mismatch normally means the result came from an expired connection or fencing token and must not be replayed by bypassing validation.

## Post-deployment checks

1. Confirm API `/live` and `/ready`, Web `/health`, and Console readiness succeed.
2. Scrape `/metrics` with the configured token and verify dependency, worker, HTTP, and tool series.
3. Create a Task through MCP and confirm its credential, Tool Invocation, Run events, model/tool trajectory, and Runtime commands correlate.
4. Trigger a controlled failure and verify that logs and alerts explain it without exposing tokens, cookies, prompts, or page content.
5. In a disposable environment, shorten retention and verify that object and event cleanup completes.
