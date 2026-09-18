# Source-independent test tasks

Status: implemented on 2026-09-17. The impact inventory below records the pre-change coupling; the contract and rollout notes describe the implementation.

## Objective and existing identity

Allow a testing task to start from a GitHub PR, a Linear Issue, or an explicit testing brief. Issue and PR references are inputs to specification analysis, not task identities. A missing Issue or a missing PR must not by itself block execution.

`TaskExecution.id` is already a UUID. The creation uniqueness constraint is `(teamId, idempotencyKey)`; `(teamId, sourceKind, sourceRef)` is a non-unique index. No primary-key replacement or reparenting of Runs is required. The change concerns input contracts, source requirements, presentation, and integration behavior.

Retain the existing pipeline:

```text
Console / HTTP / MCP / Feishu
             |
     normalized Spec task input
             |
       SPEC_ANALYSIS
             |
     PROFILE_RESOLUTION
             |
       SPEC_EXECUTION
             |
      Cases / Runs / evidence
```

`DIRECT_RUN` remains the API mode for callers that already supply an executable Run. Manually creating a task in the Console does not imply `DIRECT_RUN`: a manually pasted PR should still generate a Spec and Cases.

## Current coupling and impact inventory

Paths below are relative to the repository root.

| Area                                                                                                    | Current dependency                                                                                                         | Required change                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/prisma/schema.prisma`                                                                         | `ISSUE_SPEC` enum; one display source; JSON input/context snapshots                                                        | Add a neutral Spec kind; preserve UUID and existing keys; version readers of stored inputs and contexts                                         |
| `packages/contracts/src/index.ts`                                                                       | Required `issueRef`; `testGenerationContextSchema.issue` required, including its transform                                 | Introduce a source-independent input/context schema; adapt legacy inputs; allow absent Issue                                                    |
| `apps/api/src/task-executions/task-execution.service.ts`                                                | `createIssueTask`, Issue-derived titles, kind branches, search, deterministic analysis, dispatch references                | Use a shared Spec-task predicate/normalizer; derive display metadata from available inputs; search PR references as well as Issue references    |
| `apps/api/src/task-executions/task-analysis-input.ts`                                                   | `assessAnalysisInputs` requires Issue description, at least one readable PR, and target; resume requires each missing type | Separate absent, unreadable, insufficient and excluded sources; use explicit blocking reasons and allow alternative sufficient input            |
| `apps/api/src/agent-runtime/spec-analysis-runtime.service.ts`                                           | Issue bootstrap; `requireIssueSource` authorizes GitHub reads; context assembly and final title require Issue              | Bootstrap from registered task sources, authorize PRs independently, build optional-Issue context, use the same completion gate as the executor |
| `apps/agent-runtime/src/spec-analysis.executor.ts`                                                      | Must call `linear_get_issue` first; tool exposure and final validation require Issue and PR                                | Source-aware tool selection, prompt, bootstrap and finalization                                                                                 |
| `packages/agent-runtime-protocol/src/index.ts`                                                          | Required `snapshot.issueRef`; fixed missing-input enum; no manual source kind                                              | Version source-aware leases/input requests; add persisted manual brief sources; gate incompatible workers                                       |
| `packages/agent-runtime-protocol/src/spec-necessity.ts` and `spec-capabilities.ts`                      | Issue is the primary scope anchor; localization explicitly requires `issueEvidence`                                        | Generalize explicit intent evidence without making every PR/file a scope authority                                                              |
| `packages/test-domain/src/index.ts` and `apps/api/src/specifications/issue-context-resolver.service.ts` | Deterministic generator and resolver assume Issue; readiness is tied to Linear                                             | Support neutral contexts or explicitly reject unsupported analysis modes; calculate source-specific readiness                                   |
| `apps/api/src/task-executions/task-profile-resolver.service.ts`                                         | Spec-kind guards and `.issue.assignee` access                                                                              | Support neutral Spec tasks; optional Issue handling; owner mode remains an explicit identity policy                                             |
| `apps/web/app/console/runs/task-create*` and `task-analysis-input.tsx`                                  | Issue mandatory in both form and parser; form target mandatory; supplement card says Issue and PR are both required        | Accept PR-only and Issue-only creation, adjust owner availability and supplement UX                                                             |
| `apps/api/src/integrations/feishu-integration.service.ts`                                               | Issue-only message entry; PR not extracted; first non-Linear URL becomes target                                            | Shared typed reference parser; explicit task source/target classification; preserve event and task identity                                     |
| Feishu card, waiting notifications and notification outbox worker                                       | Card ignores specific waiting message; GitHub completion target is the snapshot's primary PR                               | Show actionable missing input; preserve task-based card and comment deduplication; select writeback destination independently                   |
| Task detail/list/report/export, stage retry, full rerun, Case rerun                                     | `ISSUE_SPEC` assumptions, Issue labels, source fallback                                                                    | Include the neutral kind, preserve frozen evidence, display available context, avoid `undefined` titles                                         |

The executable browser layer, session protocol, lease fencing, browser evidence, and Run verdict model do not need a structural redesign. Their callers and task routing still need regression coverage.

## Contract and persistence

Use `SPEC_TASK` as the neutral kind. Keep accepting legacy `ISSUE_SPEC` requests through the shared schema and Spec-task routing. A new request is:

```json
{
  "kind": "SPEC_TASK",
  "idempotencyKey": "client-request-uuid",
  "title": "Verify the order cancellation change",
  "goal": "Verify cancellation and the persisted order status",
  "pullRequestUrls": ["https://github.com/acme/shop/pull/123"],
  "deployments": [
    {
      "key": "preview",
      "name": "Preview",
      "targetUrl": "https://preview.example.com"
    }
  ],
  "profilePolicy": {
    "strategy": "REQUESTER",
    "onUnavailable": "WAIT_FOR_PROFILE"
  }
}
```

Creation requires at least one meaningful input: Issue reference, PR reference, or testing brief. Title and environment URL alone are insufficient. Brief-only tasks are also supported. Omit `issueRef` when creating without an Issue; `null` is only used by the supplement endpoint to remove a previously selected Issue. Keep one optional Issue in the first version; multiple Issues are not needed to deliver this request.

Normalize external references before creation, authorization, comparison and lookup. Strip supported PR view suffixes/query fragments through a shared parser, reject malformed references, preserve the existing provider/credential routing restrictions, and deduplicate normalized PRs. Keep an explicitly selected primary PR separate from sorting so normalization does not change the writeback destination.

Persist the submitted input and a versioned, per-attempt source manifest. Manifest entries distinguish provider/kind, canonical reference, origin (`EXPLICIT` or `DISCOVERED`), selected scope, resolution status, diagnostics, and resolved revision. Use `TaskAnalysisSource` for fetched immutable content and content hashes; a manually supplied brief needs a real source record, such as `TASK_BRIEF`, with a task-local URI and a content hash. Never invent a Linear Issue to satisfy an old schema.

The manifest lives in `TaskStageAttempt.contextSnapshot`, with updates protected by the existing lease checks. Keep the submitted attempt input immutable. A separate reference table is optional for indexed multi-reference search; it is not a new task identity and must not introduce global uniqueness on Issue or PR. A task-level reference projection may be backfilled from versioned inputs for search without modifying historical Specs.

`sourceKind/sourceRef` can temporarily remain a display projection: explicit Issue, otherwise primary PR, otherwise manual brief. Business decisions use the manifest, not that projection. Display title priority is an explicit title, then Issue title, then PR title, then a brief summary. The explicit title should not be overwritten after analysis.

Keep creation idempotency distinct from source identity. The same PR can produce multiple tasks for different environments or explicit new tests. Request retries reuse their original key. Compare normalized creation requests consistently, retaining the legacy comparison path for existing keys; do not compare a retried create request against an input later modified by human supplementation. `TaskExecution.creationInputSnapshot` stores the immutable creation request. The migration backfills existing tasks from the first analysis attempt, falling back to the task input.

## Analysis admission and evidence rules

| Input                                      | Expected behavior                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Readable PR, no Issue                      | Read PR metadata, diff and relevant implementation; derive a bounded change-focused Spec                                              |
| Readable Issue, no PR                      | Derive a Spec from explicit requirements; state that code changes were not inspected                                                  |
| Issue and PR                               | Analyze selected sources together; retain explicit requirements and identify requirement/implementation conflicts                     |
| Testing brief, neither link                | Generate against the brief if it supplies concrete observable outcomes; otherwise request clarification                               |
| Only a target URL, or no substantive input | Reject creation with an actionable message                                                                                            |
| Explicit source cannot be read             | Retry transient failures; surface credential/reference errors; do not silently omit the requested source                              |
| Optional discovered source unavailable     | Record a diagnostic; proceed if selected inputs already support the test; do not recursively expand scope                             |
| Target absent or ambiguous                 | Discover a unique valid deployment when possible; otherwise wait for environment selection before profile authorization and execution |

Absence is different from failure. Supplying a PR then receiving 403 must not be treated as having intentionally submitted an Issue-only task. The user may fix access, replace a source, or explicitly exclude it if remaining context is sufficient; record the scope decision. Once a discovered PR is selected for change analysis, enforce its read/coverage requirements as for an explicit PR.

Replace the Issue-specific bootstrap with a neutral control-plane context operation (for example `get_task_context`). It resolves submitted sources, persists the manifest, returns read source references and deployment candidates, and exposes the authorized PR set. GitHub tools must validate each URL against that persisted set and team credential routing. An LLM-supplied URL is never sufficient authorization. Keep the existing PR head-SHA pinning within each analysis attempt.

Move the common input and coverage policy into shared pure functions consumed by both the executor and API. An Issue is required to be read only when selected. PR metadata/diff/relevant-file coverage applies only to selected PRs, not to Issue-only work. Preserve Route Spec and actual-source quotation validation. Handle deletion-only, binary-only or empty changes explicitly rather than imposing an impossible positive file-count requirement; lack of a browser-testable outcome must be explained, not converted into a fabricated passing Case.

Generalize scope evidence separately from availability. Explicit user intent may come from a brief, Issue, or clear PR testing/acceptance requirements; implementation-derived behavior must remain tied to actual changes. A PR being the only input does not make every existing function or document a required regression. Replace Issue-only `issueEvidence` with neutral intent evidence for new snapshots, while reading historical fields. Localization requirements can cite explicit intent from the available input; merely changing i18n files still must not expand scope automatically. Preserve uncovered-requirement diagnostics and the existing prevention of a misleading overall pass.

Input requests retain the compatible `ISSUE`, `PULL_REQUEST`, and `DEPLOYMENT_TARGET` codes and add `TEST_INTENT`. Source codes indicate a selected source that could not be read, not a missing optional source type; the message gives allowed remedies. Retain `expectedAttemptId`, task/team validation, transactions and lease fencing. A generic input-required outcome for insufficient intent must be persisted and accepted by the API; the current gate cannot express this once all source-type prerequisites are present.

For the first release, retain the existing requirement for a resolved target before committing an executable Spec. Allow asynchronous task creation without a target, then supplement it through the existing analysis wait/resume path. Separating Spec generation from environment selection is a later improvement: it requires coordinated changes to `setDeployments`, Profile resolution and stage projection, not simply removing the target check.

## Manual Console workflow

Keep one creation form with optional Issue and PR fields, optional task title/testing brief, environment list and browser identity selection. Clearly require at least one substantive source. PR-only input must pass both HTML form validation and `taskCreateInput`; removing just `required` is insufficient. Continue supporting multiple PRs and multiple target environments.

The existing Console can continue requiring an explicit environment in the first release; HTTP/MCP/Feishu already allow asynchronous discovery. Explain that distinction instead of changing it accidentally. Reuse the current `TaskCreateRequest` request-key retention and double-submit protection, but fingerprint the normalized new contract.

Default Console and Feishu tasks to `REQUESTER`. Offer `EXPLICIT_PROFILE` and `EPHEMERAL` under existing ownership rules. Disable `ISSUE_ASSIGNEE` when no Issue is selected, and validate the same rule on the server. When removing an Issue from an existing owner-policy task, the Console exposes profile correction first; this explicitly changes the policy while preserving the active analysis wait. If the user deliberately requests owner mode but its identity cannot be resolved, wait for profile correction according to policy; never silently choose the PR author or another person's browser session. Machine-created tasks keep their existing explicit/default profile semantics because they may have no user requester.

The supplement card must display the actual problem and available remedies, not insist that Issue and PR are both mandatory. Preserve accessible labels, busy state and stale-attempt protection. Task lists should say “Spec analysis task” and show source badges/references; PR URL/repository/number should be searchable even when an Issue is also present.

## Feishu interaction

The current `extractTargetUrl` chooses the first URL other than the Issue and Linear links. Consequently a message containing `ENG-123 https://github.com/acme/shop/pull/123 https://preview.example.com` can treat the PR as the deployment. Fix this alongside PR entry support.

