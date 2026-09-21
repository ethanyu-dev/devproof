# @devproof/browser-runtime

Browser Runtime is DevProof's independently deployable Playwright execution host. Its control-plane WebSocket connection is outbound; optional direct browser access also uses an inbound listener behind a TLS proxy on the host or a private-network load balancer. Long-lived credentials and persistent Browser Profiles remain on the Runtime machine.

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

## Machine observability

With protocol v1.18 negotiated, Runtime samples host CPU and memory on each
15-second heartbeat. Console refreshes node resources and the server-side slot
pool every five seconds. CPU is an interval average across all logical cores;
Linux memory uses `MemAvailable` when readable. Daemon RSS is shown separately
from host usage, which includes Chromium and other processes. These are host
measurements, not container cgroup limits. The 1–32 concurrency setting remains a
configured admission limit, not a measured hardware capacity.

Upgrade and restart the Runtime to enable telemetry; existing pairing is retained.
See [machine observability](../../docs/runtime-machine-observability.md) for metric
definitions and capacity tuning.

## Network security

Chromium traffic, including loopback requests, passes through a local SSRF forward proxy. The proxy resolves and validates DNS before connecting to the same IP, covering navigation, redirects, subresources, and WebSockets while closing the DNS-rebinding window.

Runtime capacity and the exact private-network host allowlist are managed per registered Runtime in Console. An empty allowlist blocks private, loopback, link-local, metadata, unique-local, CGNAT, multicast, and reserved addresses. Browser commands do not provide arbitrary JavaScript, file upload, or file download; page-triggered downloads are cancelled.

## Evidence

Protocol v1.14 negotiates `closure-evidence-v1` explicitly on each connection.
Recovery close commands bind a persisted server challenge to the session lease,
fence, and optional launch identity. The Runtime durably revokes the session,
closes its browser and process scope, then fsyncs a closure tombstone before
returning proof. The `closure/` directory under `DEVPROOF_RUNTIME_HOME` retains
tombstones and an acknowledged command-result outbox; do not delete it as a
queue-unblocking measure. A new challenge can reuse a same-host tombstone after
reconnect or daemon restart. Host identity comes from the OS boot and process
namespace, while daemon identity lasts for the process, independent of reconnects.

Unknown legacy descriptors, copied state from another host, interrupted launches
without complete process identity, and unidentified process-group survivors
require operator recovery. Empty inventories and scanning an empty UUID marker
do not produce closure proof. Video finalization occurs after physical closure
in a separate, denied-network renderer with a 30-second budget; video or
diagnostic failure does not undo the saved closure proof.

Browser Runtime protocol v1.10 captures a screenshot after each successful navigation or interaction and composes the frames into a WebM action video when a Session closes. Screenshots and video are returned as Runtime Artifacts; API uploads them to the configured S3-compatible object store.

Step screenshots use JPEG quality 88, with the existing size-based fallback to
quality 45 for large images. Videos preserve the source aspect ratio up to
1280 × 720, with a target bitrate of 2.5 Mbps. If encoding fails or the video
exceeds the artifact size limit, the compatibility profile retries at up to
960 × 540 and 0.6 Mbps.

Interaction screenshots capture progress, including loading overlays and the
previous query's rows. The Agent labels them `AFTER_ACTION` and rejects their
use in `PASSED`/`FAILED` criterion results. After checking that the relevant
loading state has ended and the result has updated, the Agent must explicitly
observe with `page.snapshot` or `page.screenshot` and cite that new evidence.
An explicit observation is not a guarantee of application readiness: the
Agent still checks DOM and pixels, without assuming `domcontentloaded` means
an asynchronous query has finished. Process screenshots remain available for
playback and `INCONCLUSIVE` reports.

DOM snapshots cover the current viewport and account for scroll-container
clipping. Scrollable containers expose refs and `scrollY`/`scrollX` ranges,
including `atStart` and `atEnd`, so `page.scroll.target` can move the dropdown
instead of the background. A missing option in one viewport is insufficient
negative evidence; the Agent must complete a supported search or inspect the
whole range, including virtualized entries, before claiming absence. This
works with plain DOM and open Shadow DOM, including microfrontends with their
own `body`, without requiring ARIA or website instrumentation.

Protocol v1.11 adds structured locator recovery diagnostics. When a selector matches multiple elements, Runtime automatically accepts a unique visible candidate; otherwise it returns bounded candidate details and instructs the Agent to resnapshot and retarget without guessing.

Protocol v1.12 reports acknowledged `VIDEO_FINALIZATION_FAILED` events with the Runtime version, close command correlation, frame count, total duration, and bounded encoding-attempt summaries. Pending failure events are kept in a permission-restricted, 64-entry, 7-day local spool and replayed after reconnect or process restart until the control plane acknowledges them. Raw Runtime logs, screenshots, page content, and URLs are never included in these diagnostic events.

