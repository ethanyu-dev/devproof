# Upgrading DevProof

DevProof keeps its complete Prisma migration chain so an existing installation can upgrade without rebuilding its database.

## Before upgrading

1. Read the release notes for database, environment, API, and Runtime changes.
2. Back up PostgreSQL and object storage, and test restore procedures.
3. Confirm no migration is currently running and the database session timezone is UTC.
4. Record deployed API, Agent Runtime, Browser Runtime, and negotiated protocol versions.
5. Drain or finish long-running browser sessions when the release requires a Browser Runtime restart.

## Deployment order

For the feature-retirement release, use the coordinated shutdown below before applying migrations. For additive releases:

1. Deploy the database migrations with `pnpm prisma:deploy`.
2. Deploy API and verify `/live`, `/ready`, and worker health.
3. Deploy Web and verify `/health` and authenticated Console proxy routes.
4. Roll Agent Runtime workers and confirm claims and heartbeats recover.
5. Upgrade each Browser Runtime host with the release installer. It rejects active sessions unless `--force-active` is explicitly supplied:

       curl -4 -fsSL https://github.com/ethanyu-dev/devproof/releases/latest/download/install.sh | bash

6. Confirm the expected Runtime protocol is negotiated before routing tasks that require new capabilities.

Never use `pnpm prisma:migrate` in production; it is for creating development migrations. Do not edit, delete, reorder, or squash a migration that may already have been applied.

Each standalone Agent Runtime uses a pool-specific credential. Set
`DEVPROOF_AGENT_RUNTIME_POOL` to `SPEC_ANALYSIS` or `BROWSER_EXECUTION`
to assert the binding explicitly; a mismatched declaration is rejected.

## Removing premature features

The 2026-09-07 release removes Playground, automatic post-run optimization and
its dedicated Runtime, plus unreachable legacy execution writers. Task creation
continues through HTTP/MCP. Existing Task/Run details, manual log export,
completion notifications, current human intervention and read-only legacy records
remain available. Old Playground/analysis endpoints return 404; retired Runtime
credentials are rejected instead of being reassigned to another pool.

This is a coordinated upgrade, not a rolling schema change. Migration
`20260907193000_retire_post_run_analysis` removes analysis tables and renames
`task_executions.post_run_analysis_generation` to `execution_generation`.
Old API instances cannot run against the contracted schema. The counter values
and existing notification payloads/deduplication keys are preserved. Manual log
exports keep `devproof.task-logs.v2`; the embedded Task counter now uses the
generic name `executionGeneration`.

1. Inventory the actual service's credential-bound pool, active analysis leases,
   both retained Runtime pools, and active Tasks. Save the deployed revisions.
2. On the old API, set `POST_RUN_ANALYSIS_ENABLED=false`, stop the analysis
   Runtime, and drain active main-flow tasks. Stop all old API/Worker replicas
   before migration, including their Retention Workers. Wait for analysis leases
   to expire; the migration aborts atomically if a live RUNNING lease remains.
3. Back up PostgreSQL and verify the backup before deleting analysis rows.
   Include `post_run_analysis_jobs`, `post_run_analysis_events`,
   `analysis_findings` and `improvement_work_items`. Preserve any reports
   required for archive, together with their analysis-only objects, outside the
   live bucket's cleanup lifecycle. Retain task/execution evidence normally.
4. Deploy the new API with the migration, then Web and the two Agent Runtime
   pools. Railway API pre-deploy runs `pnpm prisma:deploy`; ensure old replicas
   have stopped before triggering it. The migration transfers all four dedicated
   object-key locations (input, capture, capture evidence and manifest structured
   evidence) to `object_storage_deletion_tasks` with deduplication, preserving
   existing queue leases/retry counts. It then drops only the four analysis
   tables and their exclusive enums, revokes third-pool credentials, deletes
   third-pool model settings and renames the counter without resetting it.
5. Delete the retired deployment by verified service ID. Remove obsolete
   `POST_RUN_ANALYSIS_*` and `DEVPROOF_POST_RUN_ANALYSIS_*` variables. Keep
   `apps/agent-runtime`, its Dockerfile and `railway.agent-runtime.json`, which
   are shared by the two retained pools. The database enum label is retained only
   for revoked credential history; it is not a supported API pool.
6. Verify API readiness, both pool registrations, a Direct Task and an Issue
   Task, cancellation/resume, notification fencing, manual log export, historical
   record access and object cleanup. Confirm no analysis requests or queries
   remain. No Browser Runtime restart is required for this removal alone.

After contraction, rolling back the old API requires restoring the removed
schema/data and the old column name first. An image-only rollback is insufficient.
Keep the database and archived-object backups until this rollback window closes.

The migration regression test requires `psql` and an isolated local database
matching the concurrency launcher's name/user guard. It creates and drops its
own temporary schema, applies the complete old migration chain, seeds nonempty
history, checks rollback with a live lease, then verifies contraction and retained
Task/notification/model/credential data:

`DEVPROOF_CONCURRENCY_TEST_DATABASE_URL=<disposable-local-url> node apps/api/scripts/test-analysis-retirement.mjs`

## Concurrency and recovery upgrade

Current admission defaults to parallel business access (`BROWSER_EXECUTION_DATA_LOCKS_ENABLED=false`, also the unset default). Update all API replicas consistently. Existing normal and quarantined business-data leases stop blocking other executions without deleting recovery evidence or claiming that an unknown write was resolved. New executions do not acquire business-data leases or materialize recovery guards in this mode. Runtime slots, persistent Profile exclusion, identity concurrency limits, explicit dependencies, and closure proof remain enforced. The failed execution itself still requires its own recovery decision.

