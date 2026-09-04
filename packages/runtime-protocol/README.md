# @devproof/runtime-protocol

Versioned wire contract between the DevProof Runtime Gateway and independently released Browser Runtime.

Protocol compatibility follows semantic rules:

- Major mismatch: connection rejected.
- Same major: accepted, with the lower minor selected for the connection.
- New optional fields require a minor release.
- Removing or changing fields requires a major release.

Protocol v1.13 adds `profile.snapshot` (System only), the optional `session.open.authSnapshot` reference, and session execution permits. Snapshot contents remain on the assigned Runtime; only opaque references and probe results cross the wire. Four independent contexts validate authentication before publication. Heartbeats carry correlation IDs so late ACKs cannot renew a revoked epoch. Execution permits bind a Session fence to an Agent epoch, human control, or bounded startup owner. Runtime expiry revokes session network access, closes its browser, and reports verified closure; ordinary heartbeats cannot revive a LOST session. Older nodes retain their negotiated command surface and must not receive isolated-auth execution.

Permits also carry an optional `controlGeneration` (absent means zero). Console takeover and release advance this generation independently of the Agent epoch so the running Agent can resume without restarting its Attempt. Commands from older control generations are rejected; an older expiry snapshot of the same currently renewed owner is ignored without revoking the active lease. `human.input.dispatch` carries the same generation, checked before each input in a batch, so input from a previous takeover cannot enter a later control cycle. Formal intervention resume still requires a new Agent epoch when the control generation has not advanced.

Protocol v1.2 adds the observable/strict Browser MCP command surface, SSRF-aware navigation scope and deterministic network fault commands. The API checks `runtimeCommandMinimumMinor` before dispatch, so a connected v1.1 Runtime can still reconcile or close existing sessions but receives `PROTOCOL_UNSUPPORTED` for v1.2 browser commands until it is upgraded and restarted.

Protocol v1.6 adds the control-plane-only `profile.purge` command. The Runtime atomically renames the selected persistent Profile to a tombstone before recursive deletion, rejects active Profile use, and treats an already absent Profile as a successful idempotent purge.

Protocol v1.7 adds an optional target to `page.snapshot`, serializes open Shadow DOM into persistent `page.dom` evidence, and lets `page.network` include same-origin JSON response bodies only when narrowed by `urlIncludes`. Response bodies are size-bounded and recursively redact credential-shaped fields. These enhanced evidence commands require a v1.7 Runtime; rebuild and restart independently deployed Runtime processes after upgrading.

Protocol v1.8 adds the `USER` Profile retention descriptor and the durable `profile.lifecycle` client event. The descriptor carries an owner-approved hostname allowlist and fixes inactivity retention at exactly 2,592,000 seconds (30 days). Runtime enforces the allowlist for navigations, redirects, subresources and WebSockets; it marks last use locally, skips active Profile directories, persists the expiry event, atomically tombstones expired directories, deletes them, and replays the event until the control plane acknowledges it. Legacy persistent directories without a `USER` marker are intentionally outside automatic retention.

Protocol v1.9 removes the hostname allowlist from the `USER` Profile policy. Profile retention now only marks the fixed 30-day lifecycle; navigation, redirects, subresources and WebSockets are governed exclusively by the Runtime-wide SSRF/network policy. v1.9 accepts and echoes the legacy wire field while rolling forward from v1.8 but never enforces or writes it to Profile metadata.

Protocol v1.10 adds the `VIDEO` Runtime artifact kind. Browser Runtime records a bounded viewport screenshot after every successful navigation or interaction command, persists the frame manifest across process restarts, and composes the frames into a low-bitrate WebM video when the session closes. The control plane stores both the step screenshots and final video in the configured S3-compatible object store.

Protocol v1.11 adds optional structured locator recovery diagnostics to failed command results. `LOCATOR_AMBIGUOUS` errors can include bounded candidate details and the `RESNAPSHOT_AND_RETARGET` recovery action. A Runtime also accepts the sole visible match when a selector resolves to multiple DOM elements, avoiding false ambiguity from hidden duplicates. Protocol v1.10 error results remain valid during rolling upgrades.

Protocol v1.12 adds the acknowledged `VIDEO_FINALIZATION_FAILED` Runtime event. The event carries a bounded, redacted summary of each encoding attempt together with the Runtime version, frame count, and close command correlation; it never carries screenshots, page content, URLs, or raw log streams. Runtimes emit it only after negotiating protocol v1.12 or newer and retain unacknowledged failure events in a bounded local spool for restart recovery.
