# User Browser Profiles

User Browser Profiles let a Task reuse authenticated browser state without moving cookies or a browser directory into the DevProof control plane. DevProof stores identity, authorization, state, leases, and audit records; cookies, local storage, IndexedDB, history, and browser files stay on the bound Browser Runtime host.

The default strategy remains `EPHEMERAL`, so an upgrade never starts reusing login state implicitly.

## Domain model

| Model                       | Responsibility                                       | Important constraint                                                     |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `UserExternalIdentity`      | Maps a DevProof user to Feishu and Linear identities | Provider, issuer, and stable external user ID must all match             |
| `UserBrowserProfile`        | User-owned logical Profile                           | Unique by Team, owner, environment, role, and hostname scope             |
| `BrowserProfileGrant`       | Explicit approval for a trigger source and hostname  | Console, Feishu, and issue-assignee grants are independent and revocable |
| `TaskProfileBinding`        | Auditable Task strategy and resolved Profile         | The Profile cannot change after execution begins                         |
| `BrowserProfileReservation` | FIFO exclusivity across Tasks                        | A Profile has at most one active reservation                             |
| `BrowserProfileUsage`       | Records an actual use                                | Links Task, Run, requester, hostname, trigger, and outcome               |
| `InboundIntegrationEvent`   | Durable Feishu event inbox                           | Provider, issuer, and event ID make delivery idempotent                  |

The physical `runtimeProfileKey` is opaque and never returned to Console, Feishu, MCP, or other clients.

## Creation and preparation

1. A Task selects `REQUESTER` or `ISSUE_ASSIGNEE`. If no usable state exists and policy is `WAIT_FOR_PROFILE`, the API creates a logical Profile from the target URL, environment, role, and trigger source.
2. The API generates the display name, exact hostname, verification URL, success rule, and an unguessable Runtime key.
3. The owner opens Console → Browser Identities and starts a preparation session.
4. The owner completes login, MFA, or CAPTCHA in the live remote page. Frames and input use an ephemeral channel and are not stored.
5. The API verifies the configured success rule, records approval, and changes the Profile to `READY`.
6. A later trigger source can request a separate grant without requiring another login.

State normally progresses from `UNINITIALIZED` to `PREPARING` to `READY`. Expired authentication becomes `REAUTH_REQUIRED`; an incompatible Runtime becomes `MIGRATION_REQUIRED`; a missing directory becomes `LOST`; revocation becomes `DISABLED`.

## Resolution strategies

- `EPHEMERAL`: never reads a user Profile.
- `REQUESTER`: uses the authenticated Console or Feishu requester. A machine credential has no implicit user identity.
- `ISSUE_ASSIGNEE`: matches the stable Linear workspace/organization and assignee ID. A unique, verified Team email may be used only for one-time identity backfill.
- `EXPLICIT_PROFILE`: allows a signed-in user to choose only a Profile they own.

Every persistent strategy must match the owner, Team, trigger source, target hostname, environment/role scope, grant, and `READY` state. `onUnavailable` may wait, fail, or explicitly fall back to ephemeral state; DevProof never silently downgrades.

Profile resolution does not reserve the browser. `SERIAL_PERSISTENT` retains the FIFO Task reservation and serial Cases. `ISOLATED_AUTH` reuses a verified, immutable local authentication snapshot in a separate browser/context for each Attempt; Task resolution holds no execution permit. Admission atomically acquires node capacity, a Profile concurrency permit, and compatible backend data locks. Browser closure must be verified before physical capacity is released.

## Concurrent execution

Runtime v1.13 and `BROWSER_ISOLATED_AUTH_ENABLED=true` are required. Ordinary serial login verification never starts parallel probes. To opt in, prepare or reopen the login in Console, explicitly select **Validate concurrent login** in the login window, and verify/save. The API equivalent is `POST /console/api/browser-profiles/:id/verify` with `{ "prepareIsolatedAuth": true }`; an empty body preserves serial verification. This prepares a snapshot while the Profile remains serial, so no pre-existing snapshot is needed to begin validation. Once all existing Tasks and sessions have drained, select **Independent concurrent sessions** and a limit of 1–4 in the Profile settings.

