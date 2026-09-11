# Browser Agent context delivery and progress

Task `2061f337-37c0-4db0-aa56-66ccc44154f3` reached the whitelist modal but
repeated cached DOM reads until finalization. All 11 clicks succeeded. Slow model
responses crossed the 120-second snapshot age limit: the executor refreshed the
page before the next model request, dropping the requested tail while its tool
summary claimed the content was still in the current page.

## Delivery invariants

- Every explicit cached read is remembered independently of the current snapshot.
  An automatic refresh retains the requested page with freshly computed metadata;
  old DOM is `HISTORICAL` and does not expose actionable refs.
- When full captured content and URL match after removing capture refs/scope IDs,
  a refresh transfers read coverage and the current window by line positions.
  Byte/character cursors cannot be copied because ref widths change. Changed
  content or URLs reset coverage. Only refs actually delivered from the new page
  become actionable; inherited coverage does not authorize unseen refs.
- Operation summaries retain bounded content previews. Only request construction
  may replace a preview with `contentInCurrentPage`, and only when that exact
  observation ID and cursor are delivered in the same request.
- `nextCursor` describes the next text boundary. `nextAction` uses the next unread
  cursor and disappears once all pages have been read. Metadata includes the
  current read, rather than lagging one operation behind.

## Memory and convergence

`record_progress` optionally saves a phase, exact quotes from delivered pages,
and the planned next action beyond the four-turn summary window. Unknown or
undelivered quotes are rejected. Quotes are observations, while the phase/next
action remain plans: they neither accept criteria nor reactivate historical refs.
Recording a plan does not earn an adaptive deadline extension.

Repeated reads are compared using observed content, ignoring changing observation
IDs, ref IDs and cursor offsets. Genuine new page content, including automatic
observations before a model call, or accepted criterion
states advance a semantic progress sequence. Screenshot changes alone can support
visual polling but cannot replenish the deadline budget.

The model receives remaining execution seconds separately from remaining tool
calls. Browser tasks get at most one bootstrap extension without observed progress;
each subsequent extension consumes a new progress key. A successful fallback is
preferred for the rest of the segment. With multiple candidates, an adaptive
browser model call is bounded by the lesser of its configured limit and 90 seconds.
An expired page is refreshed before fallback, preserving any explicitly requested
observation. Single-candidate and fixed-deadline limits remain unchanged.

## Task context

New Specs cannot declare another numbered Case or another Case's results as a
prerequisite; necessary checks and reference observations must be self-contained.
The browser task context explicitly treats old textual prerequisites as unverified
and requires local verification. Generation and execution instructions agree that
positive writes use explicitly supplied test accounts or TEST_ACCOUNT responses;
existing list records may be reused for read-only checks, not arbitrary writes.
Modal/dropdown exploration prefers observed container refs/selectors for scoped
snapshots after the relevant page has been read.

## Rollout and verification

Apply the additive migration `20260910143000_agent_meaningful_progress`, deploy
API/Agent protocol v2.15, then update the Browser Execution and Spec Analysis
Agent pools. No Browser Runtime release is needed for these changes. Rollback may
leave the two nullable progress columns in place.

Regression tests cover a 165-second model read followed by a refreshed, actionable
modal; changed-page historical delivery; ref-width/read-coverage changes; truthful
summary pointers; repeated reads across capture identities; persistent quoted
checkpoints; fallback freshness/selection/timeout; adaptive progress persistence;
and independent Spec prerequisites. These are deterministic tests with mocked
model/browser responses, not a production rerun of the failing task.
