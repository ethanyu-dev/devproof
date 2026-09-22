# Task execution metrics

The task list shows elapsed time and known token totals. Open a Task's **消耗与耗时**
tab for model usage, exclusive activity percentages, request history, and a paginated
timeline. That detail also shows Spec analysis and browser runtime occupancy when
the summary is version 2. The task list does not. While mounted, the view refreshes
summaries and all loaded detail pages five seconds after each refresh completes.
Existing content stays visible during requests and on failures; expanded pages,
filters, and scroll position are retained.
The refresh button uses the same background flow. Refresh and pagination requests
are serialized to prevent stale responses from discarding newly loaded pages.

## Accounting

- Input includes cached input. Total is input + output; cache is shown as a subset.
- Model rows are grouped by configuration identity, reported response model (or the
  requested model when unavailable), and execution/review scope. Automatic retries
  and fallbacks have distinct request identities. No provider prices are assumed.
- Missing usage stays null. Known subtotals, reported-call coverage, and unknown
  requests remain visible. Decimal strings preserve aggregate token precision.
- The shared model client captures usage even when the response fails assistant
  message validation. Review requests are captured independently of review success.
- Task elapsed time ends at its terminal timestamp. Later AI review usage increases
  token totals and has a separate cumulative model-duration field.
- One Task owns its original execution history. A rerun that creates another Task
  accounts under that Task; existing in-place retry history stays with its owner.

## Timing coverage

Model and tool events, initial navigation and automatic observation durations, durable
Task/Run waiting-state transitions, and Case dispatch waits provide timing evidence.
Human-intervention records also supply historical request/resolution boundaries.
Phase timestamps are shown independently from activity percentages.

A sweep of half-open intervals counts simultaneous calls of the same category once.
Different simultaneous activities use the parallel bucket. Waiting is counted only
when no observed work is active. Unknown gaps remain explicit. Structural Stage and
Segment lifetimes are never counted as continuous work. Cumulative request durations
can exceed task elapsed time and are not percentages of that elapsed time.

Registration estimates clock offset with a round-trip midpoint; original request
timestamps remain in the usage fact, while timing spans use aligned timestamps.
Trace payloads carry the latest alignment estimate. Model/tool timing with more than
one second of reported clock uncertainty is classified as unknown. Timing is labeled
estimated/partial rather than exact. Unclosed worker spans do not acquire an invented
duration at Task completion. Uninstrumented platform/recovery work remains unknown;
dedicated platform/recovery spans and full hierarchical browser-command attribution
are further instrumentation work, not inferred overhead.

## Runtime occupancy

Version 2 task detail splits exclusive wall-clock into Spec analysis, browser
execution, unassigned time, and overlap. Those four parts sum to task elapsed
time. Overlap is shown only when its occupied time is non-zero. The task list
and `GET /console/api/tasks/metrics/batch` stay on elapsed time and token totals.

Percentages on the activity bar use task elapsed time. Percentages inside a
runtime, unassigned, or overlap block use that block's occupied time. They are
not added to the activity bar.

Historical analysis can be `PARTIAL`. When an attempt has no stored executor,
residency is inferred from existing model or tool calls, and the detail says
the executor was not recorded. That badge is not the task timing-quality label.
A skipped analysis stage, a missing analysis stage, or only deterministic
attempts is `NOT_APPLICABLE`, and that time stays unassigned. Browser execution
does not use `NOT_APPLICABLE`. `NOT_STARTED` means that runtime has not been
entered.

In-run recovery before the new waiting span is `UNKNOWN` inside the browser
union. It is not unassigned time and it is not queue time. After the trigger
records in-run `RECOVERING`, `LEASE_RECOVERY`, or `DATA_LOCK`, that wait is
queue time still inside the browser union.

Phase start and finish are not runtime occupancy. Acceptance review stays in
its own block and does not extend task elapsed time.