Protocol v1.7 also supports open Shadow DOM capture and bounded, recursively redacted business JSON response bodies from the page origin or explicitly allowlisted API hosts when network evidence is narrowed by `urlIncludes`.

See [`docs/runtime-protocol.md`](../../docs/runtime-protocol.md) for compatibility rules and [`packages/runtime-protocol/README.md`](../../packages/runtime-protocol/README.md) for the canonical protocol changelog.

## User Profile retention

A user Profile directory includes `.devproof-user-profile.json` with only its kind, logical key, last-use time, and fixed retention policy. Browser Runtime scans at startup and hourly. A marked user Profile that has been inactive for at least 30 days and is not open is atomically renamed to a tombstone and deleted.

Lifecycle events persist locally and replay until acknowledged by the control plane. Unmarked legacy persistent directories and active Profiles are never removed by automatic retention. Network access remains governed by the Runtime-wide policy; a Profile does not carry its own network allowlist.

This cleanup runs inside `devproof-browser-runtime start`. It needs no cron job, and its 30-day limit cannot be increased through configuration. Restart Browser Runtime after upgrading so it can negotiate the latest supported protocol.

## Upgrade

Version 0.2.31 captures fetch/XHR request and response JSON from explicitly allowlisted cross-origin business APIs. Authentication paths remain excluded; size limits and redaction apply to both bodies. Each omitted body reports a reason. Stable request IDs connect action feedback to later `page.network` reads without counting the same write twice.

Version 0.2.30 records bounded mutation locations and independently verifies
stable forms/dialogs/rows when the surrounding page changes. It checks captured
control values and geometry, rejects replaced nodes, and recaptures unstable
DOM/screenshot pairs at most twice without replaying the business action.
The optional `verifiedScopeNodeIds` field is backward compatible with structured
observation version 2. Upgrade and restart the installed Runtime for this fix.

Version 0.2.29 preserves the caret in screenshots so screenshot capture does
not itself invalidate paired DOM evidence. Structured observations report
bounded consistency diagnostics, and fallback field-label discovery supports
deeply wrapped controls while rejecting ambiguous multi-control containers.
Real document/state changes still invalidate a capture. Restart the installed
Runtime to load these changes; restarting the web/API development server alone
does not update it.

Run the same release command again. Existing credentials, Browser Profiles,
configuration, and service state are retained:

```bash
curl -4 -fsSL https://github.com/ethanyu-dev/devproof/releases/latest/download/install.sh | bash
```

The installer refuses to switch packages while persisted sessions are active.
Use `bash -s -- --version MAJOR.MINOR.PATCH` to pin a release, or
`bash -s -- --force-active` only when session interruption is acceptable.

### Runtime 0.2.21 recovery update

Deploy the API supporting protocol v1.15 before upgrading the Runtime. No database
migration is required. Existing nodes keep their negotiated protocol; historical
operator-required recoveries keep their guards until explicitly reviewed and retried.
Only new launch intents assigned to a v1.15 daemon support no-launch evidence.

Outgoing messages are schema-checked before delivery; command errors are redacted
and bounded to the wire limit so a long Playwright call log cannot poison the
reliable outbox. Commands wait for handshake reconciliation while cancellation
and heartbeats remain concurrent. Short-lived connections increase backoff; a
stable acknowledged connection resets it. Default page snapshots focus on an
active modal, and intercepted actions ask the Agent to take a fresh snapshot.

Automatic close paths share a six-attempt budget and preserve backoff and
`NEEDS_OPERATOR`. An explicit operator retry resets the budget with an audit event.
`INCONCLUSIVE` results and unsettled browser commands do not confirm business
writes or release their guards. Browser capacity remains an upper bound; unknown
business access still serializes execution within an environment.

### Runtime 0.2.22 DOM + visual observation

Protocol v1.16 advertises `dom-vision-v1`. `page.snapshot` and `frame.snapshot`
observe actual DOM nodes, including open Shadow DOM and frames, without relying
on ARIA snapshots or `aria-ref`. Snapshots include a viewport screenshot. Custom
controls can be operated by node reference or current screenshot coordinates;
`page.select` accepts only native `<select>`, and `page.type` can type into the
focused element when `target` is omitted.

Deploy the API with image delivery and capability-aware admission, then upgrade
Browser Runtime and Agent Runtime together before resuming verification work.
The Agent's configured model/gateway must accept Responses image inputs. Existing
sessions on older daemons require a fresh attempt after normal closure; upgrading
the API alone does not add visual input to an old Agent. No database migration is
required. See [DOM + visual observations](../../docs/dom-visual-browser.md).

### Runtime 0.2.23 observation and action feedback

DOM snapshots expose clipped scroll regions and distinguish active observations
from automatic post-action screenshots. Open Shadow DOM and frame observations
remain available without requiring ARIA or changes to the target website.

