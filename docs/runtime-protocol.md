# Browser Runtime protocol

`@devproof/runtime-protocol` is the versioned wire contract between Runtime Gateway in the API and independently deployed Browser Runtime processes.

The package README is the canonical field-level changelog: [`packages/runtime-protocol/README.md`](../packages/runtime-protocol/README.md).

## Compatibility

- A major-version mismatch is rejected.
- With the same major, both sides negotiate the lower supported minor.
- A new optional field or capability increments the minor version.
- Removing a field or changing existing semantics increments the major version.
- Commands declare their minimum protocol minor; an older connected Runtime may still reconcile or close supported sessions while rejecting newer commands with `PROTOCOL_UNSUPPORTED`.

The npm major of `@devproof/runtime-protocol` follows the wire-protocol major. Browser Runtime has its own release version and is compatible based on protocol negotiation, not matching application version numbers.

The separate Agent protocol is currently v2.26. It carries Spec source grounding,
diagnostic finalization checkpoints, locator recovery exhaustion reasons, and
optional meaningful tool-progress telemetry for adaptive deadlines, and
per-object observation targets and delivered quotations for criterion results,
negotiated Spec generation using validated check references, and versioned
business account subject declarations and observed account requests;
see its [changelog](../packages/agent-runtime-protocol/README.md).

## Object observations and write audit

The [Browser observation V2](browser-observation-v2.md) implementation supports
structured captures, phase proofs, action observation, optional deltas, and
bounded form sequences behind negotiated capabilities. Browser protocol 1.20
raises the structured capture budget to 2 MiB, 8000 nodes and 500 regions and
reports bounded capture diagnostics. The API and Agent must be upgraded before
a Runtime emits the larger captures; model context budgets remain unchanged.

Browser protocol 1.21 adds cumulative HTTP write audit metadata to session
closure results. Live closure seals the audit with the durable closure record;
retries and daemon restarts replay the same evidence. The API reassesses data
leases after the result is persisted. Only a verified, isolated, complete audit
with no potential writes can establish `NO_WRITE_VERIFIED`; interrupted sessions
without an audit and unknown writes retain recovery guards.

Object observations and shared business-data locks are enabled by default.
Unknown resource scopes serialize at environment level. Operators can explicitly
configure `BROWSER_OBSERVATION_V2_ENABLED=false` or
`BROWSER_EXECUTION_DATA_LOCKS_ENABLED=false`; disabling data locks allows shared
business state to be modified concurrently. Account coordination remains active.

## Current capability milestones

| Protocol | Capability                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------- |
| v1.2     | Strict browser commands, observable evidence, SSRF-aware navigation, and deterministic network faults |
| v1.6     | Idempotent `profile.purge` using atomic tombstones                                                    |
| v1.7     | Open Shadow DOM snapshots and bounded, redacted JSON network evidence                                 |
| v1.8     | Fixed 30-day user Profile retention and durable lifecycle events                                      |
| v1.9     | Runtime-wide network policy replaces Profile-level hostname enforcement                               |
| v1.10    | Per-action screenshots and a composed WebM action video                                               |
| v1.11    | Unique-visible locator selection and structured ambiguity recovery diagnostics                        |
| v1.12    | Acknowledged, bounded video-finalization failure diagnostics                                          |
| v1.13    | Local authenticated snapshots, isolated contexts, owner-bound execution permits, and verified closure |
| v1.16    | DOM observations and screenshot-bound visual interaction (`dom-vision-v1`)                            |
| v1.17    | Measured container scroll feedback and focused observations (`scroll-feedback-v1`)                    |
| v1.18    | Optional host CPU / memory telemetry on existing heartbeats                                           |

The source of truth for the currently implemented version is `RUNTIME_PROTOCOL` in [`packages/runtime-protocol/src/index.ts`](../packages/runtime-protocol/src/index.ts).

## Deployment rule

Upgrade and restart Browser Runtime whenever a required minor capability changes. Deploying API code alone does not upgrade independently installed Runtime daemons. During a rolling upgrade, route tasks that require a newer capability only to compatible nodes.

Agent v2.22 adds complete per-model-call context archives and public `stepIntent` action plans. See [Runtime step context history](runtime-step-context.md) for storage, migration, attempt identity and historical-preview compatibility.

Agent v2.23 adds concise business checks, runtime subject binding and criterion-local evidence correction. See [Business Spec and runtime binding](business-spec.md). Observation payloads remain v2; existing Specs retain their original contracts.

Agent v2.24 adds `attempt-evidence-catalog-v1` for complete attempt evidence catalogs and `typed-checks-v1` for explicit UI state properties and structured network assertions. Checkpoint criteria are persisted independently of final cleanup. See [the first four runtime reliability changes](runtime-reliability-first-four.md) for account replacement, record references, compatibility and regression coverage.

Agent v2.26 adds opt-in `DISPLAY_TEXT` matching and named-resource ownership
receipts. Tasks carrying these fields require compatible workers; existing
stored Specs retain their matching semantics and remain readable. New generated
Specs are limited to 10 Cases and five acceptance criteria per Case in both the
Agent and API submission paths. Oversized output is rejected for correction,
not truncated. See the [Agent changelog](../packages/agent-runtime-protocol/README.md).