The opt-in validation probes four independent authenticated contexts. Some sites rotate server-side credentials when another context authenticates. After a probe failure, DevProof refreshes and verifies the source login again before allowing serial use. An invalid source remains `REAUTH_REQUIRED`, clears old snapshot metadata, and keeps the login window available; only a source that passes the new check may return to serial `READY`. Existing isolated Profiles must pass the probe again on renewal and cannot renew isolated execution while the flag is disabled. Authentication failure does not silently fall back to an unauthenticated session.

Case execution declarations come from explicit request policy or Console review, not generated test prose. `READ_ONLY` work may share data locks; `MUTATING` work locks its declared resource scopes; unknown work locks the backend environment exclusively. Root/collection scopes conflict with their descendants. Set `BROWSER_EXECUTION_ENVIRONMENTS_JSON` for hostname aliases backed by the same server state. Distinct users, Profiles, or Task deployment IDs do not partition those locks.

Issue requests can provide `caseExecutionPolicies` keyed by generated Case ID or one-based position. Set `casePolicyReviewRequired=true` (also available in Playground) to pause after generation and review each Case's access mode, resource scopes, and dependencies before creating its immutable Run. Existing automatic Tasks default to conservative unknown/exclusive behavior.

Snapshots include cookies, localStorage and IndexedDB. SessionStorage, device binding, single-session accounts and refresh-token rotation can make a site incompatible; use serial execution or accounts with genuinely isolated backend data in that case. A Context's changed authentication state is never merged back. Snapshots are immutable generations inside the bound Profile directory, protected by local retention, purge and live-generation pinning.

Profile authorization decides whether a Task may use login state. It does not control browser networking. Runtime-wide SSRF and private-network policy applies to top-level navigation, redirects, subresources, and WebSockets.

## Entry points

### Console

Users can prepare, reauthenticate, verify, grant, disable, and delete their own Profiles. The UI displays the logical ID, owner, site, status, and last-use time without exposing the Runtime key.

### Feishu

Encrypted event callbacks validate the raw request signature, a five-minute time window, verification token, app ID, tenant key, and mentioned bot ID. Events are stored before asynchronous processing and are idempotent by event ID.

Example messages:

```text
@DevProof ENG-123 https://preview.example.com
@DevProof ENG-123 https://preview.example.com --owner
@DevProof ENG-123 https://preview.example.com --ephemeral
```

The default is `REQUESTER`; `--owner` selects `ISSUE_ASSIGNEE`; `--ephemeral` takes precedence.

### Issue assignee

Linear GraphQL supplies the stable organization and assignee IDs. `LINEAR_WORKSPACE_ID` should be configured in production to avoid issuer ambiguity. Agent assignees and missing or ambiguous user mappings cannot own a human Browser Profile.

## 30-day Runtime cleanup

Browser Runtime owns local disk cleanup:

1. The API sends `profileRetention={kind:"USER", inactivityTtlSeconds:2592000}`.
2. Runtime writes `.devproof-user-profile.json` with the schema, kind, logical key, and `lastUsedAt`.
3. Runtime scans at startup and hourly. Only valid marked directories inactive for at least 30 days are eligible.
4. Open and opening Profiles are protected. Unmarked legacy persistent directories are not deleted automatically.
5. Cleanup atomically renames a directory to a tombstone before recursive deletion and recovers leftover tombstones after restart.
6. A durable `profile.lifecycle` event informs the API, which releases reservations and returns waiting Tasks to Profile resolution.

The API also disables expired Profiles or Profiles belonging to inactive users before requesting physical cleanup. If Runtime is offline, cleanup remains retryable and the disabled Profile cannot receive new work.

The 30-day threshold is fixed. Runtime hosts must use reliable clock synchronization.

## Security and privacy invariants

- Browser state never enters PostgreSQL, Redis, object storage, prompts, or logs.
- The Runtime key is absent from all external responses and exported logs.
- User, Team, issuer, stable external ID, hostname grant, and trigger source are checked together.
- A Profile remains affine to one Runtime and is never copied between hosts.
- Persistent Profile directories remain exclusive; isolated-auth Tasks share only an immutable local authentication snapshot and receive separate contexts.
- Disable, delete, expiry, or membership loss blocks new scheduling before physical deletion.
- Preparation and execution sessions are distinct and auditable.

## Upgrade checks

After an API and Browser Runtime upgrade, verify protocol v1.11 negotiation, Profile preparation, cross-origin SSO, global network policy, restart recovery, FIFO exclusion, manual deletion, and simulated inactivity cleanup. Older Runtimes may continue compatible ephemeral work but must not receive tasks requiring unsupported Profile capabilities.
