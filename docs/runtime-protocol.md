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

The source of truth for the currently implemented version is `RUNTIME_PROTOCOL` in [`packages/runtime-protocol/src/index.ts`](../packages/runtime-protocol/src/index.ts).

## Deployment rule

Upgrade and restart Browser Runtime whenever a required minor capability changes. Deploying API code alone does not upgrade independently installed Runtime daemons. During a rolling upgrade, route tasks that require a newer capability only to compatible nodes.