The serialized business-access behavior described below is opt-in via `BROWSER_EXECUTION_DATA_LOCKS_ENABLED=true`. Before re-enabling it, drain concurrent executions across all replicas; sessions admitted without resource leases are treated as legacy holders in serialized mode.

Apply `20260904103000_runtime_concurrency_recovery` with the existing migration chain. It adds nullable/version-compatible scheduling, ownership and execution-budget fields, Profile isolation settings, and backend resource leases. Keep `BROWSER_ISOLATED_AUTH_ENABLED=false` while updating API/Web, Agent Runtime protocol v2.10, and Browser Runtime 0.2.17 / protocol v1.13. Drain old sessions before restarting Runtime daemons; expired/LOST browsers must be reconciled, not treated as free slots.

After compatible daemons reconnect, set the trusted backend alias registry (`BROWSER_EXECUTION_ENVIRONMENTS_JSON`), enable the isolation feature, and prepare/verify the pilot Profile with the explicit parallel-authentication preparation option. Ordinary serial verification does not run cloned authentication probes. The owner then selects isolated execution and its concurrency limit in Console. Use explicitly reviewed independent readers for the four-slot smoke test. Keep existing nonterminal Tasks on their original mode and deadline policy. Old/direct execution paths participate conservatively in the same business locks.

The same additive migration includes `BrowserExecution.startupRecoveryCount` and `BrowserRuntimeSession.controlGeneration`. An expired, never-claimed startup can be admitted again once after verified closure, preserving its Run budget. Console control changes use their own generation while retaining the running Agent epoch. Update API and Browser Runtime together before enabling the new concurrency flow.

All API replicas must use the same backend alias registry. Drain affected executions before changing aliases, since existing leases retain the namespace under which they were acquired.

The Console Runtime page lists writes whose result is unknown. Operators must verify browser closure and record the observed backend state before releasing those data locks. This action does not replay the interrupted write. Closing a browser or expiring its lease alone is insufficient to resolve a write outcome.

For rollback, stop isolated admission with the feature flag, drain current sessions, and return idle Profiles to serial mode. Keep additive schema changes and any unresolved quarantine records. Do not roll a daemon backward while it still owns sessions requiring v1.13.

Run `node apps/api/scripts/test-execution-concurrency.mjs` for disposable PostgreSQL integration tests. The launcher binds only loopback, applies the complete migration chain to a randomly named test database, and removes its own container on completion; it does not read production environment files.

## Spec lease recovery and verification convergence

Deploy API before rolling Agent Runtime workers to protocol v2.11. This update
adds optional server-relative lease timing to Spec claims; existing workers can
still claim during the rollout. No database migration or Browser Runtime upgrade
is required for this change alone.

Expired Spec leases now fail and fence the old Attempt. Recovery creates a new
Attempt and consumes the existing `analysisMaxAttempts` budget; it never restarts
the old Attempt. Exhaustion or the parent deadline ends analysis through the
normal Task coordinator. Agent Runtime uses bounded, single-flight renewal for
Spec work and stops using a lost lease.

Browser verification stops sustained repetition and text-only loops. At a
stagnation limit or the deadline's finalization window, executed verifications
retain recorded results and mark unverified criteria `INCONCLUSIVE`. A task that
has issued no browser commands finishes as `NOT_RUN`, with the reason and count
of unverified criteria. These outcomes do not retry the same stalled verification.

Validate the rollout with one Spec lease interruption, a repeated-browser-action
fixture, and a verification that reaches its finalization window before recording
any criterion. See [Observability](observability.md#runtime-convergence-events)
for the events that distinguish these paths.

## Legacy compatibility

`POST /v2/tasks` is the current entry point. The repository retains:

- the full historical database migration chain;
- `POST /v2/runs` as a Direct Task compatibility wrapper;
- read-only legacy specification and verification records required during retention and drain-down.

Upgrade migrations may rename retired provider-specific enum values to generic extension points and normalize frozen JSON snapshots. Applied migration files themselves remain unchanged so Prisma checksums stay valid.

These surfaces must not receive new feature development. A future contract migration may remove them only after operators have verified that no active legacy records remain and that retention requirements permit deletion.

## Verification

After deployment:

- create one Direct Task and one Issue Task;
- confirm all enabled workers have recent successful heartbeats;
- run one Browser task and inspect its screenshots and WebM video;
- exercise cancellation and one human-intervention resume;
- inspect metrics for migration, protocol, notification, and cleanup errors;
- confirm no secrets or full page bodies appear in logs or Run-event previews.

See [Observability and operations](observability.md) for the full post-deployment checklist and alert runbooks.

## Moving to a new repository

Repository history and database history solve different problems. A new public Git repository may start from one clean source snapshot while still retaining all Prisma migration files needed by deployed databases.

Prepare the snapshot only from a reviewed commit. Do not copy the working directory because it may include `.env`, logs, build output, browser state, or release archives. Do not use `git archive HEAD` until all intended README, proxy, and documentation changes are committed, because uncommitted files are excluded.

Recommended sequence:

1. Finish and verify a private preparation commit.
2. Run a full secret scan and dependency/license review.
3. Export the reviewed commit with `git archive` into a new empty directory.
4. Initialize a new `main` branch and create one signed initial public commit with a public or noreply author email.
5. Add the new remote and push only `main`.
6. Create new tags that match the versions currently in source; do not copy stale tags or old feature branches.
7. Keep the old repository read-only as a private archive.

Rewriting the old repository in place is not required and risks losing the private audit trail.
