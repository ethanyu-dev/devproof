# Architecture

DevProof is a self-hosted control plane for AI-driven test execution. It accepts a testing goal, turns it into durable work, assigns that work to independently deployed runtimes, and stores the evidence required to explain the final verdict.

## System context

```text
Codex / Claude / custom clients / Console Playground
                         |
                         | HTTP or Streamable HTTP MCP
                         v
                  +---------------+
                  | DevProof API  |
                  | control plane |
                  +-------+-------+
                     |    |    |
             PostgreSQL Redis Object storage
                     |
                     | leased Runtime Task
                     v
               +---------------+
               | Agent Runtime |
               | model + tools |
               +-------+-------+
                       |
                       | versioned runner protocol
                       v
              +-----------------+
              | Browser Runtime |
              | Playwright host |
              +-----------------+
```

The Web Console uses the same API as other clients. Feishu, Linear, GitHub, and optional knowledge sources are integrations around the control plane rather than alternative state owners.

## Component responsibilities

### Task producer

A producer creates a Task through HTTP or MCP and reads its status and evidence. Producers describe the goal, acceptance criteria, target, and required capabilities; they do not manage browser leases or advance execution state directly.

### DevProof API

The API is the only business control plane. It owns:

- Task stages and immutable specification snapshots;
- deterministic Cases and Case-level Runs;
- attempts, leases, fencing tokens, retries, cancellation, and deadlines;
- human intervention, notification delivery, and cleanup;
- evidence metadata, audit events, and aggregate verdicts;
- Runtime registration, routing, capacity, and compatibility checks.

The API is a modular monolith backed by PostgreSQL, Redis, and S3-compatible object storage. PostgreSQL stores durable state, Redis coordinates online Runtime connections and cross-instance delivery, and object storage holds screenshots, DOM snapshots, network evidence, and video.

### Agent Runtime

Agent Runtime is a stateless lease worker. It claims one Runtime Task, heartbeats the lease, invokes a model, calls a constrained execution interface, appends bounded events, and submits an idempotent outcome. It does not own retry policy or final Run state.

Each Agent Runtime deployment declares exactly one pool: `SPEC_ANALYSIS`, `BROWSER_EXECUTION`, or `POST_RUN_ANALYSIS`. Registration must match the pool bound to its credential, the worker creates lanes and loads an Executor only for that pool, and each pool receives candidates from its own independently ordered model list.

### Execution Runner

An Execution Runner provides a controlled environment in which actions run. Browser Runtime is the first implementation. It connects outbound to Runtime Gateway, runs Playwright locally, protects persistent browser data on the Runtime host, and returns artifacts through the versioned protocol.

The runner boundary is intentionally capability-based so HTTP, shell, container, database, or queue runners can be added without changing the Task lifecycle.

## Task and Run model

`TaskExecution` is the user-facing aggregate. An Issue Task has three durable stages:

1. `SPEC_ANALYSIS` is leased to Agent Runtime with the `ISSUE_ANALYSIS` capability. Its Spec Analysis Executor adaptively reads the issue, linked pull requests, diffs, code pinned to the PR head SHA, and optional knowledge through read-only control-plane tools, then writes a source-cited immutable `agent-spec-v2` Task Specification Snapshot. Model, analysis-summary, tool, validation, and terminal events share the Task trajectory.
2. `PROFILE_RESOLUTION` selects an ephemeral or authorized user Browser Profile without opening a browser session.
3. `SPEC_EXECUTION` dispatches deterministic Cases as `ExecutionRun` records.

A Direct Task skips the first two stages and creates one Run. Each Run owns its attempts, Agent Runtime Task, Browser Execution, interventions, evidence, and outcome. Parent Task status is a projection of its stages and child Runs.

Terminal Issue Tasks may also enqueue a post-run optimization analysis sidecar. It is deliberately not a fourth Task stage: capture or model failures never delay notification, alter the Task lifecycle, or replace the original execution verdict. After browser cleanup reaches a terminal state (or a bounded capture grace period expires), the control plane stores an immutable `devproof.task-logs.v2` bundle and leases analysis to the isolated `POST_RUN_ANALYSIS` Agent Runtime pool. Evidence-validated findings are persisted separately and deduplicated into an internal improvement work item. See [Post-run optimization analysis](post-run-analysis.md).