Parse a message once into typed Issue references, PR references, explicit environment URLs, testing brief and identity options. Share provider URL validation with Console/API adapters. PR and Issue links must be consumed as context and excluded from target candidates. Prefer explicit `--target` when present; one remaining valid URL can be the target, but multiple unlabeled URLs should produce an ambiguity request rather than selecting the first. Normalize punctuation and supported URL suffixes, and reject unsupported source links with useful feedback rather than treating them as deployment URLs.

Supported examples:

```text
@DevProof ENG-123 https://preview.example.com
@DevProof https://github.com/acme/shop/pull/123 https://preview.example.com
@DevProof ENG-123 https://github.com/acme/shop/pull/123 --target https://preview.example.com
@DevProof https://github.com/acme/shop/pull/123 --ephemeral
```

The last command may discover the deployment or wait for it; it must not ask for an Issue. PR-only `--owner` should return a specific identity-policy error and offer requester/ephemeral options. Preserve current tenant, user mapping, bot-mention and signature checks. Separate permanent syntax/validation errors from transient processing errors so an invalid command does not repeatedly enter the ten-attempt integration retry loop.

Keep `InboundIntegrationEvent -> taskExecutionId` and event-based task creation deduplication. Consider scoping new dedupe keys by provider/app/event, matching inbound uniqueness; preserve legacy key lookup during rollout so replayed events cannot create another task. A new message deliberately testing the same PR creates a new task.

