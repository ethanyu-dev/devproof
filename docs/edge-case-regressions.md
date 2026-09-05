# Edge-case regression coverage

This change covers the twelve cases identified in the project audit. No database migration is required.

| Boundary                                                                        | Expected behavior                                                                                                                      | Regression coverage                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Reopen a task after releasing its serial Profile reservation                    | Revalidate authorization, requeue behind existing waiters, and fence stale releases with the Task row lock                             | `edge-cases.integration.ts`              |
| Project a parent after its deadline when all planned children completed on time | Use child completion timestamps and require the complete case/deployment matrix                                                        | `task-execution.service.spec.ts`         |
| Expire a legacy/runtime session with live RunEvidence references                | Preserve the runtime artifact metadata and object until the evidence owner removes the reference                                       | Retention unit and database tests        |
| Encode an 8 MiB video plus screenshot for reliable WebSocket delivery           | Budget the entire JSON/base64 frame, allow up to the existing 16 MiB protocol limit, and retain the result until ACK                   | `runtime-outbox.spec.ts`                 |
| Complete a rerun with a different verdict                                       | Deduplicate by task generation and suppress old completion notifications                                                               | Notification unit and database tests     |
| An expired notification worker returns after a newer delivery                   | Renew during delivery, abort on lost ownership, and fence terminal updates/events by lease token and expiry                            | `edge-cases.integration.ts`              |
| Upload objects before losing the command-result CAS or crashing                 | Create durable cleanup intent before upload and consume it atomically with artifact publication                                        | `edge-cases.integration.ts`              |
| Force-push a PR between analysis tools or during diff pagination                | Pin the attempt's source revision, validate mutable diff pages, and reject mixed revisions before persistence/Spec publication         | GitHub unit and source concurrency tests |
| Read a PR with more than 300 changed files                                      | Serve 20-file tool pages through page 150; report total, truncation and omitted/trimmed patches explicitly                             | GitHub client and Spec tool tests        |
| Retain a quarantined execution-resource lease                                   | Exclude the session from deletion; a failed retention item/stage must not suppress other cleanup stages                                | Retention unit and database tests        |
| Poll an idle Agent for a long time                                              | Remove each delay's abort listener when its timer completes or is cancelled                                                            | `worker-delay.spec.ts`                   |
| Open screenshots/videos after a terminal page has remained idle                 | Return a stable authenticated download route that opens a fresh storage stream for each access, including subsequent video byte ranges | `execution-run.service.spec.ts`          |

## Operational details

- Upload cleanup intents become eligible after one hour. Upload requests have a 60-second abort budget. Publication refuses an expired or already-claimed intent; retention claims recheck the due time under the same storage-key advisory lock. This recovers abandoned writes without deleting a successfully published artifact.
- Runtime data retention does not impose a new lifetime on v2 RunEvidence. Sessions/artifacts remain while referenced. Quarantined resource leases still require verified closure/reconciliation before they can be removed.
- The runtime outbox has a 64 MiB total budget and a 16 MiB per-frame limit. If a bundle exceeds the frame limit, it keeps video preferentially, drops excess artifacts and records an `artifactDeliveryWarning` in the command result. The terminal acknowledgement is retained.
- Notifications remain at-least-once external deliveries. Per-task PostgreSQL advisory locks order card/comment writes across replicas, while lease checks protect database state. A delivery that was already accepted remotely immediately before a process crash may still be retried.
- PR source collection remains bounded by 2 MB per attempt and 250 KB per source. Raising the source-count cap allows large file lists without removing the byte budget. The GitHub file list is bounded at 3,000 entries and explicitly reports truncation beyond that boundary.
- API, Agent Runtime and Browser Runtime changes should ship together. Existing persisted rows remain readable; no data backfill is performed.

## Verification

Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm format:check`. The CI workflow also runs `pnpm --filter @devproof/api test:concurrency`, which launches a disposable PostgreSQL 17 container, applies every migration and executes the real database race/retention tests. The launcher refuses an arbitrary database URL.
