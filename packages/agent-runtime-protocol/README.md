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
outcomes, read-only Linear/GitHub/Knowledge tool calls, and structured
`agent.analysis.*` / `agent.spec.*` events. Protocol v2.5 adds the isolated
`POST_RUN_ANALYSIS` pool, immutable `devproof.task-logs.v2` bundle reads,
task-scoped text-evidence reads, and evidence-cited structured findings.
Protocol v2.6 adds a compact Execution Manifest, bounded rolling analysis
context, and structured Runtime phase location on every finding.
Protocol v2.7 adds a complete evidence index and targeted evidence-record
reads so large post-run bundles no longer require exhaustive model scans. A
manifest larger than the bounded inline budget is represented by a compact
summary and read through `read_analysis_manifest` pages before evidence access
or report completion. Text evidence reports its total byte size on the first
page and supports targeted range reads so a Runtime does not have to scan an
entire large artifact. A finding may cite only evidence that the Runtime
actually fetched through `read_analysis_evidence` during the active lease;
Manifest membership alone does not satisfy the evidence requirement.
Analysis events contain concise auditable summaries, never provider hidden
chain-of-thought. Registration responses default a missing
`analysisConcurrency` field to zero so a v2.7 Runtime can remain connected to a
v2.4 control plane during a rolling deployment; the control plane still
requires v2.7 before it leases post-run work. Completed analysis reports are
limited to 512 KiB of UTF-8 JSON before transport.

Protocol v2.8 makes the Runtime's single declared pool part of registration.
The control plane rejects a declaration that does not match the pool bound to
the Runtime credential. The field remains wire-optional only so an already
pool-scoped v2.4-v2.7 worker can drain during a rolling upgrade and so a v2.8
Runtime can derive its pool from that credential when the deployment has not
yet added the explicit assertion. Once registered, the Runtime locks to the
single returned pool. Agent model candidates are selected from an independent
ordered list for that same pool; models are never shared implicitly across Spec
Analysis, Browser Execution, and Post-run Analysis.

This package is intentionally separate from `@devproof/runtime-protocol`, which
is the browser data-plane protocol.

Protocol v2.10 adds server lease time/lifetime metadata and structured browser-admission reasons. Agents renew through a single-flight supervisor with bounded RPC timeouts and a monotonic local safety deadline. Browser ownership binds the Agent epoch to the Session fence; a lease loss stops tools and enters bounded recovery through a new Attempt. Possibly completed writes require outcome reconciliation before conflicting work resumes. Existing protocol fields remain wire compatible while workers drain during rollout.

Protocol v2.11 extends optional server lease time/lifetime metadata to Spec
Analysis claims. Spec workers use the same single-flight lease supervisor and
abort source tools, trace requests, and outcome submission when ownership is
lost. The metadata remains optional for rolling upgrades; older control planes
use the conservative local expiry fallback and older workers can still drain.