Reuse the existing task card and outbox pipeline. Show the available source labels and the specific missing environment/source/intent message. Continue updating the card attached to that task; do not locate cards by Issue or PR. Preserve stale-generation delivery protection when task retries overlap notification retries.

The current card button navigates to Console; there is no native reply-to-supplement flow in the inspected implementation. The first release should retain Console supplementation. If in-chat supplementation is later added, persist root/reply/card-message-to-task associations, recognize reply versus create, carry the expected analysis attempt/generation, enforce team/user permissions and deduplicate each action. A chat ID, Issue number, or repeated PR URL cannot safely identify which task to resume.

## Result delivery, reruns and compatibility

Keep GitHub writeback optional and separate from source presence. PR-only tasks can write to a resolved primary PR under existing team configuration; Issue-only/brief-only tasks create no GitHub delivery. For multiple PRs, retain a stable explicit primary destination; do not accidentally broadcast because more sources were discovered. If broader writeback is introduced, dedupe per task/generation/destination. The current GitHub comment marker already uses task ID.

The existing completion destination comes from the generated snapshot. If reporting analysis failures before a snapshot exists becomes a requirement, use an explicitly resolved writeback destination from the manifest; never guess from a bare source label. This is separate from the required successful PR-only path.

Full task reruns retain the submitted source references and apply documented revision selection; new analysis attempts may resolve a newer PR head. Case reruns retain the frozen Spec and source content/SHA, including brief sources. Ensure source-reference remapping, report/export readers and copied contexts support the new format. Do not rewrite historical source hashes or immutable Spec snapshots.

