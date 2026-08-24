# Contributing to DevProof

Thank you for helping improve DevProof. Bug reports, documentation fixes, tests, and focused feature proposals are welcome.

## Before opening a change

- Search existing issues and pull requests.
- Open an issue before a large feature or architectural change so scope and compatibility can be discussed.
- Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.
- Keep pull requests focused and avoid unrelated formatting or dependency churn.

English is the canonical language for code, commit messages, and project documentation. Translations may follow the canonical document.

## Development setup

Requirements are Node.js 24, pnpm 10, and Docker.

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm prisma:deploy
pnpm dev
```

Use only local or disposable credentials and test data. Never commit `.env`, Runtime credentials, Browser Profiles, logs, screenshots containing private data, or release archives.

## Quality checks

Run the checks relevant to your change before opening a pull request. The complete CI sequence is:

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Add or update tests for behavior changes. Documentation-only changes should still pass formatting and link checks.

## Database changes

- Use `pnpm prisma:migrate` only to create a new development migration.
- Never edit, delete, reorder, or squash a migration that may have been applied.
- Prefer expand/backfill/contract changes so existing installations can upgrade without downtime or data loss.
- Use `pnpm prisma:deploy` to apply committed migrations in CI and production.
- Explain data backfills, rollback limits, and compatibility windows in the pull request.

## Runtime protocol changes

Browser Runtime is released independently from the API. New optional fields and capabilities require a protocol minor increment. Removed fields or semantic changes require a major increment. Add compatibility tests and update both [the protocol overview](docs/runtime-protocol.md) and [the package changelog](packages/runtime-protocol/README.md).

## Pull requests

A good pull request includes:

- a concise problem statement and the intended behavior;
- compatibility and security impact;
- tests or a reason tests are not needed;
- screenshots for visible UI changes;
- migration and deployment notes when applicable.

Maintainers may ask for a smaller change when a proposal mixes independent concerns or makes review difficult.
