# Upgrading DevProof

DevProof keeps its complete Prisma migration chain so an existing installation can upgrade without rebuilding its database.

## Before upgrading

1. Read the release notes for database, environment, API, and Runtime changes.
2. Back up PostgreSQL and object storage, and test restore procedures.
3. Confirm no migration is currently running and the database session timezone is UTC.
4. Record deployed API, Agent Runtime, Browser Runtime, and negotiated protocol versions.
5. Drain or finish long-running browser sessions when the release requires a Browser Runtime restart.

## Deployment order

1. Deploy the database migrations with `pnpm prisma:deploy`.
2. Deploy API and verify `/live`, `/ready`, and worker health.
3. Deploy Web and verify `/health` and authenticated Console proxy routes.
4. Roll Agent Runtime workers and confirm claims and heartbeats recover.
5. Upgrade each Browser Runtime host with the release installer. It rejects active sessions unless `--force-active` is explicitly supplied:

       curl -4 -fsSL https://github.com/ethanyu-dev/devproof/releases/latest/download/install.sh | bash

6. Confirm the expected Runtime protocol is negotiated before routing tasks that require new capabilities.

Never use `pnpm prisma:migrate` in production; it is for creating development migrations. Do not edit, delete, reorder, or squash a migration that may already have been applied.

For the Agent Runtime pool-isolation migration, the database deployment clones
the previous team-wide model order into the `SPEC_ANALYSIS`,
`BROWSER_EXECUTION`, and `POST_RUN_ANALYSIS` pools. Review the three lists in
Console after deployment and remove models that a pool should not use. Set
`DEVPROOF_AGENT_RUNTIME_POOL` on each standalone Agent Runtime to make its
credential-bound pool explicit. During a rolling upgrade the variable may be
omitted: the Runtime binds to the single pool returned for its credential on
first registration. A mismatched declaration is rejected.

## Concurrency and recovery upgrade

Apply `20260904103000_runtime_concurrency_recovery` with the existing migration chain. It adds nullable/version-compatible scheduling, ownership and execution-budget fields, Profile isolation settings, and backend resource leases. Keep `BROWSER_ISOLATED_AUTH_ENABLED=false` while updating API/Web, Agent Runtime protocol v2.10, and Browser Runtime 0.2.17 / protocol v1.13. Drain old sessions before restarting Runtime daemons; expired/LOST browsers must be reconciled, not treated as free slots.

After compatible daemons reconnect, set the trusted backend alias registry (`BROWSER_EXECUTION_ENVIRONMENTS_JSON`), enable the isolation feature, and prepare/verify the pilot Profile with the explicit parallel-authentication preparation option. Ordinary serial verification does not run cloned authentication probes. The owner then selects isolated execution and its concurrency limit in Console. Use explicitly reviewed independent readers for the four-slot smoke test. Keep existing nonterminal Tasks on their original mode and deadline policy. Old/direct execution paths participate conservatively in the same business locks.

The same additive migration includes `BrowserExecution.startupRecoveryCount` and `BrowserRuntimeSession.controlGeneration`. An expired, never-claimed startup can be admitted again once after verified closure, preserving its Run budget. Console control changes use their own generation while retaining the running Agent epoch. Update API and Browser Runtime together before enabling the new concurrency flow.

All API replicas must use the same backend alias registry. Drain affected executions before changing aliases, since existing leases retain the namespace under which they were acquired.

The Console Runtime page lists writes whose result is unknown. Operators must verify browser closure and record the observed backend state before releasing those data locks. This action does not replay the interrupted write. Closing a browser or expiring its lease alone is insufficient to resolve a write outcome.

For rollback, stop isolated admission with the feature flag, drain current sessions, and return idle Profiles to serial mode. Keep additive schema changes and any unresolved quarantine records. Do not roll a daemon backward while it still owns sessions requiring v1.13.

Run `node apps/api/scripts/test-execution-concurrency.mjs` for disposable PostgreSQL integration tests. The launcher binds only loopback, applies the complete migration chain to a randomly named test database, and removes its own container on completion; it does not read production environment files.

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
