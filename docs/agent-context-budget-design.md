# Design 1: bounded browser working context

Date: 2026-09-08. Status: implemented and regression-tested, with an initial isolated live comparison completed. The small sample does not establish an overall reliability or latency gain. See the [comparison procedure](local-browser-comparison.md) and [execution follow-up](browser-execution-reliability.md).

## Problem and decision

The Browser Verification Agent previously appended complete tool results to an unbounded history and resent that history on every model request. Trace preview limits did not reduce model input. Earlier page bodies and transport fields accumulated even after navigation.

The executor now builds a bounded view from the immutable task, deterministic execution state, and recent complete response/tool groups. Large browser observations stay in a segment-local cache and can be read through a local `read_observation` tool. No LLM summarizer or additional service is involved.

| Alternative                                                   | Decision                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Keep only the last N turns                                    | Insufficient alone: large turns still overflow, and earlier values disappear.      |
| Deterministic state plus cached observations and recent turns | Implemented: retains accepted evidence and makes earlier observations retrievable. |
| LLM-generated summaries                                       | Deferred: adds latency and another source of omissions or invented conclusions.    |

## Request and result flow

[`model-context.ts`](../apps/agent-runtime/src/model-context.ts) retains the original instructions and task contract without shortening criteria, evidence requirements, business references, or resolved human input. Each bounded request adds a `browser_working_state` user-data block containing:

- Accepted criterion results, including their exact summaries and evidence references.
- Unresolved criterion IDs and the evidence ID/kind inventory.
- Pending locator-recovery state and its token.
- An observation index with opaque IDs, command types, capture order/time, URL/title labels, cache availability, and ref validity.

Only existing `criterionResults`, `evidence`, and `locatorRecoveryState` determine execution state. Observed page text, cached values, and actions such as `clicked: true` cannot create an accepted result. Bodies appear in recent tool outputs or on demand, rather than being duplicated in the state block. Non-text result objects are retained as JSON observation content; arbitrary page text is not converted into inferred facts.

[`browser-observation.ts`](../apps/agent-runtime/src/browser-observation.ts) changes only what the model sees. The executor continues using original responses for evidence collection, locator recovery, progress detection, and existing trace previews. Outcome, diagnostics, recovery tokens, and artifact IDs/kinds remain accessible. Transport IDs, echoed payloads, and artifact storage metadata are omitted from the projection. Screenshot metadata remains in tool text. With Browser Runtime v1.16, the API also hydrates one owned viewport image and the executor appends it as a typed Responses `input_image`, outside the text history budget. See [DOM + visual browser observations](dom-visual-browser.md).

Context compaction originally shipped with all 39 browser command variants advertised. The separate [tool-module change](agent-tool-surface-design.md) now controls that catalog independently. Spec Analysis, Console, public MCP tools, Browser Runtime payloads, and database schemas are unchanged.

## Budgets and paging

| Limit                     | Implementation                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Browser result projection | At most 16 KiB of serialized UTF-8 JSON; an oversized envelope becomes a cached-observation pointer.    |
| Observation text page     | At most 12 KiB after JSON string escaping.                                                              |
| Recent history            | At most four complete response groups; fewer when required to fit the byte budget.                      |
| Default request budget    | 96 KiB, including instructions, task, state, tools, and retained turns.                                 |
| Cached content            | Up to 4 MiB per execution segment, with a 256 KiB prefix per observation and at most 256 index entries. |

The cache limit measures content bytes; bounded index/cursor bookkeeping and JavaScript object overhead are additional memory. Oldest bodies are evicted first. Their index entries report `EVICTED` until those entries also age out.

`read_observation` accepts `observationId` and an optional cursor, defaulting to zero. Only zero and cursors returned as `nextCursor` are accepted. Reads use captured content, make no browser request, and count toward the existing tool-call limit. A `nextCursor` indicates more captured content; `null` indicates the end of that capture, not necessarily the complete live page. Pages with remaining content also return a `nextAction` containing the exact `read_observation` tool name and arguments. These offsets belong to the captured observation and must not be reused as Browser Runtime pagination offsets. Oversized envelopes likewise expose a concrete cached-read action.

Snapshot pages end on complete lines to avoid splitting refs. An individual line larger than a page is explicitly skipped with `omittedLine: true` and guidance to narrow the snapshot target or depth. Unicode boundaries and JSON escaping are counted. `captureTruncated` identifies the cache prefix limit; `sourceTruncated` identifies content already truncated by the Runtime. Neither can be recovered by paging beyond the capture. Missing, evicted, or foreign-segment observations return a concise rejection requesting a new scoped capture.