Add `SPEC_TASK` with an additive migration and readers that understand both kinds. Replace kind checks across scheduling, deadline handling, profile resolution, account correction, retry/rerun, reporting, list filters and UI. Legacy `ISSUE_SPEC` can remain stored and be interpreted as a Spec task; deleting its enum or rebuilding historical tasks is unnecessary.

Agent Runtime currently has a required `issueRef` in its wire schema. A no-Issue lease is incompatible with old workers even if the JSON change appears small. Version and capability-gate the new lease/tool/input-request format; route source-independent work only to compatible workers. A coordinated minimum-version rollout is acceptable; a version bump without enforcing claim compatibility is not. Preserve old snapshot readers and either retain the old worker path for legacy work or drain incompatible workers before activation.

Address all three configured analysis modes. `AGENT` is the default, but `DETERMINISTIC` directly reads `context.issue` and `SHADOW` calls that generator during comparison. Adapt both paths before enabling the new contexts, or make unsupported mode rejection explicit at admission. A shadow comparison should not crash successful PR-only generation.

## Implementation sequence and acceptance

1. Define versioned neutral input/context/manifest schemas, shared source normalization and evidence policy. Add legacy adapters and a shared Spec-task predicate.
2. Implement control-plane and executor source-aware bootstrap, allowed PR set, coverage gates, source failure handling and human supplementation together. Update deterministic/shadow paths and protocol compatibility.
3. Update profile selection, source presentation, search, reruns, reports and writeback. Add the database enum/readers before enabling writers.
4. Update Console, MCP/HTTP descriptions and Feishu parsing/cards in the same feature rollout. Publish usage examples and upgrade guidance.
5. Deploy behind an activation switch or compatible-worker requirement; validate full flows before enabling PR-only creation for all producers.

