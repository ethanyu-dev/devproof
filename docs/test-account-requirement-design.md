# Business account requirements: implementation and recovery

Date: 2026-09-16. Implemented in the working tree; production deployment and repair are separate operations.

## Incident and intended behavior

Task `c6460316-b666-4a75-8174-cb70ab9a07c8` (PROD-6754) verifies model offlining timestamps. Its five Cases declared editor/export operator accounts as business test subjects. These persisted account plans blocked execution before any browser Run existed. The old login-keyword filter did not recognize labels describing create, edit, clone, list and export permissions.

| Dependency               | Owner                                                                   | Example                                                                        |
| ------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Operator identity        | `authRole`, existing Profile selection and browser login takeover       | Model editor or export operator                                                |
| Business account subject | `accountRequirements`, account preparation and validated `TEST_ACCOUNT` | Whitelisted user, transfer recipient, account whose permissions are under test |
| Ordinary test resource   | Case data, execution journal and cleanup                                | Model name, model ID, offlining timestamp                                      |

Mutating a resource does not imply an account requirement. Read-only verification can require a particular user account. `authRole` describes the required identity; it does not grant access or select another user's Profile.

## Generation contract

New Cases explicitly carry `accountRequirementsVersion: 2` and `accountRequirements`, including `[]` when no business account is needed. Every nonempty declaration includes:

```ts
type SubjectBinding = {
  kind: "BUSINESS_INPUT" | "BUSINESS_RECORD" | "AUTH_SUBJECT";
  target: string;
  stepOrders: number[];
  criterionIds?: string[];
  basis: { sourceRef: string; quote: string };
};
```

The shared validator checks version, binding, actual Case steps, current criterion IDs and exact quotations from sources read during this analysis. Authentication subjects must reference a criterion. Operator-only targets and known login-only declarations are rejected. Source text alone is not semantic proof: the generation instructions also require explaining how the account participates in the business operation.

Compact generation refers to criterion ordinals; referenced generation uses saved check IDs. Normalization resolves these to final IDs and preserves account provenance. Both Runtime finalization and API persistence enforce the contract before saving a Spec. Legacy records remain readable without silently acquiring v2 semantics. V2 reads do not silently filter requirements using legacy keywords.

## Execution contract

The control plane adds versioned effective `accountRequirements` to browser execution policy. Account requests use one of two structures in `context.accountRequest`:

- `DECLARED`: names existing `slotIds`; usage and form fields come from the effective plan.
- `DISCOVERED`: identifies the actual target, subject kind, current criterion, usage and a delivered observation (ID, cursor, exact quote, evidence references).

The executor requires observed DOM/network content. The API independently checks persisted evidence from the current Run/Attempt and a browser command owned by that task, then derives account slots, usage, purpose and the response form. Caller-supplied purpose is not authorization. Account-shaped forms in other HITL kinds are rejected. Previously supplied accounts are not replaced because they fail business preconditions; affected criteria remain inconclusive when appropriate.

A rejected tool call remains in the ordinary bounded correction loop. `ACCOUNT_REQUEST_INVALID` from outcome submission permits one executor continuation under the existing lease, deadline and remaining tool budget. Accepted criterion checkpoints survive that continuation. A second API rejection ends with an explicit Agent error instead of creating an invalid account wait. Existing uncertain-write reconciliation still applies.

This validates structure, provenance and observed content; it does not claim to mechanically prove arbitrary natural-language account semantics. Browser login continues to use existing takeover behavior and does not introduce password collection.

## Effective plans and recovery

Persisted Spec definitions remain immutable. Account plan v2 binds an effective requirement list to the full stored definition hash, with `effectiveAuthRole` and `resolution` (`DECLARED` or `REVIEWED_CORRECTION`, removed roles and reason). `resolveCaseExecutionDefinition` checks the hash and ensures only explicitly removed roles differ. Invalid plans fail closed instead of falling back to original demands.

Preparation, scheduling, account UI, browser goals/snapshots and reruns use the effective plan. Zero-demand Cases have no account preparation card. New-task reruns validate the old hash, remap both Spec and account provenance, calculate a new hash and retain the correction. In-place retries preserve the correction and reuse bindings only when complete role constraints still match.

