# Runtime step context history

## Purpose and UI

The Console's **Log diagnostics → Execution contexts** section lists every browser execution
attempt, including old runs created by manual retries. It supports goal or UUID
search, `executionId+attemptNumber` search, status filters and pagination. An
execution report links directly to its current attempt.

Attempt detail presents a chronological step timeline with a sticky step index.
Each collapsed card shows the Agent's planned action, model-call status, model,
timestamp and latency. Expanding a card loads that call's context on demand.
Seven cards present fixed instructions, execution state, saved observations,
recent operations, the current page, the current goal and tool definitions in a
responsive three-, two- or one-column grid. Each card shows a content preview and
size, and expands independently to the full row. Multiple cards can stay open.
Expanded cards default to the complete raw section content, with an optional
structured viewer. Only collapsed previews are shortened; expanded content and
downloads retain every field and original string. The complete request and model
output remain available below the grid, including images.

`stepIntent` is a short, user-visible action plan supplied at the top level of
each model tool call. It is required in the advertised tool schema, requested by
the system prompt, and removed before validating/executing business tools. Old
responses without the field remain executable and explicitly display a missing
plan. Rewording an intent does not reset stagnation detection. Intent is neither
an accepted observation nor an acceptance verdict, and is not internal reasoning.

The new `currentGoal` input records the existing execution phase, step and
unresolved criteria. It does not infer that an unverified subgoal was completed.
This feature instruments the current decision process; it does not fix scope
binding, target coverage or automatically schedule subgoals.

## Identity and ordering

- Public attempt identity: `executionRun.id + runAttempt.number`.
- Manual case retries create another run and increment `executionOrdinal`;
  both runs remain searchable. Related attempts link to the same case/deployment.
- Automatic retries increment the attempt number within the same run.
- Model fallbacks share a logical `(attemptId, segmentId, step)` and appear as
  separate requests inside one card. Their exact inputs and failures are retained.
- Human handoff/lease resume changes the segment. The timeline numbers logical
  steps continuously across segments while preserving the original local step.

## Capture and storage

Agent protocol 2.22 adds optional `contextSnapshot` to `agent.model.started`
and optional `decisionOutput` to `agent.model.completed`. Before each actual
model invocation the worker archives `{ request, metrics }`, using the prepared
messages, current tool surface, model and request settings. It includes the
actual selected DOM window and inline images. Known credential fields and credential-bearing URLs/text are replaced with
`[REDACTED]` and explicit `redactedPaths`; content is otherwise not truncated.
The checksum describes the retained, redacted JSON. It does not contain provider HTTP
authorization headers or transport credentials. If model input was intentionally
paged or summarized, the archive preserves what the model received, not content
the model never received; metrics expose that distinction.

The archive uses gzip/base64, the UTF-8 byte length and SHA-256 of its complete
JSON. The API validates/decompresses it under a 32 MiB uncompressed limit and
stores compressed bytes in `run_step_contexts`. The started event and archive
are committed in the same leased transaction, before the worker invokes the
model. Oversized/invalid archives fail explicitly instead of silently truncating.
The event ingestion route alone accepts larger bodies (26 MiB); other routes
retain their existing limit. Trajectory events contain only an archive manifest,
so normal report payloads do not acquire base64 archives.

Model output retains credential-redacted public content and tool calls, including `stepIntent`, in
the completed event. Provider reasoning fields are not copied. Tool execution
results in the detail panel remain clearly labeled historical log previews;
the next model input records the complete tool summaries actually delivered.

Archives are immutable by model-call UUID and scoped to team, run and attempt.
Read and download routes require the normal authenticated Console team context.
Browser-session cleanup and new attempts do not remove archives. Explicit
deletion of a run/attempt cascades to its contexts; there is no separate TTL.
Downloads are private/no-store and attachment-only. Treat these archives like
existing private execution evidence, never public repository artifacts.

## Historical compatibility and rollout

Deploy the additive migration and API before restarting Agent workers. No
Browser Runtime change is required. Old workers continue to emit preview events.
Historical requests cannot be reconstructed from those previews: the UI marks
them `LEGACY_PREVIEW`, leaves missing sections absent and offers the actual
retained preview. It never labels reconstructed task metadata as original input.

Rollback may stop new capture while retaining this additive table and all saved
history. No applied migration or existing run data needs rewriting.

## Validation

Check lossless retention beyond preview limits, all seven section projections,
image preservation, checksum/size rejection, tenant/attempt isolation, fallback
correlation, retry history and intent stripping. Inspect the Console with both
legacy attempts and a disposable captured-context fixture. Existing browser
executor tests continue to verify execution/verdict behavior independently.
