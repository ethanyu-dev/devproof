# DevProof Agent Runtime Protocol

The protocol between the DevProof control plane and the thin Agent Runtime
runtime. DevProof owns run state, retries, cancellation, HITL, and cleanup. The
runtime leases one task, executes it, emits observations, and submits one
structured outcome.

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

The current contract accepts only `SPEC_ANALYSIS` and `BROWSER_EXECUTION`.
The retired optimization pool, its routes, capabilities and concurrency field
are removed. Existing workers for the two retained pools accept the registration
response (the removed optional concurrency field defaulted to zero). Upgrade API
and workers together with the coordinated database migration described in
[Upgrading DevProof](../../docs/upgrading.md#removing-premature-features).
