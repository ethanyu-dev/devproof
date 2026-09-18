# Browser observation V2 (draft)

Status: implemented behind a disabled-by-default creation flag. The observation
and recovery defects below have regression fixes; production enablement still
requires mixed-version validation and a real workflow with eligible test data.

## Problem and intended behavior

Text near a control is not enough to prove its state. A background table row
must not satisfy an assertion about a newly opened dialog, and a searched option
must not be treated as the selected value. V2 binds an entity, its region, phase,
state assertions, and evidence to one canonical browser capture.

The implementation adds:

- Versioned Spec contracts and shared evaluation of object state and coverage.
- Structured DOM observations, region lifecycles, and immutable API bindings.
- Explicit image delivery and visual comparison records, including conflict
  detection across different binding pairs.
- Active-region and owned-popup views that retain access to the canonical
  observation; optional deltas and bounded native field sequences.
- Four recent operation summaries plus durable facts and checkpoints, and one
  early recovery prompt without resetting execution budgets or stop counters.
- Account preparation on retry, evidence views, and separate presentation of
  execution failures, browser closure, and unknown business write outcomes.

## Compatibility and rollout

`BROWSER_OBSERVATION_V2_ENABLED=false` prevents new V2 Specs/runs. Existing
evidence remains readable, and legacy criteria remain supported. Historical
Specs are not automatically rewritten. The current execution defaults enable
combined observation and focus; deltas and form sequences remain disabled.

Agent protocol 2.21 carries the object contracts and evidence operations;
2.22 adds retained step contexts.
Browser support also requires explicit structured observation, phase, and action
observation capabilities. Browser Runtime 0.2.29 contains the screenshot and
label fixes below. It must be built from this branch and the installed service
restarted; restarting `pnpm dev` does not update that service. Browser protocol
remains 1.18 with capability negotiation. Finalize the protocol release and
verify mixed-version negotiation before enabling the feature outside development.

Migration `20260915144500_object_observation_bindings` adds an evidence table,
foreign keys, and indexes. It does not backfill historical runs. Apply it before
deploying code that reads or writes bindings. For rollback, disable new V2 work,
drain in-flight V2 executions, and retain the table and compatible evidence
readers. Do not replay writes or delete evidence as a rollback mechanism.

Browser isolation, navigation policy, execution fencing, closure verification,
and write auditing retain their existing responsibilities. An unknown write
outcome cannot be relabeled as a verified absence of writes.

## Earlier real-run findings

An earlier run produced two repeated-operation failures and one
inconclusive result due to existing business data. The first two cases made
25 and 41 successful model calls respectively. The second case selected the
reference option and observed the enabled switch, but all 23 binding attempts
failed: 13 `ENTITY_NOT_CONFIRMED`, 7 `OBSERVATION_NOT_AVAILABLE`, and 3
`SCOPE_NOT_OBSERVED`.

### Field label association

The real combobox and its label meet at an ancestor eight levels above the
input. The fallback label search stops after four. The capture contains the
correct selected display value and switch state but lacks the field name and
`LABELLED_BY` relation, so entity evaluation fails. A nested Chromium fixture
reproduces this. Expanding the search must preserve region boundaries and reject
multiple candidate labels or controls.

### Screenshot-induced drift

On a static page containing a text input, capture verification succeeds before
a screenshot and fails after the default JPEG screenshot. The screenshot
temporarily changes the input's style to hide and restore the caret, advancing
the mutation revision twice. Taking the same screenshot with `caret: "initial"`
keeps verification successful in the fixture. All ten relevant captures after
selecting the reference option in the real run were marked `DRIFTED`; the run
does not retain mutation-level diagnostics, so other changes cannot be excluded.

Fix the capture path without suppressing genuine changes to state, text,
selection, layout, or region identity. Frame-wide mutation tracking also rejects
unrelated background changes and needs a deliberate consistency policy.

### Ambiguous observation identifiers

