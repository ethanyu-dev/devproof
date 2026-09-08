# Browser navigation, completion and model timing

The local comparison exposed three distinct problems: the model copied a trial URL incorrectly, completed form interactions sometimes exhausted the deadline before recording a result, and long model waits could not be separated from SDK retries. The executor now removes one navigation decision, supports one-call result submission, and measures actual HTTP attempts.

## Initial navigation

When a task has an HTTP(S) `targetUrl` or `baseUrl`, the executor issues `page.navigate` with that original value before its first model request. It uses the existing Browser Runtime command path, network policy, evidence collection and observation projection. The result appears as a `runtime_initial_navigation` data message, including an actual failure when navigation fails. No new model tool or Browser Runtime protocol field is introduced.

Resolved human-input segments skip this navigation so a preserved browser remains on the page the human left. Tasks without a target also skip it. Later navigation remains available to the model. Cancellation, deadlines and resource cleanup retain their existing behavior; automatic navigation does not imply that any acceptance criterion passed.

The Run journal records `executor.navigation.started` and `executor.navigation.completed`. This browser attempt counts in comparison totals separately from model-selected browser calls. The model tool-call limit still counts model-selected tools; initial navigation adds at most one browser command per fresh segment.

## Combined final submission

`finish_verification` accepts an optional `criteria` array using the existing criterion-result schema. Every submitted result goes through the same validation as `record_criterion`: declared criterion IDs, observed evidence references, required evidence kinds for PASSED results, Chinese summaries and locator-recovery guards. The final verdict also passes the existing outcome schema.

New results are staged until the whole submission is valid. Duplicate IDs are rejected and a rejected finish does not partially accept its new results. Previously accepted incremental results remain available. `record_criterion` remains useful for long tasks and correcting intermediate conclusions; callers using the previous finish payload remain supported.

This saves the separate record/finish round trip when evidence is already sufficient. It does not infer results from page text or automatically pass a task after a successful browser action.

## HTTP attempt timing

The model client wraps the existing policy-enforcing fetch and leaves SDK retry behavior unchanged. Each attempt records an ordinal, duration, HTTP status when available and RESPONSE/ERROR/ABORTED/RUNNING outcome. Metadata contains no URL, headers, request body, credentials or provider error body.

Browser model completion/failure events put these observations under `inputPreview.transport`. This is trace metadata only and is never appended to model history. An in-flight attempt at finalization remains RUNNING; missing observations remain unknown. The comparison records total model duration, HTTP attempt count, retry count and complete HTTP duration. The difference between model and HTTP duration can include SDK backoff, parsing and local overhead; it is not itself proof of a particular cause.

The existing fixed deadline and adaptive per-model-call limits remain in force. Validation keeps the approved model and the 600-second case deadline. Results from longer-deadline qualification remain separate. Regression coverage includes exact initial URLs, failed navigation, cancellation, human resume, atomic submission, evidence rejection, locator uncertainty, SDK retries and telemetry propagation.
