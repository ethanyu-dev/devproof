# Browser observation V2 (draft)

Status: implemented behind a disabled-by-default creation flag, with known
blocking defects. This branch is for review and follow-up fixes; it is not ready
for production enablement.

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

Agent protocol 2.21 carries the object contracts and evidence operations.
Browser support also requires explicit structured observation, phase, and action
observation capabilities. A stock Browser Runtime 0.2.28 installation is not
sufficient: the local validation used a build containing this branch's changes.
The draft still uses Browser protocol 1.18 and application version 0.2.28;
allocate the next protocol minor and a distinct runtime release, and verify
mixed-version negotiation before enabling the feature outside development.

Migration `20260915144500_object_observation_bindings` adds an evidence table,
foreign keys, and indexes. It does not backfill historical runs. Apply it before
deploying code that reads or writes bindings. For rollback, disable new V2 work,
drain in-flight V2 executions, and retain the table and compatible evidence
readers. Do not replay writes or delete evidence as a rollback mechanism.

Browser isolation, navigation policy, execution fencing, closure verification,
and write auditing retain their existing responsibilities. An unknown write
outcome cannot be relabeled as a verified absence of writes.

## Known blockers from a real application run

The most recent run produced two repeated-operation failures and one
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

## Merge and enablement checklist

- [ ] Fix field-label association using a representative nested Select fixture.
- [ ] Eliminate screenshot-induced false drift and retain real-drift rejection.
- [ ] Separate view and capture IDs throughout hints, tools, and API validation.
- [ ] Return actionable binding diagnostics and bound repeated failed binding.
- [ ] Decouple focus from V2 evidence contracts and preserve phase progress.
- [ ] Finalize Browser protocol/release versions and mixed-version tests.
- [ ] Add end-to-end capture → screenshot → binding → acceptance regression tests.
- [ ] Attach UI screenshots from disposable, non-private fixtures.
- [ ] Run the real workflow with valid authentication and eligible test data,
      then compare fixed Spec/model/data conditions before claiming improvement.

The prior component suites passed, but their fixtures did not cover these real
integration failures. The known defects are documented here, not fixed by this
PR preparation step.