The current page exposes an Agent reading-view `observationId`, while binding
expects the canonical `captureId`. Both are labeled `observationId`, and the
tool hint tells the model to use the current snapshot's identifier. All seven
rejected IDs in the real run were present in the corresponding current page
input. Use distinct fields or a validated internal conversion; preserve
cross-run, stale, and unrelated-capture rejection.

### Recovery and focus coverage

Binding diagnostics do not identify enough of the failed association to guide
recovery. An invalid scope reference can be reported as an unobserved region
even when the dialog is visible. One corrective prompt did not stop repeated
binding attempts. Focus is also gated by the presence of a V2 contract, so a
plain option-existence case did not receive it despite the focus policy flag.

The four-turn history bound worked and reduced the final text request size,
but this did not establish improved completion rates. The newer run split a
previous case and changed the login strategy, so it is not a controlled A/B.

## Fixes for the September 17 regression

The follow-up run had 2 passed and 8 inconclusive criteria. The interface case
made 19 explicit binding attempts: 9 unavailable observations, 8 unconfirmed
entities, and 2 missing scopes. All 18 structured captures were drifted. Two
other cases stopped correctly because their supplied account already had the
records that their creation preconditions required to be absent.

- Agent snapshots expose both their reading-view ID and canonical `captureId`.
  Explicit binding converts only an exact cached ID to its own capture; old
  IDs are never redirected to the latest page. API ownership and artifact
  integrity checks remain in force.
- Fallback label discovery traverses up to 16 ancestors, stops at form/dialog
  boundaries, and requires one label and one control. A deeply wrapped Select
  and an ambiguous multi-control fixture cover both outcomes.
- All Playwright screenshot paths preserve the caret. The focused-input
  Chromium regression reproduces default screenshot drift and then verifies
  a capture with `caret: "initial"`. Actual document, text, modal, and control
  changes still invalidate evidence. Optional `consistencyIssues` record the
  failure category and frame/node IDs. This does not relax frame-wide mutation
  checks for unrelated background changes.
- Binding diagnostics include valid scope refs, candidate controls, selected
  values, and missing label matches. Partial bindings count as unsuccessful.
  After three failed explicit binds for one target on the same page state,
  the Agent saves affected unresolved criteria as `INCONCLUSIVE` and is told
  to continue independent criteria. Existing results are preserved; valid
  later evidence can update the result. Recapturing unchanged content does
  not reset the counter, while actual page progress does.
- Failure cards separate the execution cause from a possible unknown write
  outcome. No submission is inferred from the write guard alone.
- New Spec generation separates independent creation/editing cases when their
  data prerequisites differ. Editing requires explicit ownership and mutation
  authorization plus restoration. Historical Specs are unchanged. For an
  existing creation case, retry with the existing “重新填写测试账号” option and
  provide eligible data; do not delete or alter someone else's existing record.

Validation covers real Chromium capture and binding, the Runtime session path,
Agent ID conversion and recovery/checkpoint continuation, API evidence
integration, and failure/retry presentation. These regressions establish the
fixes, not a real-world pass rate; the business workflow still needs a rerun.

## Merge and enablement checklist

- [x] Fix field-label association using a representative nested Select fixture.
- [x] Eliminate screenshot-induced false drift and retain real-drift rejection.
- [x] Separate view and capture IDs throughout hints, tools, and API validation.
- [x] Return actionable binding diagnostics and bound repeated failed binding.
- [ ] Decouple focus from V2 evidence contracts and preserve phase progress.
- [ ] Finalize Browser protocol/release versions and mixed-version tests.
- [ ] Add end-to-end capture → screenshot → binding → acceptance regression tests.
- [ ] Attach UI screenshots from disposable, non-private fixtures.
- [ ] Run the real workflow with valid authentication and eligible test data,
      then compare fixed Spec/model/data conditions before claiming improvement.

The original component fixtures missed these integration failures. The new
regressions cover the reproduced defects; the unchecked rollout work remains.
