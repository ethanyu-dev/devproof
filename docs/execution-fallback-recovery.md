# Model fallback and deployment interruption recovery

This change addresses missing fallback calls in the execution timeline, immediate cancellation during Agent Runtime deployment, and premature UNKNOWN write assessments during recovery.

## Model call timeline

Each candidate invocation generates a distinct `modelCallId`, shared by its started and completed or failed events. Console updates calls by that ID so an earlier failure cannot hide a running fallback in the same step. Legacy events are paired by segment, step, provider, model, and event order; an earlier completion cannot consume a later retry of the same model.

Segment completion events and interruption reasons remain visible. When a segment ends without an individual completion event for a call, that call is marked failed instead of remaining running. Page merging also reconciles retained live calls when their starts have fallen outside the latest server page. Provider errors and segment interruption reasons are both preserved.

## Agent Runtime deployment shutdown

`SIGTERM` / `SIGINT` stop registration refreshes and new task claims. Already claimed browser execution and specification analysis tasks can finish while heartbeats and outcome submission remain active.

- Allow active work to finish for the first 60 seconds.
- After 60 seconds, cancel remaining work while retaining lease renewal and outcome submission. Interrupted browser cleanup waits at most 10 seconds.
- Interrupted work submits `RUNTIME_SHUTDOWN` with failure class `RUNTIME_LOST`, without a product failure verdict.
- End the drain at 110 seconds, stop lease renewal, and reject late results. Exit the main process so a transport that ignores cancellation cannot keep it alive.

`railway.agent-runtime.json` already configures 120 seconds of `drainingSeconds`; preserve at least that grace period for both Agent pools. Task cancellation, lease loss, and task deadlines can still stop execution earlier. If outcome submission fails, the control plane continues its existing lease-loss recovery process.

## Evidence-based recovery

Under the shared resource lock, a recovery request stops command admission before assessing write state. Automatic `NO_WRITE_VERIFIED` requires a modern execution session bound to its task, complete launch identity and host/connection information, and a successful `session.open` audit for the exact lease/fence with an `about:blank` result. The session must have no human takeover and no potential writes across any command source, epoch, or status.

Navigation can trigger page scripts and business requests, so `page.navigate` remains a potential write. READ_ONLY intent, missing command history, and browser closure cannot establish an absence of writes. Retries still require independent closure evidence and remain subject to task deadlines and retry limits.

Interrupted executions with UNKNOWN / UNASSESSED writes show a business-state review notice and link to the session recovery record. Healthy OBSERVED sessions do not show that notice. The reported execution had already navigated, so its available evidence cannot automatically clear UNKNOWN. This change does not rewrite its historical outcome or rerun it.

## Rollout and validation

Deploy API and Web before both Agent Runtime pools. The Agent event contract adds only an optional field and accepts legacy events; the independently versioned Browser Runtime protocol is unchanged. No database migration is required. Old Agent instances retain their immediate-cancellation behavior until replaced, so let their active tasks finish before this first rollout.

Regression coverage includes candidate chains, same-model retries, event pagination, segment interruption, lease renewal and bounded cleanup in both pools, discarded late results, complete launch audits, and unknown-write protection. Replaying the reported execution's exported events verifies that the third candidate appears running and later shows its interruption reason. Raw production exports are not committed.
