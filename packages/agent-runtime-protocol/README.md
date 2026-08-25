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
`agent.analysis.*` / `agent.spec.*` events. Analysis events contain concise
auditable summaries, never provider hidden chain-of-thought.

This package is intentionally separate from `@devproof/runtime-protocol`, which
is the browser data-plane protocol.
