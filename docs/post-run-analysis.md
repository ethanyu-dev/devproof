# Post-run optimization analysis

Post-run optimization analysis automatically captures a terminal Issue Task's durable execution record, asks a separate Agent Runtime pool to identify evidence-backed problems, and creates one deduplicated internal improvement work item when actionable findings exist.

It is a sidecar to the Task lifecycle, not a fourth Task stage. The original Task verdict, notifications, and cleanup complete independently. Analysis failure cannot turn a passed Task into a failed Task or delay its terminal projection.

## Lifecycle

```text
terminal Issue Task
        |
        v
PENDING_CAPTURE -- browser cleanup complete or grace expires --> CAPTURING
        |                                                           |
        | compensating scan                         immutable upload + CAS
        v                                                           v
idempotent job recovery                                           READY
                                                                    |
                                                               leased claim
                                                                    v
                                                                 RUNNING
                                                                    |
                                             +----------------------+------------------+
                                             |                                         |
                                             v                                         v
                                         SUCCEEDED                                  FAILED
                                             |
                                             v
                            findings + deduplicated improvement work item
```

The terminal Task transaction inserts a job unique on `taskExecutionId + analyzerVersion + generation`. In-place Stage or Runtime reruns increment the Task generation and cancel active jobs from the prior generation, so a new terminal snapshot cannot reuse stale findings. A background compensating scan creates any recent current-generation job missed by an exceptional terminal path; its bounded lookback prevents enabling the feature or changing analyzer versions from unexpectedly processing the entire historical Task table. Capture waits for every Browser Execution to become terminal, but proceeds after `POST_RUN_ANALYSIS_CAPTURE_GRACE_SECONDS` so a cleanup failure cannot block the pipeline forever.

Capture uses an atomic `CAPTURING` claim so only one API replica builds a job's immutable inputs; abandoned claims are reclaimed after a bounded stale interval. Claim-scoped bundle and evidence object keys are persisted before the first upload. Upload failure, deadline expiry, supersession, or stale-claim recovery detaches those keys and places them on the durable object-deletion queue, so a process crash cannot make an uploaded object undiscoverable. Capture writes the full `devproof.task-logs.v2` JSON object plus an immutable structured-evidence archive whose private byte-range index is stored with the job. The bundle includes Task, Stage, Run, attempt, Agent task, browser command/event, intervention, criterion, evidence-metadata, tool-invocation, and durable Task/Run event records. A compact `devproof.execution-manifest.v2` index records Stage, Run, Attempt, Runtime session, failed command, status boundaries, the complete evidenceRef allowlist, and evidence-to-Run/Attempt/Runtime location links before the Agent reads the file. The Agent uses that index for targeted record reads instead of exhaustively scanning the bundle. Sequence watermarks and an explicit `completeness` object make partial sources visible; the system never silently labels missing external process logs as complete. The full object SHA-256 and byte count are stored on the job, while every structured-evidence range has its own SHA-256 integrity check.

## Agent contract

`POST_RUN_ANALYSIS` has its own Runtime credential and worker capacity. The leased Agent receives a bounded Execution Manifest plus an immutable file handle. A Manifest larger than 64 KB is reduced to stage/run counts and status boundaries in the initial request; the Agent must page the complete authoritative index through `read_analysis_manifest` before evidence access or report completion. It then starts from failed Stage/Run/Runtime boundaries and uses only `manifest.evidenceRefs` as the evidence allowlist to fetch the relevant structured record or textual artifact. Full bundle reads cannot expand that allowlist and remain a bounded fallback, not a completion prerequisite. After each read it carries forward a maximum 16,000-character analysis summary; prior raw chunks are removed from model history, so multi-megabyte files never accumulate into one provider request. Text evidence is redacted into a bounded, short-lived control-plane cache so subsequent pages reuse the safe body, and it may be read at targeted byte ranges after the first page reports its size. Structured evidence is fetched directly from its indexed byte range in the companion archive, so neither small nor oversized bundles are retained as unaccounted parsed JSON or repeatedly downloaded and parsed. Images and videos return metadata rather than invented text.

Every finding contains:

- category and severity;
- component, title, root cause, and impact;
- phase, failure class, and the applicable Run, Runtime, and Attempt identifiers;
- an executable recommendation and confidence score;
- one or more evidence references that must exist in the captured bundle.

The Runtime validates report references and Run/Attempt/Runtime combinations against the manifest before submission and asks the model to repair invalid locations in the same lease. The complete report is capped at 512 KiB of UTF-8 JSON so it stays below the API request-body boundary even when every individual finding field is valid. The API repeats the validation as a trust boundary and verifies that every reported Run, Attempt, and Runtime belongs to the Task and is linked to cited evidence. A control-plane rejection is converted into a retryable terminal outcome while the lease is still valid instead of leaving the job stuck in `RUNNING`. It removes duplicate fingerprints and only turns findings at or above `POST_RUN_ANALYSIS_MIN_CONFIDENCE` into work. A stable set fingerprint deduplicates internal improvement work items across repeated analyses; recurrence refreshes and reopens the existing item. Reports and Agent events store bounded summaries, never provider hidden chain-of-thought. Missing model configuration terminalizes the oldest ready job with an explicit configuration error and does not consume an analysis attempt.

