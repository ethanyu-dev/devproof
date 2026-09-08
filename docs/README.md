# DevProof documentation

English is the canonical language for project documentation.

- [Architecture](architecture.md): system boundaries, state ownership, and execution invariants
- [Upgrading](upgrading.md): database-safe upgrades and clean repository transfer
- [Observability and operations](observability.md): health, metrics, logs, retention, and runbooks
- [Redundant feature removal plan](redundant-feature-removal-plan.md): implementation and retirement of Playground, post-run analysis, its Runtime pool, and unreachable legacy code
- [Concise Agent tool corrections](agent-tool-error-design.md): command-specific validation, bounded error feedback, and regression coverage
- [Bounded browser working context](agent-context-budget-design.md): observation paging, complete-turn compaction, request budgets, and rollback
- [Browser Runtime protocol](runtime-protocol.md): compatibility rules and capability milestones
- [User Browser Profiles](user-browser-profiles.md): identity, authorization, retention, and privacy
- [Runtime concurrency and recovery proposal](runtime-concurrency-recovery-design.md): isolated authenticated sessions, bounded lease recovery, and explainable scheduling
- [Test data model](test-data-model.md): immutable definitions, snapshots, traces, and artifacts
- [Versioning](versioning.md): platform, Browser Runtime, and wire-protocol releases

Package-specific details live next to their code, including [`@devproof/runtime-protocol`](../packages/runtime-protocol/README.md) and [`@devproof/browser-runtime`](../apps/browser-runtime/README.md).
