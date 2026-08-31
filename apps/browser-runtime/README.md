# @devproof/browser-runtime

Browser Runtime is DevProof's independently deployable Playwright execution host. It opens only outbound WebSocket connections. Long-lived credentials and persistent Browser Profiles remain on the Runtime machine.

## Install

Install or upgrade the latest release directly on a Linux Runtime host. A
repository checkout and preinstalled Node.js are not required:

```bash
curl -4 -fsSL https://github.com/ethanyu-dev/devproof/releases/latest/download/install.sh | bash
```

The bootstrap verifies the release checksum, installs Node.js 24 and Chromium
when needed, and configures `devproof-browser-runtime.service` as a systemd user
service. The first installation leaves the service stopped until pairing.

Maintainers can still install a locally built release tarball with:

```bash
npm install --global ./devproof-browser-runtime-<version>.tgz
devproof-browser-runtime install
```

The install command downloads the Chromium build pinned by Playwright. Browser Runtime launches the full `chromium` channel and does not require a separate headless-shell download.

## Pair and start

After the installer finishes, generate a one-time pairing command in Console →
Access Configuration → Browser Execution Nodes and run it on the same host. The
generated command uses the following form and starts the installed service after
pairing:

```bash
$HOME/.local/bin/devproof-browser-runtime pair \
  --api https://devproof.example.com \
  --token TOKEN && \
  systemctl --user restart devproof-browser-runtime.service
```

The default state directory is `~/.devproof-browser-runtime`. Supported environment variables include:

- `DEVPROOF_RUNTIME_HOME`: credential and Profile root directory.
- `DEVPROOF_RUNTIME_NAME`: display name shown in Console.
- `DEVPROOF_INSTANCE_KEY`: stable unique identifier for this installation.
- `DEVPROOF_MAX_CONCURRENCY`: initial browser-slot capacity from 1 to 32; Console becomes authoritative after registration.
- `DEVPROOF_HEADLESS`: defaults to `true`; set to `false` to show a local browser window.

Pairing creates `runtime.json` with mode `0600`. Do not copy this file or include it in a machine image. Revoke the old credential and pair again when moving an installation.

## Network security

Chromium traffic, including loopback requests, passes through a local SSRF forward proxy. The proxy resolves and validates DNS before connecting to the same IP, covering navigation, redirects, subresources, and WebSockets while closing the DNS-rebinding window.

Runtime capacity and the exact private-network host allowlist are managed per registered Runtime in Console. An empty allowlist blocks private, loopback, link-local, metadata, unique-local, CGNAT, multicast, and reserved addresses. Browser commands do not provide arbitrary JavaScript, file upload, or file download; page-triggered downloads are cancelled.

## Evidence

Browser Runtime protocol v1.10 captures a screenshot after each successful navigation or interaction and composes the frames into a WebM action video when a Session closes. Screenshots and video are returned as Runtime Artifacts; API uploads them to the configured S3-compatible object store.

Protocol v1.11 adds structured locator recovery diagnostics. When a selector matches multiple elements, Runtime automatically accepts a unique visible candidate; otherwise it returns bounded candidate details and instructs the Agent to resnapshot and retarget without guessing.

Protocol v1.7 also supports open Shadow DOM capture and bounded, recursively redacted same-origin JSON response bodies when network evidence is narrowed by `urlIncludes`.

See [`docs/runtime-protocol.md`](../../docs/runtime-protocol.md) for compatibility rules and [`packages/runtime-protocol/README.md`](../../packages/runtime-protocol/README.md) for the canonical protocol changelog.

## User Profile retention

A user Profile directory includes `.devproof-user-profile.json` with only its kind, logical key, last-use time, and fixed retention policy. Browser Runtime scans at startup and hourly. A marked user Profile that has been inactive for at least 30 days and is not open is atomically renamed to a tombstone and deleted.

Lifecycle events persist locally and replay until acknowledged by the control plane. Unmarked legacy persistent directories and active Profiles are never removed by automatic retention. Network access remains governed by the Runtime-wide policy; a Profile does not carry its own network allowlist.

This cleanup runs inside `devproof-browser-runtime start`. It needs no cron job, and its 30-day limit cannot be increased through configuration. Restart Browser Runtime after upgrading so it can negotiate the latest supported protocol.

## Upgrade

Run the same release command again. Existing credentials, Browser Profiles,
configuration, and service state are retained:

```bash
curl -4 -fsSL https://github.com/ethanyu-dev/devproof/releases/latest/download/install.sh | bash
```

The installer refuses to switch packages while persisted sessions are active.
Use `bash -s -- --version MAJOR.MINOR.PATCH` to pin a release, or
`bash -s -- --force-active` only when session interruption is acceptable.
