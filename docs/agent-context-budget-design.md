# Browser decision context

Updated: 2026-09-10. Implemented locally with regression tests and an offline replay of execution `d8287709-8007-4215-8769-5c4629265858`. This change has not been validated in a new live model execution or deployed by this task.

## Decision

The browser agent's bounded mode sends immutable rules and task requirements, durable execution state, factual summaries of the last four completed model turns, and a separately pinned current page and viewport. It does not replay previous assistant messages, provider reasoning, or raw tool messages. The runtime generates summaries from actual tool inputs and results; no additional model call is needed.

This replaces the previous four-turn sliding conversation window. In that design, usable DOM could disappear when history was pruned even while the last screenshot remained available. An oversized snapshot plus action-feedback envelope could also put the DOM behind a generic JSON observation whose reads did not register the nested snapshot's refs.

## Request structure

| Message / request field      | Contents                                                                                                                                                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`                     | Browser rules, evidence requirements, recovery, reference validity, and completion instructions.                                                                                                                                                                        |
| Original task `user` message | Complete goal, acceptance criteria, business references, target URL, language requirement, and resolved human input.                                                                                                                                                    |
| `browser_working_state`      | Exact accepted criterion results, unresolved IDs, evidence inventory and stages, locator-recovery token/counters, observation index, latest action feedback, remaining model tool calls, enabled tool groups, automatic-observation count/status, and execution memory. |
| `recent_operations`          | Up to four complete turns of tool facts: call ID, tool, bounded arguments, transport outcome, and bounded result/correction. Initial navigation is also recorded as a runtime operation.                                                                                |
| `current_browser_page`       | Current snapshot's exact DOM page and refs, snapshot ID, URL/title labels, capture time, paging/incompleteness metadata, associated visual-observation ID, image availability, and the latest other observation page (including historical reads) when applicable.      |
| `current_browser_viewport`   | One available viewport image with its visual ID, dimensions, capture time, and CSS-coordinate guidance.                                                                                                                                                                 |
| `tools`                      | The currently advertised tool definitions, including enabled browser modules.                                                                                                                                                                                           |

A summary reports what the tool actually returned, not what the assistant claimed happened. `SUCCEEDED` means the command was executed, not that asynchronous business work finished or a criterion passed. Only validated criterion submissions update accepted results. Truncation is explicit; previews are not exact values to copy. Snapshot bodies are supplied in the pinned page window rather than duplicated in summaries. Reading a non-DOM or historical observation supplies its exact captured page separately so network responses and business values are not available solely through a shortened summary.

[`model-context.ts`](../apps/agent-runtime/src/model-context.ts) validates complete call/result groups before summarizing them. Multi-call turns stay grouped. A partly executed response is never added as a completed turn. The last four summaries replace raw history, and older summaries may be removed to meet the text budget. The immutable task, working state, current page, and newest summary have priority. If these cannot fit, the executor reports `AGENT_CONTEXT_BUDGET_EXCEEDED`, preserving accepted criteria and evidence in the error details.

[`operation-summary.ts`](../apps/agent-runtime/src/operation-summary.ts) keeps the latest browser action and up to eight recent distinct failed operations with repeat counts outside that rolling window. A later successful identical operation clears its failure entry; unrelated reads do not. This is a bounded factual checkpoint, not a generated plan or proof that a pending write completed. The latest action feedback and exact locator-recovery state are carried separately.

## Current page and refresh

Before the first bounded model decision, the executor takes a `page.snapshot` after any configured initial navigation. It refreshes again after page-changing operations (including successful form input), invalidated observations, expired snapshots, or a changed/missing previously associated viewport. A model-requested snapshot or recovery snapshot already supplies this observation, so a valid one is reused. Pure cache reads reuse the current DOM and image and make no browser call. An automatic refresh preserves the full observation page just requested by the agent, including network data or historical DOM, without registering historical refs.

Snapshots and images are associated using the visual-observation ID from the same successful command response. The latest snapshot page remains in every decision even when its original operation summary has aged out. Reading another page of that snapshot moves the pinned DOM window to that page. The index retains `readCursors`, `lastReadCursor`, and `nextUnreadCursor`, independent of the four-turn history.

A failed automatic capture is attempted once for the unchanged state. The context exposes the failure/missing page so the agent can choose a recovery; it does not silently run the same failing automatic snapshot before every subsequent local tool call. Another browser mutation or explicit snapshot can start recovery. Missing images are explicitly marked `UNAVAILABLE`; an artifact reference is never presented as if pixels were supplied.

Automatic observations are browser commands, count as browser work for outcome reporting, and collect ordinary observed evidence. They do not consume model tool-call slots or become extra model turns, consistent with existing initial-navigation and locator-recovery commands. Their count is explicit in working state and `executor.observation.started/completed` events. Capture waits respect cancellation and the deadline's finalization reserve. Cache reads still consume model tool-call slots. Existing stagnation detection evaluates original tool responses, not the summaries.

A successful capture can still show loading or a partial page. It cannot itself establish business success. The protocol does not expose an atomic DOM/screenshot generation covering every asynchronous update or manual interaction; Browser Runtime's live element validation remains authoritative.

## Paging, diagnostics, and ref delivery

[`browser-observation.ts`](../apps/agent-runtime/src/browser-observation.ts) keeps large content in a segment-local observation cache. A snapshot returns its real `page.snapshot`/`frame.snapshot` ID, exact text page, and concrete `read_observation` continuation. Large action feedback, errors, and other diagnostics are cached separately with bounded summaries and direct read actions. They cannot push a snapshot behind a generic `browser.result` JSON wrapper. Oversized non-snapshot envelopes may still use an addressable wrapper.

Ref registration only uses complete lines from an exact cached snapshot page. Generic JSON, network text, historical snapshots, skipped oversized lines, and discarded previews cannot register usable refs. Once a bounded request fits its final budget, only its pinned current DOM page is committed as the actionable ref set. A historical ref in a summary does not become usable by appearing in that summary.

- `OBSERVATION_NOT_READ` gives a concrete snapshot ID and legal cursor. It can return to an earlier read page if that page's refs have left the current window.
- `OBSERVATION_CONTENT_OMITTED` identifies a ref in a skipped oversized line after paging is exhausted and requests a narrower snapshot, rather than endlessly rereading page zero.
- Historical/unknown refs retain existing stale-reference recovery and token checks. Reading history never revives an old snapshot.
- `nextCursor: null` means the captured prefix is exhausted, not that the entire live page was observed. `captureTruncated`, `sourceTruncated`, and `omittedLine` remain explicit.

Cache cursors are opaque offsets belonging to one observation; they are not Browser Runtime pagination parameters. Only zero and generated legal continuation cursors are accepted. Snapshot text pages end on complete lines and respect Unicode boundaries and JSON escaping. The currently pinned DOM window is bounded rather than an unlimited list of all page refs.

## Budgets and compatibility

| Limit                      | Value                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Projected browser response | At most 16 KiB of serialized UTF-8 JSON.                                            |
| Observation text page      | At most 12 KiB after JSON escaping.                                                 |
| Operation summary          | Arguments up to 2 KiB; result up to 4 KiB, with explicit omission markers.          |
| Recent turns               | At most four summarized complete groups; fewer when required by the request budget. |
| Default text request       | 96 KiB including rules, task, state, tools, summaries, and pinned observation text. |
| Images                     | At most one viewport, appended outside the text-byte budget.                        |
| Observation cache          | 4 MiB of content per segment, 256 KiB prefix per entry, at most 256 index entries.  |

The byte budget is not a provider token/window guarantee. Fixed task requirements and accepted evidence are not shortened. Cache metadata/object overhead is additional memory. URL/title labels remain limited to 240/160 characters and are marked when shortened; use exact URL/title tools when needed.

Provider fallback uses the same frozen summaries, state, page, image, and tool definitions. Each candidate receives a cloned request. Trace previews remain redacted, truncated previews and should not be confused with complete model input. `historyMode: OPERATION_SUMMARIES` distinguishes the bounded request in context metrics. `retainedTurns` counts retained summaries and `compactedTurns` counts removed groups.

The default remains `DEVPROOF_AGENT_CONTEXT_MODE=BOUNDED`; `DEVPROOF_AGENT_CONTEXT_MAX_BYTES` defaults to `98304` and accepts 64 KiB through 1 MiB. `LEGACY` retains original assistant/tool history and provider reasoning, skips automatic decision snapshots, and does not advertise `read_observation`. Tool-catalog rollback remains independent through `DEVPROOF_AGENT_TOOL_SURFACE_MODE=LEGACY`. Settings apply to new segments; no API, database, or Console configuration migration is needed. HITL resume starts a new segment and cache while retaining the supplied human response in the task prompt.

## Verification

Regression tests cover deterministic facts versus assistant claims, complete multi-call grouping, provider fallback, exact task/criterion preservation, context limits, persistent failures, DOM/image association, refresh after clicks and fills, reuse during cache reads, current DOM after more than four turns, diagnostics paging, unread/historical refs, Unicode, cache eviction, evidence validation, human resume, cancellation, and finalization.

The offline replay uses the original execution's 13,130-character DOM and 5,792-byte action feedback. Its old projected envelope was 19,324 bytes and became a wrapper. The new projection is 14,630 bytes, directly contains the actual snapshot and target ref `f91e130`, and accepts that ref after ten summarized turns. The replay substitutes image bytes because this check exercises text projection/ref registration; it does not claim visual-model validation.

The earlier 2026-09-08 comparison measured the previous sliding-history design against unbounded history. Those historical savings are not measurements of this design. Live Kimi latency, repeat-operation rate, and task success still require a new controlled execution; neither unit tests nor the offline replay establish those outcomes.