Required regression scenarios:

- PR-only with Linear unconfigured proceeds through Spec, profile resolution and execution; Issue-only with no PR does not wait for one.
- Mixed sources, optional brief-only input, empty input, missing target, ambiguous deployments, explicit unreadable sources and optional discovery failures follow their distinct policies.
- Every selected PR is authorized and pinned; an arbitrary model-selected PR is rejected; a changing head cannot mix source revisions inside an attempt.
- Scope/quotation/Route Spec validation remains enforced; explicit PR-only localization requirements are representable without permitting unrelated i18n regression scope.
- Console accepts PR-only, rejects empty context, preserves retry idempotency, protects double submits, and disables invalid owner mode.
- Feishu handles PR-only, Issue+PR+target, reordered URLs, repeated links, URL suffixes, missing target, invalid owner mode, duplicate events, transient retries and permanent validation errors. A PR URL never becomes the deployment.
- Missing-input card links to the same task; stale supplementation is rejected; task retries do not produce duplicate cards/comments or replay older result state.
- Same PR plus two distinct create keys produces two tasks; retrying one key produces one task, including after input supplementation.
- Requester/explicit/ephemeral identities work without Issue; Issue-owner mode still respects existing identity and profile authorization.
- Historical Issue tasks, Direct Runs, immutable Spec readers, full reruns and Case reruns remain operable. AGENT, DETERMINISTIC and SHADOW behavior is deliberate and covered.

Validation includes API, executor, Console, contracts, protocol and domain unit suites, plus an isolated PostgreSQL lifecycle test covering PR-only, Issue-only, brief-only, shadow/deterministic generation, selected-PR authorization, SHA pinning, Case reruns, original-request idempotency after supplementation, and same-source independent tasks. GitHub/Linear/Feishu and browser execution are mocked; no external messages or real browser product checks were sent.

Apply `20260917090000_source_independent_tasks` and deploy API, Web and Agent Runtime together. New Spec claims require protocol v2.21; older Spec workers are rejected. `linear_get_issue` remains a tool alias for compatibility; new workers use `get_task_context`. See [the upgrade procedure](upgrading.md#source-independent-spec-tasks).

Console still requires an environment during creation; HTTP/MCP/Feishu may discover one or wait for input. Feishu supplementation uses the existing Console link. Empty/binary PRs do not bypass source coverage or fabricate passing Cases; clarify intent or explicitly exclude a source when no browser-testable change can be established.
