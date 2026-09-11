# Execution reliability follow-up

Repeated snapshots could consume a run while a usable Save button was already
visible. A successful click could also be followed by locator-recovery exhaustion
before its pending write had been checked. This change addresses the execution
and reporting defects independently of the earlier adaptive DOM delivery fix.

## Browser execution

- Resolve a scoped snapshot's root before replacing the browser ref registry.
  Bind new refs directly to the actual evaluating frame, including microfrontends
  that override `ownerDocument`. Full snapshots reuse their known frames.
- Validate recovery tokens and retargeting constraints before dispatch. Missing
  or incorrect acknowledgement does not click or consume a real retarget attempt.
  Successful acknowledged actions clear recovery and retain the normal page and
  network follow-up; failed retargets still have a two-attempt bound.
- Count newly observed DOM node facts, ignoring ref renumbering, indentation,
  boxes, and depth/subset permutations. Changing snapshot parameters alone no
  longer resets repetition tracking. New values and page text still count;
  screenshot changes alone still cannot extend the adaptive deadline.
- Project browser `TIMED_OUT` and `CANCELLED` results as failed outer tool calls.

## Acceptance and models

New Specs enumerate observation targets per criterion, using distinct labels and
source-grounded expected text. PASSED requires a matching quote from a delivered
browser observation for every target. The same validation applies to incremental
results and final submissions. Missing coverage must be investigated or reported
as INCONCLUSIVE. This verifies quotation provenance and declared target coverage;
the model still interprets business behavior and visual comparisons. Seeing a
dropdown option alone does not establish the corresponding selected form state.

Both Agent pools remember candidate health across runs within each executor.
Exhausted balance/quota or authentication failures cool down the credential and
its model aliases for 30 minutes. Ordinary rate limits cool down a model for one
minute; two consecutive other failures cool it down for five minutes. A success
resets its failure streak. Different credentials remain available. Health is
bounded, process-local, and diagnostic failure events include the cooldown reason.
This does not change the model SDK's internal HTTP retry policy.

## Source discovery and logs

Issue resolution also reads comments. Linear GraphQL comments are capped at five
pages of 100; unavailable or truncated later pages preserve the Issue and produce
diagnostics. MCP uses an available read-only comments tool when the Issue has no
PR link. If no direct links exist, GitHub discovery searches explicitly configured
team repositories/organizations for PR bodies with an exact backlink to the same
Linear workspace and Issue. Queries are bounded to eight and incomplete results
remain visible as diagnostics. Similar titles or another workspace's Issue are
not associations.

For implementations with no backlink, ISSUE_SPEC task creation accepts
`pullRequestUrls`, for example `["https://github.com/acme/web/pull/42"]`. Explicit,
linked, and discovered URLs are persisted in the immutable Issue source and
become the allowlist for later source tools. Existing source coverage checks still
require PR metadata, diffs, and file reads.

The task log identifies its Spec scope and links each browser execution's logs
and screenshots. Export still includes the task and all executions. Separate
completion events keep their actual timestamp instead of subtracting elapsed
duration; equal timestamps use numeric event sequence order.

## Rollout and verification

Deploy API with Agent protocol v2.16, then both Agent pools. Drain old workers
before relying on the new acceptance guard. Regenerate old Agent Specs without
observation targets before rerunning them. Install Browser Runtime 0.2.26 on the
execution hosts; a platform update alone does not fix the local ref registry.
There is no database migration. Historical result records are not rewritten.

Regression coverage includes real Chromium scoped refs in the main page and an
iframe, sandbox document virtualization, pre-dispatch token rejection, successful
write follow-up, missing-object acceptance rejection, model fallback across runs,
DOM subset stagnation, bounded source discovery, and log chronology. These are
controlled regressions, not a rerun of the original business workflow.
