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
5. Roll Browser Runtime hosts. The deployment script rejects active sessions unless `--force-active` is explicitly supplied.
6. Confirm the expected Runtime protocol is negotiated before routing tasks that require new capabilities.

Never use `pnpm prisma:migrate` in production; it is for creating development migrations. Do not edit, delete, reorder, or squash a migration that may already have been applied.

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
