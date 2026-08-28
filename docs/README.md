# DevProof documentation

English is the canonical language for project documentation.

- [Architecture](architecture.md): system boundaries, state ownership, and execution invariants
- [Upgrading](upgrading.md): database-safe upgrades and clean repository transfer
- [Observability and operations](observability.md): health, metrics, logs, retention, and runbooks
- [Post-run optimization analysis](post-run-analysis.md): terminal log capture, Agent analysis, findings, and generated work items
- [Browser Runtime protocol](runtime-protocol.md): compatibility rules and capability milestones
- [User Browser Profiles](user-browser-profiles.md): identity, authorization, retention, and privacy
- [Test data model](test-data-model.md): immutable definitions, snapshots, traces, and artifacts
- [Versioning](versioning.md): platform, Browser Runtime, and wire-protocol releases

Package-specific details live next to their code, including [`@devproof/runtime-protocol`](../packages/runtime-protocol/README.md) and [`@devproof/browser-runtime`](../apps/browser-runtime/README.md).