The public entry point is `POST /v2/tasks`. `POST /v2/runs` remains an upgrade-compatible wrapper that creates a Direct Task. Legacy specification and verification endpoints are read-only compatibility surfaces and must not receive new product traffic.

## State ownership

Runs use three independent state axes:

- `lifecycle`: whether work is queued, running, waiting, complete, cancelled, or timed out;
- `executionDisposition`: whether execution happened or was blocked by an agent, provider, browser, or Runtime failure;
- `verdict`: `PASSED`, `FAILED`, `INCONCLUSIVE`, or `null`.

A verdict is present only when the execution disposition is `EXECUTED`. Infrastructure failures therefore cannot be mistaken for product failures.

Only the API may transition Task or Run state, schedule a retry, or perform terminal cleanup. Workers operate through leased commands, and every result must match the current worker ID, lease token, and monotonic fencing token. Late results from expired workers are rejected.

## Browser execution invariants

- One Runtime slot is owned by at most one live Browser Session.
- A serial persistent Profile is used by at most one Task at a time across all API instances. Opt-in isolated execution shares an immutable authentication snapshot across independent browser contexts, bounded by the Profile limit and Runtime slots. The persistent login directory remains exclusive for preparation and refresh.
- A persistent Profile and its authentication snapshot generations remain affine to the Runtime that stores them. Capacity, identity permits, hierarchical business-data leases and Attempt association are acquired atomically; only reviewed readers share overlapping data scopes. A ready waiting writer prevents later conflicting readers from overtaking it, while upstream auth/dependency/offline waits do not reserve data priority.
- Session results must match the current session ID, lease token, and fencing token.
- Resuming a session rotates the lease token and increments the fencing token.
- Runtime restart reconciles persisted session descriptors and terminates orphaned browser processes before reporting verified closure. A revoked session cannot resume by heartbeat; safe execution recovery uses a bounded new Attempt.
- Session expiry revokes permission and quarantines occupied slots/identity permits until browser closure is verified. An uncertain write retains its business-data lock until its outcome is reconciled, even after the browser closes. Completed outcomes release verified-closed resources.
- Runtime-wide SSRF policy governs navigation, redirects, subresources, and WebSockets. Profile authorization does not replace network policy.

Domain routing evaluates the hostname in `execution.targetUrl`. Exact and `*.` wildcard rules may restrict a task to selected Runtimes. When no rule matches, the API selects from online, capability-compatible Runtimes.

## Human intervention

An Agent may request human help for login, CAPTCHA, MFA, or judgment while the Browser Session remains leased. The API creates a durable intervention, extends the relevant leases, and notifies the configured channel. A human takes over the original page and returns a structured response; the same attempt then resumes under a new fencing lease.

Live frames and control input use an ephemeral lease-protected channel. They are not stored in prompts, traces, PostgreSQL, or object storage.

## Evidence and observability

Append-only Run events capture state changes, model/tool segments, browser commands, retries, and interventions. Large evidence is stored as objects and referenced by hash and storage key. Events contain bounded, redacted previews rather than full prompts, page bodies, credentials, or browser state.

Request IDs and W3C trace IDs connect HTTP/MCP calls, workers, Runtime commands, notifications, and evidence. See [Observability](observability.md) for metrics, logs, retention, and runbooks.

## Security boundaries

- Feishu SSO accepts only the configured `tenant_key`.
- Every data access is scoped to the authenticated Team.
- Machine credentials use narrowly scoped permissions and are stored only as hashes.
- Pairing tokens are short-lived and single-use; long-lived Runtime credentials stay on the Runtime host.
- Browser Profile cookies, local storage, IndexedDB, history, and directory contents never enter the control-plane database or prompts.
- Console mutations validate origin, and MCP validates Host/Origin and bearer identity.
- Runtime network policy blocks private and special-use addresses unless an administrator explicitly allows an exact host.

## Upgrade compatibility

The repository retains the complete Prisma migration chain and read-only legacy records so existing installations can run `pnpm prisma:deploy` during an upgrade. Historical tables and enum values are compatibility details, not current architecture. They may be removed only by a later expand/backfill/contract migration after operators have verified that no active legacy work or required retained records remain.

See [Upgrading](upgrading.md) before deploying a new version.