Every evidence reference cited by a finding must also have been fetched through `read_analysis_evidence` during the active lease; appearing in the Manifest allowlist alone is not sufficient. After a successful evidence response, the control plane records the evidenceRef with the current fencing token and checks those server-authored records again in the report-completion transaction. Runtime events, provider errors, and model reports are recursively redacted again at the API persistence boundary before they can reach PostgreSQL or the Console.

## Console progress and diagnostics

The Task detail API derives a complete progress summary from the full analysis event stream instead of asking the browser to infer state from the most recent display page. Cumulative metrics cover every attempt, while the active phase and queue timing are scoped to the latest attempt. It exposes six lifecycle steps, queue and execution timing, deadline remaining, model calls and duration, normalized token usage, evidence reads, validation failures, and finding count. The Console presents this summary first and keeps raw event payloads behind a collapsed technical section.

Runtime model events include a control-plane-safe `callId`, turn, phase, deterministic action and purpose, duration, tool names, cited evidence references, and normalized usage metadata. These fields describe what the executor did without persisting prompts, raw model output, rolling analysis memory, or hidden chain-of-thought. Model start and terminal events are rendered as one turn; adjacent evidence reads are grouped.

Operators can filter technical events by `KEY`, `ERROR`, `MODEL`, `EVIDENCE`, or `ALL`. `GET /console/api/tasks/:id/post-run-analysis/events` accepts `category` and an optional exclusive `beforeSequence` cursor, returning older pages without losing the live forward cursor used by the main detail poll. Failures remain pinned above technical details with their actionable code and message.

## Recovery and isolation

Jobs use lease tokens, monotonic fencing tokens, two separate deadlines, bounded attempts, and idempotent completion IDs. `hardDeadlineAt` bounds the complete capture, queue, and retry lifecycle. `deadlineAt` is the current attempt deadline and is assigned only when a Runtime claims the job, so time spent in `READY` never consumes that attempt's model-execution window. Capturing a bundle resets the hard deadline so slow browser cleanup does not consume the analysis lifecycle window.

Expired leases can be reclaimed only while the configured attempt budget remains; exhausted jobs are terminalized by reconciliation. Retryable failures and timed-out attempts return to `READY` with exponential backoff while attempts and the hard deadline remain. Fresh jobs sort ahead of retries, then by ready time, preventing one repeatedly failing analysis from blocking the queue. Terminal failures can be retried from the Task detail page. Model responses and tool calls each consume a bounded execution budget, including text-only responses from providers that ignore required tool selection.

The API enforces team scope on every console and Runtime query. Bundle serialization recursively removes credentials, cookies, tokens, profile/session identifiers, and sensitive URL parameters. The analysis pool cannot call Browser Execution or Spec Analysis tools. Terminal bundle and structured-evidence archive objects are detached and removed through the durable object-deletion queue after `RUNTIME_DATA_RETENTION_DAYS`; the full execution Manifest and its private archive index are cleared in the same transaction, while hashes, completeness, redacted reports, findings, and improvement work items remain available for audit.

## Configuration and rollout

The feature is off by default. Deploy the database migration and all API/Web/Runtime code first, provision the third Runtime identity, then enable capture:

```bash
pnpm --filter @devproof/api runtime:provision -- \
  --team default \
  --pool POST_RUN_ANALYSIS
```

For local development, put the one-time token in `DEVPROOF_POST_RUN_ANALYSIS_RUNTIME_TOKEN`. For a standalone Runtime deployment, set `DEVPROOF_AGENT_RUNTIME_TOKEN` and preferably assert `DEVPROOF_AGENT_RUNTIME_POOL=POST_RUN_ANALYSIS`; without the assertion, the Runtime binds to the token's pool on first registration. Configure its independent model list under the Post-run Analysis pool in Console.

Relevant API configuration:

- `POST_RUN_ANALYSIS_ENABLED=false`
- `POST_RUN_ANALYSIS_ANALYZER_VERSION=post-run-analysis-v3`
- `POST_RUN_ANALYSIS_CAPTURE_GRACE_SECONDS=30`
- `POST_RUN_ANALYSIS_CONCURRENCY=3`
- `POST_RUN_ANALYSIS_DEADLINE_SECONDS=1800` (per claimed attempt)
- `POST_RUN_ANALYSIS_HARD_DEADLINE_SECONDS=7200` (capture, queue, and retries)
- `POST_RUN_ANALYSIS_MAX_ATTEMPTS=3`
- `POST_RUN_ANALYSIS_MIN_CONFIDENCE=0.7`
- `POST_RUN_ANALYSIS_RECOVERY_LOOKBACK_HOURS=24`
- `POST_RUN_ANALYSIS_RETRY_BACKOFF_SECONDS=30` (exponential, capped at one hour)
- `DEVPROOF_POST_RUN_ANALYSIS_TOOL_LIMIT=64`

After enabling it, create an Issue Task and verify that its terminal detail shows bundle capture, incrementally streamed analysis events, analysis status, evidence-backed findings, and the generated work item. Monitor `devproof_post_run_analysis_jobs{status=...}`, `devproof_post_run_analysis_oldest_ready_age_seconds`, `devproof_improvement_work_items{status=...}`, and the `post-run-analysis` background worker health. Sustained ready age above the normal attempt duration indicates that Runtime capacity should be increased.
