# Direct browser access and distributed authentication

Browser Runtime 0.2.32 / protocol 1.19 adds optional direct human control and encrypted authentication snapshot distribution. The two features can be enabled independently. Existing deployments retain relay access and node-local identities until configured.

## Identity library and version ownership

The Console presents one identity library for the current user and team. Each website/environment/role retains its own Profile and permissions. Adding website B never overwrites website A. A site's snapshot can include its SSO origins; it is an authentication unit, not an arbitrary cookie-domain slice.

Only a Profile preparation session can publish a version. Verification claims a monotonically increasing Profile version and keeps the identity unavailable during preparation. Concurrent publications use that expected version; conflicting content cannot replace an existing generation. Task contexts never publish authentication changes.

With `BROWSER_ISOLATED_AUTH_ENABLED=true` and `BROWSER_AUTH_SNAPSHOT_DISTRIBUTION_ENABLED=true` on the API:

1. Prepare a login on its assigned VM. Select concurrent login validation and save.
2. Runtime verifies independent contexts, exports cookies/localStorage/IndexedDB, and encrypts the immutable snapshot using AES-256-GCM. Profile key and generation are authenticated as additional data.
3. Runtime uploads ciphertext through an authenticated, preparation-session-scoped API route. Object storage holds ciphertext; PostgreSQL holds identifiers, checksums and upload completion. Neither API nor object storage receives the encryption key or plaintext credentials. Before the first request, the preparation VM atomically persists the encrypted envelope alongside its local snapshot. Every retry, including after a restart, reuses those exact bytes. The reserved metadata row makes interrupted uploads retryable and collectible.
4. Enable independent concurrent execution in Profile settings. The scheduler can choose any compatible, domain-routed VM advertising `distributed-auth-v1`. The Profile concurrency limit applies across all nodes, not per node. The assigned Runtime remains the authoritative preparation host.
5. A destination authenticates with its own Runtime credential and an allocated execution session. The API serves only that session's pinned generation after checking team, active membership, identity status, and leases.
6. The destination decrypts into memory and starts an isolated context without network access under its STARTUP permit. Once an execution permit arrives, the first browser command must revisit the verification page in that actual context before performing its requested action. Concurrent commands share the verification result; a failed check blocks subsequent commands as well. The target does not persist a plaintext snapshot file or merge changed task credentials back.

The original persistent directory and local snapshot remain on the preparation VM. A distributed snapshot is fetched on demand for each new execution; there is no broadcast of all user credentials to idle nodes. A local source-directory expiry does not invalidate a published, still-active distributed identity. Reopening preparation on a source whose directory expired requires login again.

Profiles verified before distribution was enabled stay local until reverified. Serial identities remain pinned to their original node. Device/IP binding, sessionStorage, single-session restrictions, and refresh-token rotation may prevent cross-node use; select serial execution for those sites. Snapshot copying does not isolate shared server-side business data.

## Direct HITL and login windows

The Console still calls the API to claim/renew/release human control and complete an intervention. The API returns a VM WSS address and an Ed25519-signed ticket scoped to user, team, Runtime, session, fencing token and control generation. Tickets contain no Runtime credentials or session lease secret; ticket lifetime is at most 30 seconds and is capped by the applicable control lease.

The browser authenticates on the WSS connection's first message, not in a URL. The VM validates the ticket, allowed Web origin, active session permit and current control generation. It streams frames and accepts bounded, acknowledged input directly. Tickets are single use, renewed on the same connection, and reissued for reconnects. The VM closes expired or revoked connections. A lost control-plane connection still blocks control through the existing session permit machinery.

Only endpoints explicitly configured on the API switch to direct mode. A direct connection error never silently falls back to sending input through Railway. Unconfigured nodes retain the legacy SSE/POST relay for rolling upgrades. Browser frame capture remains periodic at 500 ms, plus input-triggered refresh; this change removes Railway transport hops but is not a video-streaming implementation.

## Read-only Run previews

Browser Runtime 0.2.33 adds the `direct-preview-v1` capability on protocol 1.19. The Run's read-only live view now requests `POST /console/api/runs/:runId/browser/connection` and negotiates the same WSS endpoint as HITL and Profile preparation. Unconfigured nodes and older nodes without this capability explicitly retain SSE relay. A selected direct connection never silently downgrades on failure.

The API checks team access, a running Run and an available online session before issuing a ticket with `access: "preview"`. These tickets do not grant human control. Runtime accepts them for an OPEN or HUMAN_CONTROL session only while its execution permit and control generation remain valid. It rejects input on preview sockets and refuses changes of access scope during renewal. Multiple viewers can watch concurrently without replacing a human controller. Preview tickets last at most 30 seconds and are renewed independently of any previous human-control lease; permission changes stop further ticket issuance, while session fencing and permit revocation invalidate active access at Runtime.

Existing control tickets omit `access` for compatibility with older direct-control nodes. API and Web can roll out before Runtime: direct previews begin only after the upgraded node reconnects and advertises the capability. A Runtime downgrade clears the stored capability on reconnect.

