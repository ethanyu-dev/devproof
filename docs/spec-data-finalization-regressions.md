# Spec, test data, and finalization regressions

Date: 2026-09-10. Baseline: `origin/main` at
`c30b5b5e4836d5d16fb2cb48e465e5ceba57a34d` (Browser Runtime 0.2.23,
including merged PR #56). This change is a code fix with local regression
verification. It does not modify production business records, replay the original
write cases, merge, or deploy.

## Confirmed incident cause

Task `9ca4767f-788c-48bc-acfa-cba2418e4cc2` had two forced-finalization outcomes
that never committed. The exported durable events alone did not identify the
submission failure. The subsequent Railway process logs did:

| Case | Stop reason                  | Agent submission failure (UTC) | API error                                |
| ---- | ---------------------------- | ------------------------------ | ---------------------------------------- |
| 1    | FINALIZATION_RESERVE_REACHED | 2026-09-09 15:15:26.176        | HTTP 500, Prisma P2039, PostgreSQL 23514 |
| 5    | TOOL_LIMIT_REACHED           | 2026-09-09 15:11:24.475        | HTTP 500, Prisma P2039, PostgreSQL 23514 |

Both API traces identify `executionRun.update()` and the existing
`execution_runs_verdict_requires_execution` constraint. That constraint requires
a null verdict unless execution disposition is `EXECUTED`.

`submitOutcome` correctly converted an interrupted verification with uncertain
writes to `FATAL_FAILURE / BLOCKED`, but then populated the Run verdict from the
original verification (`INCONCLUSIVE`) instead of the converted projection.
The database rejected `BLOCKED + INCONCLUSIVE`, rolling back the entire outcome
transaction, including task/attempt results. The worker's two failed submissions
were followed by stopped heartbeats; lease recovery then replaced the original
termination with a generic unknown-write error. Browser release is not the direct
cause of these two submission failures.

The fix uses `projection.verdict` after write reconciliation. Blocked executions
have no Run product verdict; accepted partial criterion records, evidence, and
the original stop reason remain available. The database constraint is retained.

## Additional bounded changes

- New Spec generation requires `basis` on every criterion: a referenced source,
  a verbatim excerpt from observed source-tool content, and the specific
  observation target. Historical Specs remain readable without this field.
  Product requirements belong in criteria; uncertain interaction paths belong
  in exploration steps/assumptions; generated identifiers belong in test data.
  Unsupported remark fields and remark echoes must not become acceptance items.
  Creation options cannot establish list-filter behavior. Exact excerpt grounding
  is validated in code; semantic entailment remains a model/reviewer judgment.
- TEST_ACCOUNT remains a text-response HITL. It explicitly describes the business
  test subject, separately from the administrator's authenticated browser identity.
  Resolving write-account requests uses a PostgreSQL transaction advisory lock and
  existing resolved HITL replies to reserve accounts per parent task and business
  environment. Configured environment aliases are honored. Completed Cases retain
  allocations because their business records may still exist. Independent accounts
  and environments remain concurrent; explicit READ_EXISTING replies allow read-only
  reuse. This does not introduce a global account inventory or change browser capacity.
- Before writing, the Agent must check account/type uniqueness. Missing or conflicting
  data returns to HITL; it must not guess phone numbers or delete existing records
  to satisfy a precondition. Filtering should reuse existing data where possible.
- Repeated 400/409/422 write responses associated with the same target and form
  state stop after three distinct actions, even across fresh observations. Delayed
  feedback is counted once by command ID; corrected inputs have independent state.
  These are reasons to stop uncertain automation, not product failures. Runtime
  feedback is temporal, not proof of request causality. Prompts retain explicit
  network/console diagnostics, including on older nodes without action feedback.
- Forced-finalization events persist an owner-fenced pending outcome before
  cleanup. Recovery can retain it in task/attempt results as unaccepted diagnostics
  with the original reason; it cannot grant a product verdict, release uncertain
  writes, or authorize replay. This checkpoint is a fallback for future transport
  or submission failures, separate from the confirmed constraint fix.
- Worker submissions use the same completion ID for up to four attempts, retry
  5xx/429 with bounded waits, and keep lease supervision active. Lease loss cancels
  in-flight submission. A bounded durable failure event records HTTP status and
  termination without copying response bodies. Stable-evidence checks and the
  DOM-plus-visual approach remain intact.
- Console guidance no longer incorrectly states that unknown business access is
  always serialized; eligibility follows the configured scheduler and data policy.

## Regression verification

The disposable PostgreSQL launcher applies the full migration chain and never
loads application dotenv files. The new tests exercise the actual service,
transactions, constraints, and persisted rows. Before the verdict fix, both new
forced-finalization cases failed with SQLSTATE 23514; the other 100 integration
tests passed. They also directly assert that the unchanged CHECK rejects the
historical invalid value combination. After the fix, they verify accepted outcomes,
task/attempt result persistence, retained criteria, null Run verdicts, quarantined
write resources, and idempotent acknowledgements. A separate parallel transaction
test verifies exclusive account assignment and independent-account continuation.

After the fix, all **102 PostgreSQL integration tests across seven files passed**.
Final suites passed: API **603**, Agent **218**, Console **27**, Agent protocol
**14**, test domain **20**, contracts **36**, and PostgreSQL integration **102**
(**1,020 tests** total). Agent/API/Console type checks and Agent/API builds also
passed. An older mocked test explicitly expected the invalid blocked Run verdict;
its assertion was corrected while retaining its partial-criterion checks.

Relevant commands:

```sh
node apps/api/scripts/test-execution-concurrency.mjs
pnpm --filter @devproof/agent-runtime test
pnpm --filter @devproof/api test
pnpm --filter @devproof/agent-runtime-protocol test
pnpm --filter @devproof/test-domain test
pnpm --filter @devproof/contracts test
pnpm --filter @devproof/web exec vitest run app/console/runs/task-outcome.spec.ts
pnpm --filter @devproof/agent-runtime typecheck
pnpm --filter @devproof/api typecheck
pnpm --filter @devproof/agent-runtime build
pnpm --filter @devproof/api build
```

The independent production read-only smoke task
`e2f80bdb-aafc-4746-af91-859131fe98e5` observed effective DOM refs, screenshots,
and actionFeedback on Browser Runtime 0.2.23. Its outcome persisted normally as
`EXECUTED / INCONCLUSIVE`, with no HITL or recovery; its requested input-focus
criterion did not match the actual SSO page. It did not exercise the interrupted
write combination, and is not a deployment test of this patch.

The corrected read-only smoke task `c8866ef2-d2ca-4084-9a9f-7b8b72a32ddd`
completed `EXECUTED / PASSED`, with its outcome persisted at
2026-09-10 02:03:48.518 UTC and seven evidence records.

The first smoke also exposed an unknown-write diagnostic after confirmed browser
closure. `initialWriteState` accepts actual READ resource leases or a confirmed
owner outcome; `hasConfirmedWriteOutcome` deliberately excludes INCONCLUSIVE.
With optional data locks disabled, READ_ONLY intent alone supplies neither proof.
The generic navigate/click audit is conservative, but is not itself the decision
used by this recovery initializer. An empty temporal feedback window with
`coverageIncomplete=true` cannot prove absence of writes, even on a static heading.
This patch retains that boundary and adds a regression for it. The Console now
calls the list “unresolved records”, explains that its count is not a count of
blocked executions, and identifies empty protection scopes as diagnostics. It
keeps the actual unknown state and evidence-based reconciliation available before
replay. Removing this diagnostic safely requires a separate complete no-write
attestation, not treating READ_ONLY or an empty request list as proof.

## Deployment and limits

Deploy API and Console first, then both Spec Analysis and Browser Execution Agent
pools. Agent protocol becomes v2.13 with additive Spec provenance fields and
diagnostic event payloads; historical Specs and draining v2.12 workers remain
readable. No database migration, concurrency reduction, new HITL type, or Browser
Runtime release is required. Browser Runtime 0.2.23 is required for the feedback
guard's new observations; explicit diagnostic reads remain the older-node fallback.

Old failed runs are not rewritten or replayed. Their WRITE_OUTCOME_UNKNOWN state
still requires the existing business-state reconciliation. After deployment,
verify forced stopping against disposable data and confirm the accepted blocked
result, original reason, partial criteria, and resource quarantine. New Spec source
grounding should also be evaluated against real issue/model outputs; unit tests do
not prove that all natural-language hallucinations are eliminated.