URL/title index labels are limited to 240/160 characters with `metadataTruncated: true` when shortened. They are navigation aids, not exact values to copy. Use `page.get_url` or `page.get_title` for an exact value. Full observed URLs are used internally when detecting URL changes.

The byte budget is a local request limit, not a provider context-window or token guarantee. Candidate fallback uses the same cloned input and tools; the budget accounts for the longest serialized candidate model name. Each provider call receives its own copy so later work cannot mutate a previously issued request.

## Compaction, refs, and capacity failures

Compaction occurs before the next model request and removes only complete response groups. Each group includes opaque reasoning/provider items and every matching tool result. Incomplete, duplicate, or orphaned call/result pairs cannot enter retained history. Cancellation and tool-budget exhaustion never replay a partially executed response.

The newest complete group is retained even when older groups are removed. If the immutable task, necessary state, tools, and this group still exceed the budget, execution returns `FATAL_FAILURE` with `AGENT_CONTEXT_BUDGET_EXCEEDED`. The error details retain accepted criteria, evidence IDs/kinds, and measured/allowed bytes. It reports an Agent capacity problem without fabricating a product verdict. Browser release still follows existing cleanup behavior.

The most recent successful snapshot is the only source of usable refs, and a ref must actually have appeared in a returned page. Successful form input (`fill`, `type`, `check`, `uncheck`, and `select`) preserves those refs, matching the Runtime's live element resolution and avoiding a new snapshot after every field. Failed form input, other mutating commands, tab actions, waits, observed URL changes, new snapshots, and transport uncertainty conservatively invalidate prior refs. Cached historical reads never restore their validity. Ref attempts rejected locally do not dispatch browser writes or weaken the existing recovery-token checks.

Validity is based on actions and observations available to this executor. The browser command response does not expose a control generation; this layer cannot detect every asynchronous DOM update or concurrent manual action. Browser Runtime validation remains authoritative. Formal HITL resume creates a fresh segment with the existing `humanResume` input and an empty cache. Cache IDs cannot survive a new lease, process loss, or another task.

Opaque provider items are preserved within retained groups. Mocked Responses replay and fallback formats are tested, and the initial live comparison exercised one approved gateway/model combination. Broader gateway compatibility remains unverified. Existing trace previews remain bounded previews, not full transcript storage.

## Verification

Regression coverage includes long workflows with accepted evidence, recovery of an early order number after its original turn is compacted, local paging to a later ref, invalidation after mutation, scoped resnapshot, frame refs, Unicode, oversized lines/envelopes, eviction, human resume, cancellation, provider fallback, multi-call responses, and capacity failures. Existing evidence validation, locator recovery, and raw-observation loop detection tests continue to pass.

A fixed 30-turn fixture uses the canonical browser-command JSON schema and identical response groups in both modes. It measures complete serialized request bodies, including JSON escaping. It isolates compaction rather than simulating a live model:

| Mode            | Cumulative request bytes |
| --------------- | -----------------------: |
| Full history    |               14,959,830 |
| Bounded context |                2,619,638 |
| Reduction       |                   82.49% |

Request sizes stabilize after compaction when the fixture's essential state is fixed. A separate executor fixture retrieves an early observed order number, uses that exact value, retains required screenshot evidence, and finishes both criteria with eight browser commands; cache reads add no browser commands.

Validation at implementation: 141 Agent Runtime tests, repository-wide type checking, Agent Runtime build, and formatting checks. These checks do not establish provider token savings, latency improvements, or unchanged live-task success rates. Live comparisons should measure those separately, including fresh snapshots, cached reads, stale-ref attempts, and verdict/evidence correctness.

## Configuration and rollback

The Browser Agent defaults to `DEVPROOF_AGENT_CONTEXT_MODE=BOUNDED`. `DEVPROOF_AGENT_CONTEXT_MAX_BYTES` defaults to `98304` and accepts 64 KiB through 1 MiB. Both are internal environment settings, with no Console settings added.

For rollback, set `DEVPROOF_AGENT_CONTEXT_MODE=LEGACY` and restart the Agent Runtime after draining active segments. New segments use the original full-history/raw-output path and do not advertise `read_observation`. Configuration is not changed in the middle of an active conversation. Browser commands, artifacts, and database records need no reversal.

The context switch does not change the tool catalog. To restore the complete command catalog as well, set `DEVPROOF_AGENT_TOOL_SURFACE_MODE=LEGACY` independently.
