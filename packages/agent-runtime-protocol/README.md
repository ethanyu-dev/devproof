# DevProof Agent Runtime Protocol

Protocol v2.21 supports source-independent Spec tasks. The lease carries optional
`issueRef`, `pullRequestUrls` and `goal`, with `contextVersion: 2`. Workers bootstrap
through `get_task_context`; `linear_get_issue` is retained as an alias. `TASK_BRIEF`
is an actual cited source, and `intentEvidence` supports explicit requirements
from briefs, Issues and PRs while historical `issueEvidence` remains readable.
Only selected PRs require metadata/diff/relevant-file coverage; no PR is valid
for Issue-only or brief-only work. A deletion-only PR does not require reading
deleted files at head. Unclear intent can return `INPUT_REQUIRED / TEST_INTENT`.

All new Spec claims require minor 21. Drain old Spec workers and deploy the
database migration, API, Web and workers together; see [the upgrade procedure](../../docs/upgrading.md#source-independent-spec-tasks).
The historical protocol sections below describe earlier minimum versions.

The protocol between the DevProof control plane and the thin Agent Runtime
runtime. DevProof owns run state, retries, cancellation, HITL, and cleanup. The
runtime leases one task, executes it, emits observations, and submits one
structured outcome.

Browser execution receives only case-local instructions and observable acceptance
criteria. The control plane retains Spec analysis, source excerpts and criterion
`basis` for audit, but removes them from new Runtime snapshots and from claims of
older snapshots. The worker also strips provenance when parsing a lease. The
wire-compatible `businessReferences` field is empty; model prompts and execution
evidence indexes do not contain business references.

Browser criteria retain IDs, descriptions, required flags, observation targets
and observed evidence kinds. `BUSINESS_REFERENCE` is no longer required to pass a
browser check; a historical source-only requirement instead requires DOM and
screenshot evidence. Node/quote coverage and actual artifact validation still
apply. New generated goals contain the case name, prerequisites, test data,
actions and cleanup, without task-wide assumptions, risks, repeated acceptance
criteria or per-step expected-observation prose. Historical stored goals are not
rewritten. Deploy the API before the Browser Execution Agent so both enforce the
same evidence requirements. No database migration or Browser Runtime update is
needed.

The package also defines the typed `agent.segment.*`, `agent.model.*`, and
`agent.tool.*` trajectory vocabulary. Producers correlate events with a segment,
attempt, model step, and tool call ID; preview fields must already be bounded and
redacted before they cross the control-plane boundary.

Protocol v2.3 adds leased `SPEC_ANALYSIS` work, source-cited `agent-spec-v2`
outcomes, read-only Linear/GitHub tool calls, and structured
`agent.analysis.*` / `agent.spec.*` events.

Protocol v2.8 makes the Runtime's single declared pool part of registration.
The control plane rejects a declaration that does not match the pool bound to
the Runtime credential. The field remains wire-optional only so an already
pool-scoped v2.4-v2.7 worker can drain during a rolling upgrade and so a v2.8
Runtime can derive its pool from that credential when the deployment has not
yet added the explicit assertion. Once registered, the Runtime locks to the
single returned pool. Agent model candidates are selected from an independent
ordered list for that same pool; models are never shared implicitly across Spec
Analysis and Browser Execution.

This package is intentionally separate from `@devproof/runtime-protocol`, which
is the browser data-plane protocol.

Protocol v2.10 adds server lease time/lifetime metadata and structured browser-admission reasons. Agents renew through a single-flight supervisor with bounded RPC timeouts and a monotonic local safety deadline. Browser ownership binds the Agent epoch to the Session fence; a lease loss stops tools and enters bounded recovery through a new Attempt. Possibly completed writes require outcome reconciliation before conflicting work resumes. Existing protocol fields remain wire compatible while workers drain during rollout.

Protocol v2.11 extends optional server lease time/lifetime metadata to Spec
Analysis claims. Spec workers use the same single-flight lease supervisor and
abort source tools, trace requests, and outcome submission when ownership is
lost. The metadata remains optional for rolling upgrades; older control planes
use the conservative local expiry fallback and older workers can still drain.

Protocol v2.12 adds optional `termination.reason` to forced verification completion.
The control plane audits uncertain writes on these outcomes, preserves partial
criteria, and retains the original stop reason if execution is blocked. Deploy
the API before the new Agent; older APIs may discard this field and cannot safely
process the new forced-completion path. See [account HITL and action feedback](../../docs/browser-runtime-data-and-feedback-plan.md).

Protocol v2.13 adds optional criterion `basis` (source reference, verbatim quote,
and observation target) for persisted Specs; the new Spec generator requires it.
Forced-finalization events carry an owner-fenced `pendingOutcome` checkpoint.
Recovery retains that checkpoint as unaccepted diagnostics in a blocked result,
never as proof of a product verdict or a settled write. TEST_ACCOUNT resume data
also preserves its business-subject purpose and requested usage. Deploy the API
before both Agent pools; no database migration or Browser protocol change is
required. See [the regression notes](../../docs/spec-data-finalization-regressions.md).

Protocol v2.14 adds `LOCATOR_RECOVERY_EXHAUSTED` to verification termination
reasons and diagnostic finalization checkpoints. After two unsuccessful
retargets, the Agent stops further model and tool calls, preserves accepted
criteria and evidence, and marks unverified criteria `INCONCLUSIVE`. The API
still audits uncertain writes and retains the stop reason if it blocks the run.
Deploy the API before the Agent; older APIs cannot parse this reason. No database
migration or Browser protocol change is required. The accompanying DOM reference
fix requires upgrading independently deployed Browser Runtime installations.
See [the regression notes](../../docs/browser-reference-recovery.md).

Protocol v2.15 adds optional `payload.progress` to `agent.model.started` and
`agent.tool.completed`, with
`meaningful`, `sequence`, and `repeatedSteps`. The browser Agent derives progress
from newly observed content (including automatic snapshots) or accepted criteria,
not model prose, capture IDs, or screenshot animations. The API persists a per-segment progress key and the
key consumed by the last deadline extension. A browser task may receive one
bootstrap extension; subsequent extensions require a new progress key. Spec
analysis retains its existing deadline behavior. Older browser Agents that omit
progress receive at most the bootstrap extension.

Apply migration `20260910143000_agent_meaningful_progress`, deploy the API, then
both Agent pools. The optional trace field is wire compatible; new Agents require
the API update for progress-aware deadlines. Browser Runtime/protocol is unchanged.

Protocol v2.16 adds optional `observationTargets` to Spec and execution criteria,
`requireObservedEvidence` to execution criteria, and `observations` to criterion
results. Each target declares a label and source-grounded expected text; a PASSED
result must quote delivered browser observations covering every declared target.
New Spec generation requires targets, while historical Specs remain parseable.
Newly dispatched Agent Specs without targets cannot pass until regenerated.

Deploy the API before both Agent pools, and drain older workers before relying on
the coverage guard: old workers ignore the optional fields. Browser Runtime
0.2.26 fixes scoped references separately and must be installed on execution hosts.
No database migration or Browser wire-protocol change is required. See
[execution reliability notes](../../docs/execution-reliability-followup.md).
See [context delivery and progress](../../docs/agent-context-progress.md).

The current contract accepts only `SPEC_ANALYSIS` and `BROWSER_EXECUTION`.
The retired optimization pool, its routes, capabilities and concurrency field
are removed. Existing workers for the two retained pools accept the registration
response (the removed optional concurrency field defaulted to zero). Upgrade API
and workers together with the coordinated database migration described in
[Upgrading DevProof](../../docs/upgrading.md#removing-premature-features).

Protocol v2.17 negotiates `specFormat: "COMPACT"` on Spec claims. The model first
calls the local `define_requirements` tool with source-backed requirements, then
submits Cases with `name`, `steps` and `criteria`. Preconditions, test data and
cleanup are optional. The runtime assigns IDs, step order, default priority and
provenance; the persisted execution envelope remains compatible with earlier
Specs. New snapshots use `agent-spec-v3` and preserve scope, assumptions, risks,
requirements and explicit uncovered reasons in `context.specification`.

Each requirement must map to a required criterion or an explicit omission.
Omissions produce `SPEC_REQUIREMENT_UNCOVERED` diagnostics and `PARTIAL` coverage;
a Task whose generated subset passes still returns `INCONCLUSIVE` when requirements
remain uncovered. Source incompleteness alone does not change the product verdict.
This validates coverage of the model's fixed requirement list, not the semantic
completeness of its initial extraction or the truth of a browser assertion.

Observation targets remain conjunctive: every business object needs delivered
observational evidence. Within one target, `expectedText` and optional
`alternatives` are equivalent texts; any one may match. Each permitted text must
come from a referenced source. Deploy the API and both Agent pools together for
this behavior. Older Spec workers receive the prior format; persisted Specs are
not rewritten. No database migration or Browser Runtime upgrade is required.

Linked GitHub PRs still require metadata, diffs and related file reads before
requirements are fixed and the Spec is submitted (including changed Route Specs).
No linked PR or unavailable optional GitHub tools permit an explicitly partial
Spec. The compact format does not bypass source coverage checks.

Protocol v2.19 adds `specFormat: "CHECK_REFERENCES"` for Spec workers advertising
minor 19 or newer. Minor 18 workers continue receiving `COMPACT`; the existing
minimum Spec-worker minor remains 18. An older API can still assign `COMPACT` to
a new worker during rollout.

After `define_requirements`, the local `define_checks` tool validates batches of
criteria and returns stable `checkId` values. Valid entries are retained even
when another entry fails. Corrections include the current `expectedRevision`;
an existing `checkId` replaces only that check and cannot change its requirement
mapping. `supportingSourceRefs` can explicitly add observed UI/implementation
sources while the original requirement `basis` stays fixed. Errors identify the
input item, requirement, field, value, bound sources and candidate supporting
sources; candidates are never attached automatically.

Final Cases contain `name`, ordered `steps`, and `checkIds`, with optional
preconditions, test data and cleanup. The worker expands references into the
existing `agent-spec-v3` execution envelope, including full observation targets,
evidence kinds and provenance. A reused check becomes a distinct criterion in
each Case (`case-N-check-M`), requiring independent execution evidence. Unknown
or duplicate IDs and inline criterion overrides are rejected. Fixed-requirement
coverage and source coverage still run on the expanded Spec.

The check catalog is local to one Spec attempt; it is not a durable checkpoint
across worker restarts. No database migration or Browser Runtime protocol change
is required. See [the generation workflow](../../docs/spec-check-references.md).

Protocol v2.20 separates operator identity from business account subjects. New
Specs require `accountRequirementsVersion: 2`, an explicit requirements array,
and a `subjectBinding` for each requirement. Bindings reference Case steps,
source quotations and, for authentication subjects, acceptance criteria. Legacy
Specs and v1 account plans remain readable; new Spec claims require minor 20.

Browser policy carries effective versioned `accountRequirements`. `TEST_ACCOUNT`
requests declare existing slot IDs or cite actual observed DOM/network evidence
for an omitted business subject. Runtime and API both validate before entering
human wait. `ACCOUNT_REQUEST_INVALID` permits one bounded continuation using the
same lease and remaining tool budget. Browser workers below minor 20 skip tasks
carrying this contract. Account plan v2 stores a definition hash and reviewed
role corrections without rewriting the original Spec; reruns preserve and
remap those corrections. See the [implementation and recovery runbook](../../docs/test-account-requirement-design.md).

Protocol v2.21 adds object observation contracts. Spec snapshots advertise
`observationContractVersion: 2` only to workers at minor 21 or newer while
`BROWSER_OBSERVATION_V2_ENABLED` is enabled. Minor 20 workers still receive
account requirements without the observation contract. Browser tasks with object
observation contracts additionally require the bound-evidence capabilities;
the protocol version alone does not qualify a browser worker.

Protocol v2.22 adds optional gzip/SHA-256 `contextSnapshot` archives to browser `agent.model.started` events and `decisionOutput` to completed events. Archives retain complete model inputs (with explicit credential redactions); normal trajectory previews stay bounded. Browser Agent tool schemas request a public `stepIntent` action plan, which is stripped before execution. Deploy the additive context-history migration and API before the Agent. Old events remain readable as historical previews.

Protocol v2.23 adds `business-checks-v3`. Spec generation accepts compact subjects/state/timing checks, compiled into immutable version-3 contracts without DOM locators. Version-2 contracts remain readable. The API negotiates generation and gates execution claims by version and feature capability. See [business Spec design](../../docs/business-spec.md).

## Protocol v2.24

- `attempt-evidence-catalog-v1`: outcomes carry an attempt-scoped catalog reference; inline evidence metadata stays bounded at 200 while stored artifacts and criterion references remain complete. The API seals the catalog with count, digest and timestamp, and exposes cursor-based reads.
- `typed-checks-v1`: explicit TEXT/CHECKED/VALUE properties and structured network field assertions, gated during browser-worker claims. Historical contracts remain readable.
- Additive execution state fields provide account revisions, stable `recordRef`, request/read ordering and cleanup confirmations. Record progress accepts partial updates without losing immutable ownership and identity facts.

See [runtime reliability implementation](../../docs/runtime-reliability-first-four.md) for behavior, compatibility and validation.

## Protocol v2.26

- Optional `EXACT`/`DISPLAY_TEXT` modes distinguish identifiers and input values
  from display text with layout spacing. Generated business checks explicitly
  choose the identity mode; historical contracts keep their original semantics.
- Named resources carry an observed name and creation-write reference. Ownership
  requires a complete pre-create read, an unambiguous write receipt and a unique
  post-create identity. Data-precondition requests can identify a cited resource
  instead of an assigned account.
- Browser workers below minor 26 skip snapshots carrying the new match modes or
  named-resource ownership fields, including resumed execution state.
- New Spec generation accepts at most 10 Cases and five criteria/check references
  per Case. Both model-facing schemas and the API enforce these limits without
  truncating requirements; historical stored Specs retain their read limits.

Deploy the updated protocol packages, API and Agent workers together. The
Browser's capture and closure-audit changes additionally require a protocol 1.21
Runtime build; no database migration is introduced by these extensions.

## Protocol v2.27

- Inconclusive criterion results may include `blockingReason`
  (`DATA_PRECONDITION` or `ENVIRONMENT_UNAVAILABLE`) when evidence from the
  same attempt shows that test data, permission, or environment prevented the
  check. Product defects, missing evidence, and locator failures omit it.
- Verification may terminate with `RUNTIME_SESSION_UNAVAILABLE` when the
  browser session or its lease is gone. The API keeps the partial criterion
  results and does not replay the session's writes.
- Workers below minor 27 do not send either field. Historical results remain
  readable.

Deploy migration `20260921100000_criterion_blocking_reason` and the API before
the Agent. Browser protocol 1.22 is independent and follows in its own Runtime
upgrade.
