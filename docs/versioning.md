# Versioning

DevProof has three independent version surfaces.

## Platform

- Stable tags use `vMAJOR.MINOR.PATCH`.
- Release candidates use `rc-vMAJOR.MINOR.PATCH-N` and are validated in a staging environment.
- Development builds come from branches and must not be connected to production Runtimes or data.

## Browser Runtime

Browser Runtime releases use `runtime-vMAJOR.MINOR.PATCH`. API records the installed Runtime version for operations, but compatibility is determined by the negotiated Runtime protocol.

The tag must exactly match `apps/browser-runtime/package.json`. The release workflow builds and tests the package, uploads the tarball, and creates a GitHub release.

## Runtime protocol

The wire contract uses a separate major/minor version:

- A major mismatch is rejected.
- With the same major, the lower minor is negotiated.
- New optional fields or capabilities increment the minor.
- Field removal or semantic changes increment the major.

The npm major of `@devproof/runtime-protocol` follows the wire-protocol major. See [Browser Runtime protocol](runtime-protocol.md) for capability milestones.

## Release consistency

Before publishing, update package versions, documentation, and compatibility tests together. Do not infer feature availability from a Runtime package version alone; use protocol negotiation and capability checks.