`action-feedback-v1` adds bounded fetch/XHR request candidates to action results
and subsequent observations. Request-start sequence and page identity exclude
older requests and other pages; temporal association is not proof of causality.
Same-origin JSON bodies reuse existing redaction and size limits. Pending,
omitted and truncated feedback remains explicit. Click targets and field-state
hashes support repetition detection without exposing field values in diagnostics.
No ARIA or target-site changes are required. See [account HITL and action feedback](../../docs/browser-runtime-data-and-feedback-plan.md)
for coordinated API, Agent and Browser Runtime rollout order.

### Runtime 0.2.24 microfrontend DOM references

Fixes references to connected nodes in microfrontends that virtualize
`ownerDocument` or `getRootNode`. Snapshot capture and reference lookup now use
the evaluating frame's registry and native DOM ancestry methods, so observed
controls remain clickable across these sandbox boundaries. A Chromium regression
test covers clicking and scoped snapshots in this configuration.

The Browser Runtime protocol remains v1.16. Upgrade each Runtime host to receive
this fix; deploying the API or Agent alone does not update the installed browser
package. The companion Agent change that stops exhausted locator recovery ships
separately in PR #62. See [browser reference recovery](../../docs/browser-reference-recovery.md).

## Direct control and distributed login state

Runtime 0.2.35 fixes direct configuration on existing systemd units that do not
load `browser-runtime.env`. With `--direct-config`, the installer adds a managed
`90-devproof-direct-access.conf` drop-in and reloads systemd before restart,
preserving the existing unit and other drop-ins (including headless overrides).
Upgrade failure restores the previous drop-in as well as the environment and
package. If 0.2.34 failed with `ECONNREFUSED <private-IP>:9444`, rerun the command
with `--direct-config` on 0.2.35; no manual unit edit is required.

Runtime 0.2.34 adds `--direct-config FILE` to the release installer. After this
release is published, new direct-access nodes can use one installation command
with a local JSON file. Already-configured nodes keep using the ordinary upgrade
command: it preserves `~/.config/devproof/browser-runtime.env`.

Create `direct-access.json` once, using the public Ed25519 key supplied by the API
operator (PEM newlines are JSON `\n` escapes):

```json
{
  "host": "10.1.80.119",
  "port": 9444,
  "origins": ["https://devproof.ethankit.com"],
  "publicKey": "-----BEGIN PUBLIC KEY-----\n<base64 public key>\n-----END PUBLIC KEY-----\n",
  "publicUrl": "wss://agent-browser-runtime.paigod.work/browser-control"
}
```

Use `127.0.0.1` for a VM-local reverse proxy. For an external load balancer, use
the VM's private IP and restrict port 9444 to that load balancer. The proxy
terminates TLS on 443 and forwards HTTP/WebSocket to 9444, preserving the exact
`/browser-control` path and Console Origin. These are operator-supplied values;
the installer does not infer network exposure or allocate domains/certificates.

```bash
curl -4 -fsSL https://github.com/ethanyu-dev/devproof/releases/latest/download/install.sh \
  | bash -s -- --direct-config "$HOME/direct-access.json"
```

The installer validates the configuration before stopping the old service,
merges only the four direct-control variables, keeps unrelated settings and a
private backup, and restores the old configuration/package on upgrade failure.
On a paired node it checks the local WebSocket upgrade after startup and prints
the Runtime ID → public WSS URL entry to merge into the API's
`BROWSER_DIRECT_ENDPOINTS_JSON`. It does not activate that mapping automatically.
First-time nodes still require Console pairing before their listener starts.

The API signing **private** key stays on the API. Do not place it in the JSON or
on a Runtime. Public DNS, TLS and authenticated frame/input/renewal checks must
pass before enabling the API mapping; a local listener check does not establish
public reachability. Direct connection failures do not automatically use relay.
The listener returns 404 for ordinary HTTP requests, so a load balancer expecting
HTTP 200 needs a compatible health check or a separate proxy health endpoint.

For SSH-based deployment, the same `--direct-config FILE` option uploads and
applies configuration to one target at a time. Omit the option on subsequent
upgrades to preserve the existing settings.

Version 0.2.32 adds optional direct WSS human control and encrypted login snapshots
for multiple execution nodes. Both are disabled until configured. See the
[rollout guide](../../docs/browser-direct-access-and-snapshots.md) for VM-local TLS,
API signing keys, node snapshot keys, supported sites and rollback.

Version 0.2.33 adds read-only direct Run previews (`direct-preview-v1`). Scoped
preview tickets stream frames without granting input or replacing the active
human controller. Multiple viewers can connect simultaneously. Existing direct
control keys and WSS endpoints are reused; older nodes retain SSE relay until
upgraded. See the rollout guide above for deployment prerequisites.