Deploy API/Web and upgrade each participating Browser Runtime to 0.2.33. End active browser sessions before restarting a Runtime. No new key pair or endpoint is needed when HITL direct access is already configured. A node still needs a browser-reachable WSS endpoint and a trusted TLS certificate; this change does not provide NAT traversal or a network tunnel.

## Configuration and rollout

First apply migrations with `pnpm prisma:deploy`, deploy API and Web, and upgrade participating Browser Runtimes to 0.2.32. Existing files and Profiles need no destructive migration.

For direct access:

- Generate an Ed25519 key pair. Configure its private PKCS8 PEM as API-only `BROWSER_DIRECT_SIGNING_KEY`. PEM values can contain literal `\n` escapes.
- Put its public SPKI PEM in `DEVPROOF_DIRECT_CONTROL_PUBLIC_KEY` on each VM.
- Set VM `DEVPROOF_DIRECT_CONTROL_PORT=9444`, `DEVPROOF_DIRECT_CONTROL_HOST=127.0.0.1`, and `DEVPROOF_DIRECT_CONTROL_ORIGINS=https://your-console.example`. Multiple exact origins are comma-separated; wildcards are rejected.
- Expose `/browser-control` through a VM-local TLS reverse proxy with a trusted certificate. Restrict proxy forwarding to that path; do not expose Chromium/CDP or the daemon credential. The listener itself is HTTP and should remain loopback-bound.
- Configure API `BROWSER_DIRECT_ENDPOINTS_JSON={"runtime-uuid":"wss://vm.example/browser-control"}` only after the endpoint is reachable from user browsers. NAT-only machines require a reachable VPN or separate tunnel; no WebRTC/TURN path is implemented.
- The Linux installer already loads `~/.config/devproof/browser-runtime.env`. Restart its systemd user service after changing VM settings. Keep API/VM clocks synchronized.

For an external load balancer that connects directly to the VM, bind
`DEVPROOF_DIRECT_CONTROL_HOST` to the VM's private IP instead of loopback, allow
9444 only from that balancer, and forward HTTP/WebSocket (not HTTPS) to 9444.
An ordinary HTTP request to this listener returns 404, including health checks;
configure a compatible check or a separate proxy health endpoint.

Runtime 0.2.34's release installer adds `--direct-config FILE` for validated,
rollback-protected first-time configuration. See the [installer example](../apps/browser-runtime/README.md#direct-control-and-distributed-login-state).
The JSON contains only the public key, listener settings, Console origins and
public WSS URL. API signing and endpoint activation remain control-plane
configuration; no new Runtime registration fields are needed. Once configured,
the usual installation command preserves these settings on later upgrades.

For snapshot distribution:

- Set a new random 32-byte base64 `DEVPROOF_AUTH_SNAPSHOT_KEY` on the trusted participating VMs. This is separate from the API credential cipher key. Do not install it on API/Web. All participating VMs currently share one key; per-node envelope keys and live key rotation are not implemented.
- Enable API `BROWSER_AUTH_SNAPSHOT_DISTRIBUTION_ENABLED=true` and `BROWSER_ISOLATED_AUTH_ENABLED=true` after all target VMs have the key. A Runtime advertises distribution support only when configured with the key.
- Reverify selected identities, then enable isolated execution. Validate your actual sites on at least two real VM egress IPs, including reauthentication and token refresh.
- To rotate the snapshot key, drain executions, disable distribution, change VM keys together, reverify affected identities and republish generations, then reenable distribution. Old ciphertext is not decryptable with a new key.

Disable/expiry/membership removal immediately prevents new downloads and admission. Explicit Profile deletion also deletes encrypted objects after sessions close. The hourly collector removes obsolete/orphaned generations after a one-hour grace period, preserves current retained identities (including manually disabled identities), and protects unclosed execution generations. Deletion first commits a durable tombstone, then deletes the object. A late upload performs compensating deletion; the hourly collector also repeats deletion of tombstoned keys, covering process crashes and storage timeouts. Tombstone metadata (identifiers, key and checksum, without credentials) is retained indefinitely so late writes cannot become untracked. Storage failures are retried. The existing 30-day inactivity policy remains authoritative.

Rollback: remove a VM from the direct endpoint map for new page sessions, reload the Console, then stop its direct listener. Set distribution false to restore source-node scheduling for new tasks. Existing pinned sessions must drain; neither rollback overwrites a running browser directory. If the original source directory has expired, reauthenticate before resuming local-only execution.

## Verification

Tests cover ticket signatures/audiences/expiry/replay, control revocation, direct input acknowledgements, explicit legacy transport and no implicit downgrade, ciphertext tampering and version substitution, publication conflicts, session-bound downloads, cleanup pinning, real Chromium login transfer between separate browser processes, and PostgreSQL admission across two nodes sharing one global identity capacity. Additional regressions exercise STARTUP-to-AGENT permission transfer in real Chromium, identical encrypted uploads after failure/restart, and deletion racing a delayed upload with failed compensation and subsequent collector recovery.

These tests do not establish compatibility with a particular production website or public VM TLS endpoint. Those checks require the deployed hostnames, credentials and network conditions.