The maintenance operation requires an exact team, task, Case execution, original definition hash, current plan revision and reviewed role removal. It locks the parent task first, then the account advisory lock, and uses a Case row compare-and-set. Eligible Cases must belong to the latest Spec and enabled deployment, remain pending with no Run/dispatch attempt, and still lack required accounts. This excludes Cases already eligible for dispatch or admission. The operation cannot restart completed/cancelled tasks or modify dispatched Runs.

An apply atomically changes the plan revision and account wait, refreshes the task deadline/projection marker, and writes `task.accounts.requirements_corrected`. Repeated identical correction IDs are idempotent; changed payloads conflict. Old account forms fail revision checks. Audit events contain requirement changes, not copied account values. Other admission checks remain active.

## Maintenance command

Build packages and API before using `apps/api/scripts/correct-account-requirements.mjs`. The command requires an explicitly configured `DATABASE_URL` and does not load `.env` files. Use the intended environment's existing secret injection; never put database credentials in a correction file or commit them.

Read-only inspection:

```sh
node apps/api/scripts/correct-account-requirements.mjs --team TEAM_UUID --task TASK_UUID
```

Create a reviewed JSON file from the current preview (placeholders below are not executable IDs):

```json
{
  "teamId": "TEAM_UUID",
  "taskId": "TASK_UUID",
  "correctionId": "NEW_UUID",
  "operator": "operator-identity",
  "reason": "The reviewed steps operate on model records; the removed roles only describe operator permissions.",
  "cases": [
    {
      "caseExecutionId": "CASE_EXECUTION_UUID",
      "definitionHash": "EXACT_64_CHARACTER_HASH_FROM_PREVIEW",
      "expectedRevision": "PLAN_REVISION_UUID",
      "removedRoles": ["EXACT_REVIEWED_ROLE"],
      "effectiveAuthRole": "Model editor"
    }
  ]
}
```

Validate without changing application data, then explicitly apply that same file:

```sh
node apps/api/scripts/correct-account-requirements.mjs --file correction.json
node apps/api/scripts/correct-account-requirements.mjs --file correction.json --apply
```

For PROD-6754, re-read the original task before constructing this file. Remove only the five reviewed operator declarations, preserving their needed permissions in `effectiveAuthRole`. Do not supply fictitious accounts. If it has since terminated or dispatched, the tool rejects in-place repair; do not bypass these guards. A successful repair means normal admission can resume, not that the browser is authenticated or the product passed.

## Rollout and rollback

Agent protocol is v2.20. Spec workers below minor 20 cannot claim new analysis. Browser workers below minor 20 cannot claim tasks carrying the structured account contract. Upgrade both pools; upgrading only the Spec pool is insufficient. Legacy browser tasks without the contract remain claimable by compatible old workers.

Deploy API first, then Spec and Browser Execution Agent pools and Web. Expect a temporary pause in new Spec claims while workers are upgrading. No new database migration or Browser Runtime daemon release is needed. After verifying both worker pools, preview and apply any reviewed historical correction.

Do not roll back to an API that only reads v1 plans after v2 plans exist: retain the compatible reader or stop dispatch before rollback. Invalid parsing must never silently restore original account requirements.

## Observability and verification

- `devproof_account_requirement_rejections_total{boundary,code}` counts API Spec/outcome rejections and persisted executor account corrections with bounded labels.
- `executor.accounts.request_rejected` records local corrections; existing Spec tool traces retain generation correction details.
- `devproof_account_requirement_corrections_recent` counts reviewed correction events in the last 15 minutes. Metric labels contain no account or task identifiers.

Regression coverage includes the five incident labels, zero-account resource operations, genuine read/write subjects, authentication subjects, fabricated sources/observations, API rejection before state mutation, browser login takeover, bounded outcome correction, mixed worker versions, hash/revision conflicts, immutable originals, stale forms, concurrent allocation/correction, idempotent repair and rerun provenance.

Run package/app tests, `pnpm typecheck`, `pnpm build`, `pnpm format:check`, and `node apps/api/scripts/test-execution-concurrency.mjs`. The latter uses disposable loopback-only PostgreSQL, never production data.