A version below 2, or a failed runtime attribution, omits the split. The detail
does not fill that gap with zeros. A version 1 snapshot remains valid after
rollback: restoring the previous projection leaves the version 1 summary in
place, and the detail keeps the activity bar without inventing runtime rows.

## Persistence and recovery

`task_model_call_usage` stores one fact per call. `task_execution_spans` stores timing
boundaries. `task_execution_metrics` stores a versioned, rebuildable summary, source
revision, and resumable historical cursors. All three cascade with Task deletion.
No model prompts, response bodies, headers, API keys, or gateway URLs are retained in
these tables. Source usage uses a numeric-field allowlist.

Existing model/tool events project within their event transaction. PostgreSQL triggers
record Task/Run/Case waiting transitions in the same transaction as their authoritative
state changes; review and phase changes invalidate summaries. They never schedule or
advance execution. The metrics worker rebuilds up to twenty dirty Tasks per poll.
Reads also refresh stale summaries when workers are disabled.

Before a new request, Runtime registers the call under its current owned lease. A
settlement may arrive within 24 hours using that registration and original lease
identity, including after the lease expires. It can update telemetry only. Conflicting
terminal settlements are rejected, and duplicate acknowledgements are idempotent.

Runtime writes settlements to a private local spool and retries upload independently
of model completion. Set `DEVPROOF_AGENT_TELEMETRY_DIR` to a persistent private volume;
the default is `~/.devproof/model-telemetry`, partitioned by a hash of the control-plane
connection identity. Rotating the Runtime credential changes the partition. Pending
records under a previous credential are not automatically replayed with new authority.
The spool holds at most 2,000 files per partition and replays up to twenty per flush.
Failures to persist or deliver, and expired entries, produce sanitized Runtime logs.
Permanent machine/volume loss can still leave usage incomplete.

History is backfilled in bounded batches of 100 analysis events and 100 Run events.
Repeated backfill is idempotent and cannot overwrite precise client telemetry. Viewing
the task list queues missing summaries, and details/worker polls advance the cursors.
Old review results cannot reveal original usage or exact request counts: their legacy
placeholder remains unknown, with a request-count lower-bound diagnostic. Verbose
source traces already removed before backfill cannot be reconstructed.

## API and rollout

Read endpoints require the existing team context and `run:read`, with equivalent
authenticated Console routes:

- `GET /v2/tasks/:id/metrics`: summary, model rows, coverage, timing buckets, and phases.
- `GET /v2/tasks/:id/metrics/model-calls?after=...`: up to fifty requests per page.
- `GET /v2/tasks/:id/metrics/timeline?after=...&runtime=SPEC_ANALYSIS|BROWSER`: up to
  one hundred matching spans per page. Changing `runtime` drops `after`. Reusing a
  cursor from the previous filter skips spans, and a cursor that is not a span of
  this Task is a 404.
- `GET /console/api/tasks/metrics/batch?ids=...`: up to fifty task-list summaries.

The Console scope selector filters execution/review model rows locally; the summary
API returns both scopes. Source filters and bounded time-window queries can be added
without changing the accounting model. Cursors are scoped to the owning Task.

Deploy migration `20260920150000_task_execution_metrics`, generate Prisma and build
packages, then deploy the API before Agent Runtime protocol 2.25 and the Web app.
Older workers continue to supply event-based usage with partial metadata. A new Runtime
against an older API tolerates a missing registration route and falls back to legacy
events. Registration/settlement errors do not turn a successful model response into
another model request. The current worker protocol number has changed; Browser Runtime
does not need a protocol upgrade for this feature.

Use `pnpm --filter @devproof/api exec node scripts/test-task-metrics.mjs` for database
verification. It creates a disposable database, applies all migrations, runs metrics
integration tests, then drops only that generated database. Ordinary unit tests never
connect to the configured application database.

The design rationale and possible further instrumentation are in
[Task execution metrics design](task-execution-metrics-design.md).
